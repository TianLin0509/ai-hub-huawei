'use strict';
// 首次启动准备（2026-11-09 用户定）：第一次打开 Hub 时把该查的都查掉、该取的都取好，结果存下来；以后打开不用等。
// 判断要不要重做靠「文件指纹」：CodeAgent 主程序的路径、大小、修改时间，不启动程序、不联网，不到 1 毫秒。
//   full    没做过（或准备项有大改，SCHEMA 加一）：全屏准备页
//   changed CodeAgent 换了版本或新装了：不弹全屏，右下角只重做受影响的几项
//   remind  上次有没处理好的项：只给一条可关的小提示
//   none    什么都不做
// 每一步都各自限时、各自兜底，一步出错只影响它自己。这里不碰界面，也不读密钥以外的账号内容。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const SCHEMA = 1;
const STATE_FILE = 'first-run-prep.json';
const ST = Object.freeze({ wait: 'wait', run: 'run', ok: 'ok', warn: 'warn', bad: 'bad', off: 'off', hold: 'hold' });
const ENV_ROWS = Object.freeze(['codeagent', 'claude', 'codex', 'dsh', 'git-bash', 'node', 'welink', 'ppt-doctor', 'app-update', 'disk', 'data-dir']);
const CHANGED_ROWS = new Set(['codeagent', 'login', 'models', 'proxy', 'sign', 'hello']);
const RECHECK = Object.freeze({ label: '重新检查', act: 'recheck' });
// 用到才需要的工具：没装不算问题，准备页不标红、不催装（安装入口在环境体检页）。
const OPTIONAL_ROWS = new Set(['claude', 'codex', 'dsh', 'welink', 'ppt-doctor']);

function layout({ isCompany }) {
  const company = isCompany ? [
    ['账号与区域', [['login', 'CodeAgent 登录'], ['zone', '所在区域'], ['pool', '可选账号（不添加也能用个人账号）']]],
    ['模型', [['models', '可用模型清单'], ['proxy', '公司模型通道'], ['sign', '公司模型连接凭证'], ['hello', '验证模型能否回答']]],
  ] : [];
  return [
    ['工具', [['codeagent', 'CodeAgent'], ['claude', 'Claude'], ['codex', 'Codex'], ['dsh', 'DSH'], ['git-bash', 'Git Bash'], ['node', 'Node.js'], ['welink', 'WeLink'], ['ppt-doctor', 'PPT Doctor']]],
    ...company,
    ['网络与更新', [['net-pass', '下载服务器放行'], ['app-update', '更新下载源'], ['sys-proxy', '系统代理']]],
    ['本机条件', [['disk', '磁盘空间'], ['data-dir', '数据目录可写'], ['clock', '系统时间']]],
  ].map(([name, rows]) => ({ name, rows: rows.map(([id, label]) => ({ id, label })) }));
}

function readState(dataDir) {
  try { const s = JSON.parse(fs.readFileSync(path.join(dataDir, STATE_FILE), 'utf8')); return s && typeof s === 'object' ? s : null; }
  catch { return null; }
}
function writeState(dataDir, state) {
  try { require('./atomic-write').writeFileAtomic(fs, path.join(dataDir, STATE_FILE), JSON.stringify(state, null, 2)); return true; }
  catch { return false; }
}
function fingerprint(file) {
  if (!file) return null;
  try { const s = fs.statSync(file); return s.isFile() ? { path: file, size: s.size, mtimeMs: Math.round(s.mtimeMs) } : null; }
  catch { return null; }
}
const sameFingerprint = (a, b) => !!a && !!b && String(a.path).toLowerCase() === String(b.path).toLowerCase() && a.size === b.size && a.mtimeMs === b.mtimeMs;

function pendingCount(state) {
  if (!state || !state.at) return null;
  if (state.rows && typeof state.rows === 'object') return new Set([...Object.entries(state.rows).filter(([, r]) => ['bad', 'warn', 'hold'].includes(r?.status)).map(([id]) => id), ...(state.problems || [])]).size;
  return Array.isArray(state.problems) ? new Set(state.problems).size : null;
}

function decide(state, current) {
  if (!state || state.schema !== SCHEMA) return 'full';
  // CodeAgent 没了不算「变了」：等用户用到时由原有提示接住，不在打开时打扰。
  if (current && !sameFingerprint(state.fingerprint, current)) return 'changed';
  return Array.isArray(state.problems) && state.problems.length ? 'remind' : 'none';
}

function limited(promise, ms, fallback) {
  let timer;
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timer)), new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); timer.unref?.(); })]);
}

