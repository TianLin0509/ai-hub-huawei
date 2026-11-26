'use strict';

// 员工助手（WeClaw Desktop，agent 内核是 opencode）接入 HUB-H 公司模型（2026-11-26）。
// 员工助手自带「自定义模型」：本机服务 3008 端口有官方配置接口，无鉴权；这里经它合入一个模型来源，
// 指向 HUB-H 本机反代（127.0.0.1），数据只在本机与公司 CodeAgent 之间流动，不改员工助手的程序文件。
// 员工助手 7.9 起本机服务只听 IPv6 的 ::1，所以先试 localhost / [::1]，再试 127.0.0.1。
const fs = require('node:fs');
const path = require('node:path');

const PROVIDER_ID = 'myprovider_hubh';
const PROVIDER_NAME = 'AI HUB-H（CodeAgent 公司模型）';
const AGENT_PORTS = [3008, 8003];
const AGENT_HOSTS = ['localhost', '[::1]', '127.0.0.1'];
const MODELS_PATH = '/v1/config/opencode/global/models';
const STATE_FILE = 'weclaw-link.json';
// 会话标识：员工助手整体算一个会话；默认固定本人账号，不占号池里同事的账号。
const SESSION_TAG = 'weclaw';
const PIN_PERSONAL = '__pin_personal';

function installPaths(env = process.env) {
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  return roots.map(root => path.join(root, 'UniAssistant', 'WeClaw Desktop.exe'));
}
function findInstall({ env = process.env, exists = fs.existsSync } = {}) {
  return installPaths(env).find(file => { try { return exists(file); } catch { return false; } }) || '';
}

function statePath(dataDir) { return path.join(dataDir, STATE_FILE); }
function readState(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(dataDir), 'utf8'));
    return { enabled: raw.enabled === true, allowPool: raw.allowPool === true, port: Number(raw.port) || 0,
      appliedAt: Number(raw.appliedAt) || 0, models: Array.isArray(raw.models) ? raw.models.filter(m => typeof m === 'string') : [],
      pendingRemove: raw.pendingRemove === true };
  } catch { return { enabled: false, allowPool: false, port: 0, appliedAt: 0, models: [], pendingRemove: false }; }
}
function writeState(dataDir, state) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = statePath(dataDir), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function apiKey(masterKey, allowPool) { return `${masterKey}.${SESSION_TAG}${allowPool ? '' : PIN_PERSONAL}`; }

/** 员工助手配置里的模型表：id → 显示名、上下文、是否推理。 */
function providerModels(models) {
  const out = {};
  for (const m of models || []) {
    if (!m || !m.id || out[m.id]) continue;
    out[m.id] = { name: `HUB-H · ${m.label || m.id}`, tool_call: true, reasoning: !!m.thinking,
      limit: { context: m.contextWindow > 0 ? m.contextWindow : 200000, output: m.output > 0 ? m.output : 32768 },
      modalities: { input: ['text'], output: ['text'] } };
  }
  return out;
}
function buildProvider({ port, key, models, allowPool = false }) {
  if (!(port > 0) || !key) throw new Error('HUB-H 公司模型代理还没准备好');
  return { [PROVIDER_ID]: { name: PROVIDER_NAME, npm: '@ai-sdk/openai-compatible',
    options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: apiKey(key, allowPool), modelOrigin: 'internal', timeout: 600000, chunkTimeout: 180000 },
    models: providerModels(models) } };
}

async function request(fetchImpl, url, { method = 'GET', body, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchImpl(url, { method, signal: controller.signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) }) });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 回复 */ }
    if (!res.ok) throw new Error(`员工助手返回 HTTP ${res.status}${json?.error ? `：${json.error}` : ''}`);
    return json;
  } finally { clearTimeout(timer); }
}

/** 找员工助手本机服务；没开就返回空串。 */
async function findAgentBase(fetchImpl = fetch, { hint = '' } = {}) {
  const candidates = [];
  if (hint) candidates.push(hint);
  for (const port of AGENT_PORTS) for (const host of AGENT_HOSTS) candidates.push(`http://${host}:${port}`);
  for (const base of [...new Set(candidates)]) {
    try { await request(fetchImpl, base + MODELS_PATH, { timeoutMs: 2500 }); return base; } catch { /* 试下一个 */ }
  }
  return '';
}

