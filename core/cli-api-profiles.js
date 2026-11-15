'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const KINDS = new Set(['claude', 'codex']);
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const baseKind = kind => String(kind || '').replace(/-resume$/, '');

function profiles(raw, kind) {
  const list = raw.providers?.[baseKind(kind)]?.api_profiles;
  return Array.isArray(list) ? list : [];
}
function publicProfiles(raw, kind) {
  return profiles(raw, kind).map(({ id, label, baseURL, model, wireApi, apiKey }) =>
    ({ id, label, baseURL, model, wireApi, apiKeySet: !!apiKey }));
}
function withProfile(raw, request) {
  const kind = baseKind(request.kind);
  if (!KINDS.has(kind)) throw new Error('只有 Claude Code 和 Codex 支持多组自有 API');
  const api = require('./company-api-config');
  const provider = raw.providers?.[kind] || {};
  const list = [...profiles(raw, kind)];
  if (!list.length && request.profileAction === 'save' && !request.profileId) {
    const legacy = provider.backend === 'proxy' ? provider.own_api : provider.backend === 'api' ? provider : null;
    if (legacy && (legacy.base_url || legacy.api_key || legacy.model)) list.push({
      id: crypto.randomUUID(), label: '原有接口', baseURL: legacy.base_url || '', apiKey: legacy.api_key || '', model: legacy.model || '',
      ...(kind === 'codex' ? { wireApi: legacy.wire_api || 'responses' } : {}),
    });
  }
  const id = request.profileId || (request.profileAction === 'save' ? crypto.randomUUID() : '');
  if (!ID.test(id)) throw new Error('API 账号编号无效');
  const index = list.findIndex(item => item.id === id);
  if (request.profileAction !== 'save' && index < 0) throw new Error('API 账号不存在');
  if (request.profileId && request.profileAction === 'save' && index < 0) throw new Error('API 账号不存在');
  if (request.profileAction === 'save') {
    const previous = list[index] || {};
    const label = api.optionalText(request.label, '账号名称');
    if (!label || label.length > 80) throw new Error('请填写 1–80 字的账号名称');
    const apiKey = api.optionalText(request.apiKey || previous.apiKey, 'API Key');
    if (!apiKey) throw new Error('请填写 API Key');
    const model = api.optionalText(request.model, '模型名称');
    if (!require('./local-cli-models').isLocalCliModelId(model)) throw new Error('请填写有效的模型名称');
    const next = { id, label, baseURL: api.baseUrl(request.baseURL), apiKey, model,
      ...(kind === 'codex' ? { wireApi: api.wireApi(request.wireApi || previous.wireApi || 'responses') } : {}) };
    if (index < 0) list.push(next); else list[index] = next;
  } else if (request.profileAction !== 'select') throw new Error('API 账号操作无效');
  const selected = list.find(item => item.id === id);
  const { own_api, ...rest } = provider;
  return { ...raw, providers: { ...raw.providers, [kind]: { ...rest, api_profiles: list,
    selected_api_profile: id, backend: 'api', base_url: selected.baseURL, api_key: selected.apiKey,
    model: selected.model, ...(kind === 'codex' ? { wire_api: selected.wireApi } : {}) } } };
}

function metadata(session) {
  return session?.cliApiProfileId ? { cliApiProfileId: session.cliApiProfileId,
    cliApiProfileLabel: session.cliApiProfileLabel || '', cliApiRevision: session.cliApiRevision } : {};
}
function readConnection(kind, session, dataDir) {
  kind = baseKind(kind);
  if (!KINDS.has(kind) || !ID.test(session.cliApiProfileId || '') || !/^[a-f0-9]{64}$/.test(session.cliApiRevision || ''))
    throw new Error('API 账号版本无效');
  let profile;
  try { profile = JSON.parse(fs.readFileSync(path.join(dataDir, 'cli-api-profiles', kind,
    session.cliApiProfileId, session.cliApiRevision, 'connection.json'), 'utf8')); }
  catch { throw new Error('此会话的 API 账号配置不可读，未切换到其他账号'); }
  if (profile.id !== session.cliApiProfileId || profile.kind !== kind) throw new Error('此会话的 API 账号归属不一致');
  return profile;
}
function prepareLaunch(kind, opts, { raw, dataDir, values }) {
  kind = baseKind(kind);
  if (!KINDS.has(kind)) return null;
  const provider = raw.providers?.[kind] || {};
  const restoring = opts.useResume || opts.resumeCCSessionId || opts.forkCCSessionId || opts.codexSid || opts.codexForkSid;
  const id = opts.cliApiProfileId || (!restoring && provider.backend === 'api' ? provider.selected_api_profile : '');
  if (!id) return null;
  if (!ID.test(id)) throw new Error('API 账号编号无效');
  let profile, revision = opts.cliApiRevision;
  const root = path.join(dataDir, 'cli-api-profiles', kind, id);
  if (revision) {
    profile = readConnection(kind, { cliApiProfileId: id, cliApiRevision: revision }, dataDir);
  } else {
    profile = profiles(raw, kind).find(item => item.id === id);
    if (!profile) throw new Error('API 账号已不存在，未切换到其他账号');
    profile = { ...profile, kind };
    revision = crypto.createHash('sha256').update(JSON.stringify(profile)).digest('hex');
  }
  const home = path.join(root, revision);
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'connection.json');
  if (!fs.existsSync(file)) require('./atomic-write').writeFileAtomic(fs, file, JSON.stringify(profile));
  const prefix = kind.toUpperCase();
  return { home, profile, meta: { cliApiProfileId: id, cliApiProfileLabel: profile.label, cliApiRevision: revision },
    values: { ...values, COMPANY_CLI: true, [prefix + '_BACKEND']: 'api', [prefix + '_API_BASE_URL']: profile.baseURL,
      [prefix + '_API_KEY']: profile.apiKey, [prefix + '_API_MODEL']: profile.model,
      ...(kind === 'codex' ? { CODEX_API_WIRE_API: profile.wireApi, CODEX_API_PROVIDER: 'hub-api', CODEX_API_HOME: home } : {}) } };
}

module.exports = { profiles, publicProfiles, withProfile, prepareLaunch, metadata, readConnection };