// 经本机反代真实问一句：默认模型不行就换下一个（有的账号只有 DeepSeek 权限）。key 只进请求头。
function askOnce({ port, key, model, timeoutMs = 20000 }) {
  return new Promise(resolve => {
    const body = JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the word OK only.' }] });
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', timeout: timeoutMs,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (text.length < 4000) text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* 非 JSON 按失败算 */ }
        const answer = Array.isArray(parsed?.content) ? parsed.content.map(c => c?.text || '').join('').trim() : '';
        resolve(res.statusCode === 200 && answer ? { ok: true, model, answer }
          : { ok: false, model, error: String(parsed?.error?.message || parsed?.message || `HTTP ${res.statusCode}`).slice(0, 200) });
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`${Math.round(timeoutMs / 1000)} 秒内没有回答`)); });
    req.on('error', error => resolve({ ok: false, model, error: error.message }));
    req.end(body);
  });
}
async function helloAny({ port, key, models, ask = askOnce }) {
  let last = { ok: false, error: '没有可试的模型' };
  for (const model of models) { last = await ask({ port, key, model }); if (last.ok) return last; }
  return last;
}

// deps 见 main/ipc/first-run-handlers.js；全部可替换，单测不启动任何真实程序。
function createPrep({ isCompany, deps, emit = () => {} }) {
  async function run(mode = 'full') {
    const only = mode === 'changed' ? CHANGED_ROWS : null;
    const groups = layout({ isCompany }).map(g => ({ name: g.name, rows: g.rows.filter(r => !only || only.has(r.id)) })).filter(g => g.rows.length);
    const ids = new Set(groups.flatMap(g => g.rows.map(r => r.id)));
    const rows = {};
    const set = (id, status, detail = '', fixes = []) => {
      if (!ids.has(id)) return;
      rows[id] = { id, status, detail, fixes };
      try { emit({ type: 'row', row: rows[id] }); } catch { /* 界面没开 */ }
    };
    const step = async (id, ms, fn) => {
      set(id, ST.run, '检查中…');
      try { const r = await limited(fn(), ms, { status: ST.warn, detail: `${Math.round(ms / 1000)} 秒内未能确认结果。可以先进入 Hub；使用这项功能前，请点『重新检查』。`, fixes: [RECHECK] }); set(id, r.status, r.detail, r.fixes || []); return r; }
      catch (error) { const r = { status: ST.warn, detail: `这一项没查成：${String(error.message || error).slice(0, 160)}`, fixes: [RECHECK] }; set(id, r.status, r.detail, r.fixes); return r; }
    };
    const hold = (list, why) => list.forEach(id => set(id, ST.hold, why));
    const off = (list, why) => list.forEach(id => set(id, ST.off, why));
    try { emit({ type: 'start', mode, groups }); } catch { /* 界面没开 */ }

    // 先找 CodeAgent，后面各步共用这一份结果。
    try { await limited(deps.discover(), 12000, null); } catch { /* 找不到时由体检那一行说明 */ }
    const hasCli = !!deps.codeagentFile();

    const netPass = only ? Promise.resolve() : step('net-pass', 30000, async () => {
      const s = await deps.netPass();
      if (!s || !s.available) return { status: ST.off, detail: '这个版本不需要' };
      const blocked = s.hosts.filter(h => h.state === 'blocked');
      if (blocked.length) return { status: ST.bad, detail: '公司代理拦了下载服务器，自动放行没成功', fixes: blocked.slice(0, 1).map(h => ({ label: '打开放行页', act: 'open-gate', url: h.page })).concat(RECHECK) };
      const failed = s.hosts.filter(h => h.state === 'error').length;
      return failed ? { status: ST.warn, detail: `${s.hosts.length} 台里 ${failed} 台暂时连不上，更新时会自动换源`, fixes: [RECHECK] } : { status: ST.ok, detail: `${s.hosts.length} 台都能访问` };
    });
    const env = (async () => {
      ENV_ROWS.forEach(id => set(id, ST.run, '检查中…'));
      let result = null;
      try { result = await deps.envCheck(); } catch (error) { result = { ok: false, error: error.message }; }
      const items = new Map((result?.items || []).map(i => [i.id, i]));
      for (const id of ENV_ROWS) {
        const item = items.get(id);
        if (!item) set(id, result?.ok === false ? ST.warn : ST.off, result?.ok === false ? '体检没跑成，稍后可重新检查' : '不适用', result?.ok === false ? [RECHECK] : []);
        else if (OPTIONAL_ROWS.has(id) && item.status !== 'ok') set(id, ST.off,
          item.installed === false ? '没装，用到时再装' : [item.detail, item.cause].filter(Boolean).join('：'));
        else set(id, item.status, item.status === 'ok' || item.status === 'off' ? item.detail : [item.detail, item.cause].filter(Boolean).join('：'),
          (item.fixes || []).map(fix => (fix.act === 'open-codeagent' ? { ...fix, label: '已装，手动选择' } : fix)));
      }
    })();

    const account = !isCompany ? Promise.resolve() : (async () => {
      if (!hasCli) { hold(['login', 'models'], '等 CodeAgent 装好'); return; }
      const login = await step('login', 6000, async () => {
        const state = await deps.loginState();
        return state === 'ready' ? { status: ST.ok, detail: '已登录' }
          : { status: ST.bad, detail: '还没登录：点「一键登录」完成登录，回到 Hub 后自动重新检查', fixes: [{ label: '一键登录', act: 'codeagent-login' }, RECHECK] };
      });
      if (login.status !== ST.ok) { hold(['models'], '等登录好'); return; }
      // 读模型清单要启动一次 CodeAgent，可能比较慢：到时间就让它后台继续，不拖住用户。
      await step('models', 14000, async () => {
        const r = await limited(deps.readModels(), 14000, { pending: true });
        if (r.pending) return { status: ST.off, detail: '读得比较慢，已转到后台继续' };
        if (r.skipped) return { status: ST.off, detail: '第一次建会话时读取' };
        return r.ok ? { status: ST.ok, detail: r.models.slice(0, 4).join('、') } : { status: ST.warn, detail: `这次没读到：${String(r.error || '').slice(0, 120)}，建会话时会再读`, fixes: [RECHECK] };
      });
    })();

    const proxy = !isCompany ? Promise.resolve() : (async () => {
      const chain = ['proxy', 'zone', 'pool', 'sign', 'hello'];
      if (!hasCli) { hold(chain, '等 CodeAgent 装好'); return; }
      if (!deps.proxyEnabled()) { off(chain, '还没开公司模型，开启时会自动准备'); return; }
      chain.forEach(id => set(id, ST.run, '检查中…'));
      let status = await limited(deps.proxyReady().catch(error => ({ state: 'failed', message: error.message })), 40000, { state: 'not-ready', message: '等了 40 秒还没准备好' });
      if (status.state !== 'running' && deps.proxyReload) status = await limited(deps.proxyReload().catch(error => ({ state: 'failed', message: error.message })), 40000, status);
      if (status.state !== 'running') {
        set('proxy', ST.bad, String(status.message || '没能启动').slice(0, 300), [{ label: '重新启动通道', act: 'proxy-restart' }, RECHECK]);
        if (status.code === 'ZONE_UNKNOWN') set('zone', ST.bad, '没识别出区域：到「设置 → 自有 API → 公司模型」里选择', [RECHECK]);
        hold(chain.slice(1).filter(id => !(id === 'zone' && status.code === 'ZONE_UNKNOWN')), '等公司模型通道好');
        return;
      }
      set('proxy', ST.ok, '已启动');
      set('zone', status.zone?.zone ? ST.ok : ST.off, status.zone?.text || '接口地址已配置，不按区域区分');
      const accounts = Array.isArray(status.accounts) ? status.accounts.length : 0;
      set('pool', accounts ? ST.ok : ST.off, accounts ? `${accounts} 个账号` : '只用个人账号');
      set('sign', ST.ok, status.firstInit?.ran ? '已取得并存好，以后不用再取' : '已有缓存，直接用');
      await step('hello', 45000, async () => {
        const r = await deps.hello();
        return r.ok ? { status: ST.ok, detail: `${r.model} 回答了「${r.answer.slice(0, 20)}」，这条路真的通` }
          : { status: ST.bad, detail: `模型没有回答：${r.error}`, fixes: [{ label: '重新启动通道', act: 'proxy-restart' }, RECHECK] };
      });
    })();

    const network = only ? Promise.resolve() : Promise.all([
      netPass,
      step('sys-proxy', 5000, async () => { const r = await deps.systemProxy(); return { status: ST.ok, detail: r === 'DIRECT' || !r ? '直连' : '使用系统代理，本机模型通道不经过它' }; }),
      step('clock', 8000, async () => {
        const skew = await deps.clockSkew();
        if (skew == null) return { status: ST.off, detail: '没有可对照的时间，已跳过' };
        return Math.abs(skew) > 300000 ? { status: ST.warn, detail: `电脑时间差了约 ${Math.round(Math.abs(skew) / 60000)} 分钟，证书和签名可能失败，请校准系统时间`, fixes: [RECHECK] } : { status: ST.ok, detail: '正常' };
      }),
    ]);

    await Promise.all([env, account, proxy, network].map(p => Promise.resolve(p).catch(() => {})));
    const list = Object.values(rows);
    const problems = list.filter(r => r.status === ST.bad).map(r => r.id);
    const summary = { problems, held: list.filter(r => r.status === ST.hold).map(r => r.id) };
    const previous = deps.readState?.() || null;
    const savedRows = mode === 'changed' ? { ...previous?.rows, ...rows } : rows;
    deps.saveState?.({ schema: SCHEMA, at: deps.now ? deps.now() : Date.now(), fingerprint: deps.fingerprint?.() || previous?.fingerprint || null,
      rows: savedRows, problems: mode === 'changed' ? [...new Set([...(previous?.problems || []).filter(id => !ids.has(id)), ...problems])] : problems });
    try { emit({ type: 'done', mode, ...summary }); } catch { /* 界面没开 */ }
    return { mode, rows, ...summary };
  }
  return { run };
}

module.exports = { SCHEMA, STATE_FILE, ST, layout, readState, writeState, fingerprint, sameFingerprint, pendingCount, decide, askOnce, helloAny, createPrep };