/** 员工助手当前生效的模型清单里，HUB-H 这一条的情况。 */
function describeLinked(models) {
  const list = Array.isArray(models?.providers) ? models.providers : [];
  const mine = list.find(p => p && p.id === PROVIDER_ID);
  if (!mine) return { present: false, port: 0, models: [] };
  const match = /:(\d+)\/v1\/?$/.exec(String(mine.options?.baseURL || ''));
  return { present: true, port: match ? Number(match[1]) : 0, models: Object.keys(mine.models || {}),
    pinned: String(mine.options?.apiKey || '').endsWith(PIN_PERSONAL) };
}

async function readLinked(fetchImpl, base) { return describeLinked(await request(fetchImpl, base + MODELS_PATH)); }
/** 主进程内部用：员工助手里 HUB-H 这一条的原始配置（含钥匙，不要送到页面）。 */
async function readProvider(fetchImpl, base) {
  const models = await request(fetchImpl, base + MODELS_PATH);
  return (Array.isArray(models?.providers) ? models.providers : []).find(p => p && p.id === PROVIDER_ID) || null;
}
/** 员工助手里的这一条和应写入的是否一致：地址、钥匙、模型清单都对上才算（云端同步来的别机配置、钥匙重建都会对不上）。 */
function matchesExpected(actual, expected) {
  if (!actual || !expected) return false;
  // 模型比 id、显示名和上下文/输出上限（员工助手读回的格式里这几项与写入一致）。
  const ids = value => Object.entries(value || {}).map(([id, m]) => [id, m?.name || '', m?.limit?.context || 0, m?.limit?.output || 0].join('|')).sort().join(',');
  return String(actual.options?.baseURL || '') === expected.options.baseURL && String(actual.options?.apiKey || '') === expected.options.apiKey
    && ids(actual.models) === ids(expected.models);
}
async function applyProvider(fetchImpl, base, provider) {
  return request(fetchImpl, base + MODELS_PATH + '/provider', { method: 'PUT', body: provider, timeoutMs: 15000 });
}
async function toggleProvider(fetchImpl, base, enabled) {
  return request(fetchImpl, base + MODELS_PATH + '/provider-toggle', { method: 'POST', body: { providerId: PROVIDER_ID, enabled }, timeoutMs: 10000 });
}
async function removeProvider(fetchImpl, base) {
  return request(fetchImpl, `${base}${MODELS_PATH}/provider/${encodeURIComponent(PROVIDER_ID)}`, { method: 'DELETE', timeoutMs: 10000 });
}

// ---------------------------------------------------------------- 第二版（四步清单）：模型清单、版本、在线、跳转、试一次

/** 员工助手的整份模型清单拆成：HUB-H 这一条（原始，含钥匙，只在主进程用）和其他来源的显示名（给页面画下拉预览）。 */
async function readModels(fetchImpl, base) {
  const all = await request(fetchImpl, base + MODELS_PATH);
  const list = Array.isArray(all?.providers) ? all.providers : [];
  const mine = list.find(p => p && p.id === PROVIDER_ID) || null;
  const names = p => Object.entries(p?.models || {}).map(([id, m]) => String(m?.name || id)).slice(0, 8);
  return { mine, mineNames: names(mine), others: list.filter(p => p && p.id !== PROVIDER_ID).map(p => ({ name: String(p.name || p.id), models: names(p) })) };
}

/** 员工助手本机自检接口：服务正常、是否已登录（只返回布尔值，不带账号）。 */
async function readHealth(fetchImpl, base) {
  try {
    const h = await request(fetchImpl, base + '/v1/health', { timeoutMs: 3000 });
    return { healthy: h?.status === 'ok', loggedIn: !!(h && typeof h.userId === 'string' && h.userId.trim()) };
  } catch { return { healthy: false, loggedIn: false }; }
}

