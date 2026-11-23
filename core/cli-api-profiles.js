'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const secrets = require('./own-api-secrets');
const KINDS = new Set(['claude', 'codex']);
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const baseKind = kind => String(kind || '').replace(/-resume$/, '');
const providerKey = profile => ({ api_key: profile.apiKey || '', ...(profile.apiKeyNeedsInput
  ? { encrypted_api_key: profile.encryptedApiKey, api_keyNeedsInput: true } : {}) });

function profiles(raw, kind) {
  const list = raw.providers?.[baseKind(kind)]?.api_profiles;
  return Array.isArray(list) ? list : [];
}
function publicProfiles(raw, kind) {
  return profiles(raw, kind).map(({ id, label, baseURL, model, wireApi, apiKey, apiKeyNeedsInput }) =>
    ({ id, label, baseURL, model, wireApi, apiKeySet: !!apiKey, ...(apiKeyNeedsInput ? { apiKeyNeedsInput: true } : {}) }));
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
      ...(legacy.api_keyNeedsInput ? { apiKeyNeedsInput: true, encryptedApiKey: legacy.encrypted_api_key } : {}),
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
  } else if (request.profileAction === 'delete') {
    // 删除（2026-11-20，群诉求：自有 API 只能加不能删）：已开的会话用的是启动时落盘的那一版，不受影响。
    // 删的是当前选中的：改选剩下的第一个；一个不剩就回到「沿用本机配置」。
    list.splice(index, 1);
    const { own_api, encrypted_api_key, api_keyNeedsInput, ...rest } = provider;
    const wasSelected = provider.selected_api_profile === id;
    const next = wasSelected ? list[0] : list.find(item => item.id === provider.selected_api_profile);
    // 没删到正在用的，或这个工具此刻走公司模型 / API 网关：只改列表，不动当前线路。
    // 走公司模型 / 网关时留着的「切回用的自有接口」若正是被删的账号，一并换掉（Codex 审查 P2：删了还能切回去用）。
    if (!wasSelected || provider.backend !== 'api') {
      const removed = profiles(raw, kind)[index];
      const stash = provider.own_api;
      const stale = stash && removed && stash.base_url === removed.baseURL && stash.api_key === removed.apiKey && stash.model === removed.model;
      const { own_api: _stale, ...kept } = provider;
      const fresh = stale && wasSelected && list[0] ? { own_api: { base_url: list[0].baseURL, ...providerKey(list[0]), model: list[0].model,
        ...(kind === 'codex' ? { wire_api: list[0].wireApi } : {}) } } : {};
      return { ...raw, providers: { ...raw.providers, [kind]: { ...(stale ? { ...kept, ...fresh } : provider), api_profiles: list,
        selected_api_profile: wasSelected ? (stale && list[0] ? list[0].id : '') : provider.selected_api_profile || '' } } };
    }
    if (!next) return { ...raw, providers: { ...raw.providers, [kind]: { ...rest, api_profiles: list, selected_api_profile: '',
      backend: 'api', base_url: '', api_key: '', model: '', ...(kind === 'codex' ? { wire_api: 'responses' } : {}) } } };
    return { ...raw, providers: { ...raw.providers, [kind]: { ...rest, api_profiles: list, selected_api_profile: next.id, backend: 'api',
      base_url: next.baseURL, ...providerKey(next), model: next.model, ...(kind === 'codex' ? { wire_api: next.wireApi } : {}) } } };
  } else if (request.profileAction !== 'select') throw new Error('API 账号操作无效');
  const selected = list.find(item => item.id === id);
  secrets.assertReadable(selected);
  const { own_api, encrypted_api_key, api_keyNeedsInput, ...rest } = provider;
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
  const hadPlaintext = Object.hasOwn(profile, 'apiKey');
  profile = secrets.openSecret(profile);
  let repaired = false;
  if (profile.apiKeyNeedsInput) {
    // 换机后补填的 Key 只修复同编号、同地址的旧快照，绝不借用当前选中的其他账号。
    const current = profiles(require('./hub-config').readConfigJsonForUpdate(), kind).find(p => p.id === profile.id);
    if (current?.apiKey && !current.apiKeyNeedsInput && current.baseURL === profile.baseURL) {
      profile = { ...profile, apiKey: current.apiKey };
      delete profile.apiKeyNeedsInput;
      delete profile.encryptedApiKey;
      repaired = true;
    }
  }
  secrets.assertReadable(profile);
  // 旧快照按需迁移，版本目录继续使用原来的标识，不让随机密文改变会话归属。
  const file = path.join(dataDir, 'cli-api-profiles', kind, session.cliApiProfileId, session.cliApiRevision, 'connection.json');
  if (repaired || hadPlaintext) {
    // 迁移是尽力写回：旧文件已读出有效 Key 时，加密暂不可用或写盘失败不妨碍恢复旧会话。
    // 保留原文件，下次读取再迁移；此处绝不把新明文写回磁盘。
    try { require('./atomic-write').writeFileAtomic(fs, file, JSON.stringify(secrets.sealSecret(profile))); }
    catch { /* 内存中的账号与 Key 已校验，继续使用这一份 */ }
  }
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
    secrets.assertReadable(profile);
    // 固定逻辑字段顺序，与旧版本一致；加解密会改变对象插入顺序，不能因此另起会话版本。
    profile = { id: profile.id, label: profile.label, baseURL: profile.baseURL, apiKey: profile.apiKey,
      model: profile.model, ...(kind === 'codex' ? { wireApi: profile.wireApi } : {}), kind };
    revision = crypto.createHash('sha256').update(JSON.stringify(profile)).digest('hex');
  }
  const home = path.join(root, revision);
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'connection.json');
  if (!fs.existsSync(file)) {
    let sealed;
    try { sealed = secrets.sealSecret(profile); }
    catch { throw new Error('系统密钥加密不可用，已停止创建会话。请重新打开 Hub 后重试；仍失败请反馈此提示。'); }
    try { require('./atomic-write').writeFileAtomic(fs, file, JSON.stringify(sealed)); }
    catch { throw new Error('会话配置未能安全保存，已停止创建会话。请检查 Hub 数据目录是否可写后重试。'); }
  } else if (!opts.cliApiRevision) readConnection(kind, { cliApiProfileId: id, cliApiRevision: revision }, dataDir);
  const prefix = kind.toUpperCase();
  return { home, profile, meta: { cliApiProfileId: id, cliApiProfileLabel: profile.label, cliApiRevision: revision },
    values: { ...values, COMPANY_CLI: true, [prefix + '_BACKEND']: 'api', [prefix + '_API_BASE_URL']: profile.baseURL,
      [prefix + '_API_KEY']: profile.apiKey, [prefix + '_API_MODEL']: profile.model,
      ...(kind === 'codex' ? { CODEX_API_WIRE_API: profile.wireApi, CODEX_API_PROVIDER: 'hub-api', CODEX_API_HOME: home } : {}) } };
}

module.exports = { profiles, publicProfiles, withProfile, prepareLaunch, metadata, readConnection };
