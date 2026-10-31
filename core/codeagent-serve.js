'use strict';
// 用 CodeAgent 自带的 serve 后台服务读账号的模型清单和额度（2026-10-30 用户：比开 CodeAgent 读 /model 屏幕更准更快）。
//
// 公司真机实测（Q-1030-02 / Q-1030-03，CodeAgent 1.2615.02.03）：
// - 参数只认 --host / --port / --token / --config-dir；token 由调用方给，接口都要 `Authorization: Bearer <token>`（不带一律 401）。
// - 已在跑的会话自带 serve 用的是它自己的 token，外部拿不到，所以不复用，按需临时起一个。
// - 临时起一个约 2.7 秒就绪，进程树约 470–550 MB（一个 serve 常驻要占这么多，所以用完就关，不常驻）。
// - 没有可用的关闭接口（/api/v1/server/shutdown 是 404），用完按进程树结束；万一 bun 打包的进程脱离父进程，再按端口结束。
// - 模型清单和账号额度：GET /api/v2/config/providers；单个模型的分钟 / 小时 / 天配额：GET /api/v2/model/<模型>/quota。
// 失败一律返回 { ok:false, error }，调用方回落到读 /model 屏幕（core/codeagent-model-probe.js）。
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const HEALTH_PATH = '/api/v1/global/health';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

// 只连本机回环地址：http 模块不走系统代理，公司代理拦不到。
function request(port, token, pathname, { timeoutMs = 8000, method = 'GET' } = {}) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, timeout: timeoutMs,
      headers: token ? { Authorization: `Bearer ${token}` } : {} }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', error => resolve({ status: 0, error: error.message }));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', error => resolve({ status: 0, error: error.message }));
    req.end();
  });
}

// 公司真机（Q-1030-03 第 3 轮）：健康检查通过后紧接着的第一个请求偶尔连不上（返回空），隔一会儿再请求就好；
// 连接层失败（没有状态码）重试两次，有状态码的（401、404 等）照实返回。
async function getJson(port, token, pathname, { retries = 2, retryDelayMs = 800, ...options } = {}) {
  let res = await request(port, token, pathname, options);
  for (let attempt = 0; attempt < retries && !res.status; attempt += 1) {
    await new Promise(r => setTimeout(r, retryDelayMs));
    res = await request(port, token, pathname, options);
  }
  if (res.status !== 200) return { ok: false, status: res.status, error: res.error || `HTTP ${res.status}` };
  try { return { ok: true, data: JSON.parse(res.body) }; } catch { return { ok: false, status: res.status, error: '返回的不是 JSON' }; }
}

function run(file, args) {
  return new Promise(resolve => execFile(file, args, { windowsHide: true, timeout: 10000 }, (error, stdout) => resolve({ error, stdout: String(stdout || '') })));
}

async function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') await run('taskkill', ['/T', '/F', '/PID', String(pid)]);
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* 已经退出 */ } }
}

async function portOwner(port) {
  if (process.platform !== 'win32') return null;
  const { stdout } = await run('netstat', ['-ano', '-p', 'TCP']);
  const line = stdout.split(/\r?\n/).find(l => new RegExp(`127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING\\s+\\d+`, 'i').test(l));
  const pid = line && Number(line.trim().split(/\s+/).pop());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function serveEnv(env, { configDirEnv, configDir }) {
  const childEnv = { ...env };
  require('./codeagent-launch-env').applyAccountEnv(childEnv, { configDirEnv, configDir });
  // 不让这个临时进程的 hook 冒充 Hub 会话（同 codeagent-model-probe.js）
  for (const key of Object.keys(childEnv)) if (/^CLAUDE_HUB_(?:SESSION_ID|PORT|TOKEN)$|^CODEAGENT_HUB_/.test(key)) delete childEnv[key];
  return childEnv;
}

function spawnServe({ command, port, token, configDir, cwd, env }) {
  const head = /^[A-Za-z0-9_.-]+$/.test(command) ? command : `"${path.normalize(String(command).replace(/"/g, ''))}"`;
  const args = `serve --host 127.0.0.1 --port ${port} --token ${token} --config-dir "${String(configDir).replace(/"/g, '')}"`;
  // 走 cmd 的 call：codeagent.cmd / .bat 包装会设证书和代理（和手动敲 codeagent serve 一致）。windowsHide：不弹任何窗口。
  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/d', '/s', '/c', `"call ${head} ${args}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' });
  }
  return spawn('/bin/sh', ['-c', `${head} ${args}`], { cwd, env, stdio: 'ignore', detached: false });
}