/** 版本号比较：7.11.100-1130 → [7, 11, 100, 1130]，逐段比数字。 */
function versionParts(v) { return String(v || '').split(/[.\-_]/).map(x => Number.parseInt(x, 10)).filter(Number.isFinite); }
function compareVersions(a, b) {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
function upgradeCacheDir(env = process.env) { return env.APPDATA ? path.join(env.APPDATA, 'weclaw-desktop', 'upgrade-cache') : ''; }
/** 员工助手自己下载好的新版安装包（upgrade-cache 里版本号最高的那个）。 */
function findDownloadedInstaller({ env = process.env, readdir = fs.readdirSync } = {}) {
  const dir = upgradeCacheDir(env);
  if (!dir) return null;
  let best = null;
  try {
    for (const name of readdir(dir)) {
      const m = /^WeclawDesktop_Setup_([0-9][0-9.\-]*[0-9])\.exe$/i.exec(name);
      if (m && (!best || compareVersions(m[1], best.version) > 0)) best = { version: m[1], file: path.join(dir, name) };
    }
  } catch { /* 没有缓存目录 */ }
  return best;
}
/** 已装版本：读卸载登记里 UniAssistant 的 DisplayVersion（reg.exe，隐藏窗口）。 */
function readInstalledVersion({ execFile = require('node:child_process').execFile } = {}) {
  const keys = ['HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\UniAssistant',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\UniAssistant', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\UniAssistant'];
  const one = key => new Promise(resolve => {
    try {
      execFile('reg', ['query', key, '/v', 'DisplayVersion'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
        const m = !error && /DisplayVersion\s+REG_SZ\s+(\S+)/.exec(String(stdout || ''));
        resolve(m ? m[1] : '');
      });
    } catch { resolve(''); }
  });
  return keys.reduce((p, key) => p.then(found => found || one(key)), Promise.resolve(''));
}

/** 「试一次」：按员工助手同样的方式（OpenAI 兼容、流式）经 HUB-H 代理发一句话，量首字和总耗时。 */
async function probeModel({ fetchImpl = fetch, port, key, model, now = () => Date.now(), timeoutMs = 60000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const t0 = now();
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, stream: true, max_tokens: 16, messages: [{ role: 'user', content: '只回复两个字：收到' }] }) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let reason = text; try { reason = JSON.parse(text)?.error?.message || text; } catch { /* 不是 JSON 就原样给 */ }
      throw new Error(String(reason || `HUB-H 代理返回 HTTP ${res.status}`).split(/\r?\n/)[0].slice(0, 120));
    }
    let first = -1, reply = '', buf = '';
    const decoder = new TextDecoder();
    let done = false;
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (/^data:\s*\[DONE\]$/.test(line)) { done = true; break; }
        if (!line.startsWith('data:')) continue;
        try {
          const delta = JSON.parse(line.slice(5)).choices?.[0]?.delta || {};
          const piece = delta.content || delta.reasoning_content || '';
          if (piece && first < 0) first = now() - t0;
          reply += delta.content || '';
        } catch { /* 心跳或非 JSON 行 */ }
      }
      if (done) break; // 收到结束标记就不再等连接关闭（for await 的 break 会关掉响应体）
    }
    return { ok: first >= 0, firstTokenMs: Math.max(0, first), totalMs: now() - t0, model, reply: reply.trim().slice(0, 40) };
  } catch (error) {
    return { ok: false, model, totalMs: now() - t0, error: error.name === 'AbortError' ? `超过 ${Math.round(timeoutMs / 1000)} 秒没有回应` : error.message };
  } finally { clearTimeout(timer); }
}

module.exports = { PROVIDER_ID, PROVIDER_NAME, PIN_PERSONAL, installPaths, findInstall, readState, writeState, statePath,
  apiKey, providerModels, buildProvider, findAgentBase, describeLinked, readLinked, readProvider, matchesExpected, applyProvider, toggleProvider, removeProvider,
  readModels, readHealth, compareVersions, upgradeCacheDir, findDownloadedInstaller, readInstalledVersion, probeModel };