// 同一时间只起一个临时 serve：公司电脑内存紧，一个就占约 0.5 GB。
let chain = Promise.resolve();

function withTempServe(options, fn) {
  const task = () => runTempServe(options, fn);
  const next = chain.then(task, task);
  chain = next.catch(() => {});
  return next;
}

async function runTempServe({ command, configDirEnv, configDir, cwd, env = process.env, readyTimeoutMs = 30000, spawnImpl = spawnServe } = {}, fn) {
  if (!command || !configDir) return { ok: false, error: '缺少 CodeAgent 命令或配置目录' };
  const started = Date.now();
  const port = await freePort();
  const token = crypto.randomBytes(32).toString('hex');
  let proc;
  // 工作目录不存在时 spawn 直接报 ENOENT（新装 Hub 的 probe-cwd 还没建过；读屏那条路会先建）
  try { fs.mkdirSync(cwd || configDir, { recursive: true }); } catch { /* 交给 spawn 报错 */ }
  try { proc = spawnImpl({ command, port, token, configDir, cwd: cwd || configDir, env: serveEnv(env, { configDirEnv, configDir }) }); }
  catch (error) { return { ok: false, error: `启动 CodeAgent serve 失败：${error.message}` }; }
  let exited = false, exitCode = null, spawnError = '';
  const exitPromise = new Promise(resolve => {
    proc.once('exit', code => { exited = true; exitCode = code; resolve(); });
    proc.once('error', error => { exited = true; spawnError = (error && error.message) || String(error); resolve(); });
  });
  try {
    let ready = false;
    while (Date.now() - started < readyTimeoutMs && !exited) {
      const res = await request(port, token, HEALTH_PATH, { timeoutMs: 2000 });
      if (res.status && res.status < 500) { ready = true; break; }
      await new Promise(r => setTimeout(r, 300));
    }
    if (!ready) return { ok: false, error: exited ? (spawnError ? `启动 CodeAgent serve 失败：${spawnError}` : `CodeAgent serve 启动后退出了（退出码 ${exitCode}）`) : 'CodeAgent serve 没有按时就绪' };
    const readyMs = Date.now() - started;
    const result = await fn({ port, get: (pathname, opts) => getJson(port, token, pathname, opts) });
    return { ...result, readyMs };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  } finally {
    if (!exited) {
      await killTree(proc.pid);
      await Promise.race([exitPromise, new Promise(r => setTimeout(r, 5000))]);
    }
    const owner = await portOwner(port);
    if (owner) await killTree(owner);
  }
}

// ---------------------------------------------------------------- 返回值解析
// 字段按公司真机 1.2615.02.03 个人账号实测（Q-1030-07）：
// /api/v2/config/providers → { providers:[{ id:'w3', status, models:{ <模型>:{ id, display_name, max_context_tokens,
//   originCoefficient:'0x', idleCoefficient, isIdle, load } } }], busyIdleDefinition:{ discount_status:'闲时2折进行中' },
//   creditUsage:{ quotas:[{ type:'CPM'|'CPD_Peak'|'CPD_Valley', used, total, remaining, usageRatio, resetAt }] } }
// /api/v2/model/<模型>/quota → { quotas:[{ type:'TPD'|'TPH'|'TPM', used_quota:'0', total_quota:'400000000', remaining_quota, reset_at }] }
// 或 null（模型名大小写不对时，要用清单里的 id）。
const num = value => { const n = Number(value); return Number.isFinite(n) ? n : null; };
const text = value => (typeof value === 'string' ? value.trim() : '');

function parseProviders(data) {
  const models = [];
  for (const provider of Array.isArray(data && data.providers) ? data.providers : []) {
    if (provider && provider.status && provider.status !== 'available') continue;
    const map = provider && provider.models && typeof provider.models === 'object' ? provider.models : {};
    for (const [key, info] of Object.entries(map)) {
      const id = text(info && info.id) || text(key);
      if (!id || id === 'default' || models.some(m => m.id.toLowerCase() === id.toLowerCase())) continue;
      models.push({ id, label: text(info && info.display_name) || id, provider: text(provider.id),
        contextWindow: num(info && info.max_context_tokens), coefficient: text(info && info.originCoefficient),
        idleCoefficient: text(info && info.idleCoefficient), isIdle: info && typeof info.isIdle === 'boolean' ? info.isIdle : null,
        load: text(info && info.load) });
    }
  }
  const credit = (Array.isArray(data && data.creditUsage && data.creditUsage.quotas) ? data.creditUsage.quotas : [])
    .map(q => ({ type: text(q && q.type), used: num(q && q.used), total: num(q && q.total), remaining: num(q && q.remaining), resetAt: text(q && q.resetAt) }))
    .filter(q => q.type && q.total !== null);
  return { models, credit, discount: text(data && data.busyIdleDefinition && data.busyIdleDefinition.discount_status) };
}

function parseQuota(data) {
  return (Array.isArray(data && data.quotas) ? data.quotas : [])
    .map(q => ({ type: text(q && q.type), used: num(q && q.used_quota), total: num(q && q.total_quota), resetAt: text(q && q.reset_at) }))
    .filter(q => q.type && q.total !== null);
}

// 读一个账号：模型清单 + 账号额度 + 每个模型的配额。models 为空当失败（调用方回落读屏）。
async function readAccount(options) {
  return withTempServe(options, async ({ get }) => {
    const providers = await get('/api/v2/config/providers');
    if (!providers.ok) return { ok: false, error: `读模型清单失败：${providers.error}` };
    const parsed = parseProviders(providers.data);
    if (!parsed.models.length) return { ok: false, error: 'serve 返回的模型清单是空的' };
    const quotas = {};
    for (const model of parsed.models) {
      const quota = await get(`/api/v2/model/${encodeURIComponent(model.id)}/quota`, { retries: 1 });
      if (quota.ok) quotas[model.id] = parseQuota(quota.data);
    }
    return { ok: true, source: 'serve', models: parsed.models.map(m => m.id), details: parsed.models, credit: parsed.credit,
      discount: parsed.discount, quotas, at: new Date().toISOString() };
  });
}

// 换成 /model 菜单用量快照的格式（core/codeagent-usage-menu.js recordUsage），额度条和模型下拉不用分两套显示：
//   credit: { monthly / busyDay / idleDay: { used, total, pct } }；models: [{ name, factor, load, day / hour / min: { used:'29.16M', total:'400M', pct } }]
// serve 只给「闲时2折进行中」这类状态，不给倒计时：idleDiscountIn 留空。
const CREDIT_KEY = { CPM: 'monthly', CPD_Peak: 'busyDay', CPD_Valley: 'idleDay' };
const WINDOW_KEY = { TPD: 'day', TPH: 'hour', TPM: 'min' };
const round2 = n => Math.round(n * 100) / 100;
const pctOf = (used, total) => (total > 0 ? round2(((used || 0) / total) * 100) : null);
function tokens(n) {
  if (!Number.isFinite(n)) return '';
  for (const [unit, size] of [['B', 1e9], ['M', 1e6], ['K', 1e3]]) if (Math.abs(n) >= size) return `${round2(n / size)}${unit}`;
  return String(n);
}
function toUsageSnapshot(read) {
  if (!read || !read.ok) return null;
  const credit = {};
  for (const q of read.credit || []) {
    const key = CREDIT_KEY[q.type];
    if (key && q.total > 0) credit[key] = { used: String(round2(q.used || 0)), total: String(round2(q.total)), pct: pctOf(q.used, q.total) };
  }
  const discount = /(\d+(?:\.\d+)?)\s*折/.exec(read.discount || '');
  const models = (read.details || []).map(m => {
    const out = { name: m.id, factor: m.coefficient || null, load: m.load || null, day: null, hour: null, min: null };
    for (const q of (read.quotas && read.quotas[m.id]) || []) {
      const key = WINDOW_KEY[q.type];
      if (key && q.total > 0) out[key] = { used: tokens(q.used || 0), total: tokens(q.total), pct: pctOf(q.used, q.total) };
    }
    return out;
  });
  const hasCredit = Object.keys(credit).length > 0;
  if (!hasCredit && !models.length) return null;
  return { credit: hasCredit ? { monthly: credit.monthly || null, busyDay: credit.busyDay || null, idleDay: credit.idleDay || null,
    idleDiscountIn: null, idleDiscount: discount ? `${discount[1]}折` : null } : null, models };
}

// AI_HUB_CODEAGENT_SERVE=1 强制打开、=0 强制关掉。启动选模型时「只传 --model、不开 /model」也跟这个开关走。
function serveEnabled(dataDir, env = process.env) {
  const flag = env.AI_HUB_CODEAGENT_SERVE;
  if (flag === '0' || flag === '1') return flag === '1';
  try { return require('./edition-channel').wasUnlocked(dataDir); } catch { return false; }
}

module.exports = { serveEnabled, withTempServe, request, getJson, freePort, portOwner, HEALTH_PATH, parseProviders, parseQuota, readAccount, toUsageSnapshot };
