'use strict';
// 历史会话页（「昨日之我」/ 归档）× 主题：隔离 Hub、合成会话，不调模型。
// 拍三张：最近会话列表、侧栏「归档」入口打开后的列表、点开一条后的阅读页；并在弹窗内统计对比度与浅色大块。
// 用法：node tests/capture-history-theme-cdp.js [--entry <检出>] [--out <目录>] [--themes dark,frost,codex]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { randomUUID } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { census } = require('./capture-theme-fit-cdp');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const DARK = new Set(['dark', 'frost']);

function parseArgs(argv) {
  const opt = { entry: REPO, out: path.join(REPO, 'artifacts', 'history-theme-' + Date.now()), themes: ['dark', 'frost', 'codex'], width: 1440, height: 900 };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, ''), v = argv[i + 1];
    if (k === 'themes') opt.themes = v.split(','); else opt[k] = path.resolve(v);
  }
  return opt;
}

function seed(root) {
  const data = path.join(root, 'data'), claudeDir = path.join(root, 'claude'), cwd = path.join(root, 'project');
  for (const d of [path.join(data, 'sessions'), cwd]) fs.mkdirSync(d, { recursive: true });
  const slug = require(path.join(REPO, 'core/claude-prefix-fork')).projectSlug(cwd);
  const day = 86400000, now = Date.now();
  const titles = [['周期方案重构', 0.1], ['调度器单测补齐', 0.3], ['门户登录排查', 0.6], ['上周的信道对比', 9], ['考勤统计口径', 12], ['旧版 PPT 骨架', 20]];
  const sessions = titles.map(([title, ageDays], n) => {
    const id = randomUUID(), nativeId = randomUUID(), t = now - ageDays * day;
    const file = path.join(claudeDir, 'projects', slug, nativeId + '.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows = []; let parent = null;
    for (let k = 0; k < 3; k++) {
      const u = randomUUID(), a = randomUUID();
      rows.push({ type: 'user', uuid: u, parentUuid: parent, sessionId: nativeId, cwd, timestamp: new Date(t - 60000 + k * 2000).toISOString(), message: { role: 'user', content: `${title}：第 ${k + 1} 个问题，帮我看一下这里为什么慢` } });
      rows.push({ type: 'assistant', uuid: a, parentUuid: u, sessionId: nativeId, cwd, timestamp: new Date(t - 59000 + k * 2000).toISOString(), message: { role: 'assistant', id: 'msg_' + a.replace(/-/g, ''), content: [{ type: 'text', text: `结论：瓶颈在第 ${k + 1} 步。\n\n- 原因一：重复读取配置\n- 原因二：没有缓存\n\n\`\`\`js\nconst cache = new Map();\n\`\`\`` }], stop_reason: 'end_turn' } });
      parent = a;
    }
    fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    fs.utimesSync(file, new Date(t), new Date(t));
    const record = { schemaVersion: 1, hubId: id, title, kind: 'claude', cwd, ccSessionId: nativeId, transcriptPath: file, agentRuntime: 'pty', status: 'dormant', createdAt: t - 120000, updatedAt: t, lastMessageTime: t, lastCompletedAt: t };
    fs.writeFileSync(path.join(data, 'sessions', id + '.json'), JSON.stringify(record));
    return record;
  });
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ version: 1, cleanShutdown: true, sessions, meetings: [] }));
  return { data, claudeDir, cwd, sessions };
}

async function run(opt) {
  fs.mkdirSync(opt.out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-history-theme-'));
  const { data, claudeDir, sessions } = seed(root);
  const result = { entry: opt.entry, shots: [], errors: [] };
  const save = () => fs.writeFileSync(path.join(opt.out, 'history-theme.json'), JSON.stringify(result, null, 2));
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: opt.entry, cwd: opt.entry, dataDir: data, port: await freePort(), windowMode: 'background', label: 'history-theme', extraEnv: {
      CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(root, 'unused-codex'), AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'unused-codeagent'),
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    } });
    c = await connectFirstPage(hub);
    const wait = async (expr, label, timeout = 30000) => {
      for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* reload */ } await sleep(150); }
      throw Error('Timeout ' + label);
    };
    const ready = 'typeof selectSession === "function"';
    await wait(ready, 'renderer ready');
    const shot = async (theme, name) => {
      const file = `${theme}-${name}-${opt.width}.png`;
      fs.writeFileSync(path.join(opt.out, file), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      // 统计范围换成历史会话页本身。
      const stats = await c.eval(`(()=>{const src=${JSON.stringify(census.toString())};
        const patched=src.replace(/const scopes = \\[[^\\]]*\\];/, "const scopes=['#search-modal','.session-search-dialog','.workspace-host','[data-workspace]'];");
        return (0,eval)('('+patched+')')(${JSON.stringify({ dark: DARK.has(theme) })});})()`);
      const rows = await c.eval(`document.querySelectorAll('#search-modal .session-search-result').length`);
      const probe = await c.eval(`(()=>{const o={};for(const s of ['.session-search-command','.session-search-result','.session-search-result-title','.session-search-reader-sheet','.session-search-preview-heading h3','.session-search-preview-tabs button','.session-search-action.primary']){const e=document.querySelector('#search-modal '+s);if(e){const cs=getComputedStyle(e);o[s]={bg:cs.backgroundColor,bgImage:cs.backgroundImage.slice(0,60),color:cs.color};}}return o;})()`);
      result.shots.push({ theme, name, file, rows, probe, ...stats });
      console.log(theme, name, 'rows', rows, 'checked', stats.checked, 'low', stats.lowCount, 'light', stats.lightCount);
    };
    for (const theme of opt.themes) {
      try {
        await c.eval(`localStorage.setItem('hub.theme',${JSON.stringify(theme)})`);
        await c.send('Page.reload', {}); await sleep(1200);
        await wait(ready + ` && document.documentElement.dataset.theme===${JSON.stringify(theme)}`, 'theme ' + theme);
        await c.send('Emulation.setDeviceMetricsOverride', { width: opt.width, height: opt.height, deviceScaleFactor: 1, mobile: false });
        await wait(`document.querySelectorAll('.session-item').length>0`, 'sidebar');
        await sleep(800);
        // ① 历史会话页：rail 上的搜索入口（Ctrl+Shift+F 同一入口）
        await c.eval(`(()=>{const b=document.querySelector('#btn-global-search');if(b)b.click();else window.__globalSessionSearch?.open?.();})()`);
        await sleep(2500);
        await shot(theme, 'history');
        // ①b 历史会话页里：筛选 → 归档页签（时间仍是默认的最近 7 天）
        await c.eval(`(()=>{const t=document.querySelector('#session-search-filter-toggle');if(t&&t.getAttribute('aria-expanded')!=='true')t.click();})()`); await sleep(400);
        await c.eval(`document.querySelector('#search-modal [data-scope="dormant"]')?.click()`); await sleep(2000);
        await shot(theme, 'archive-tab');
        // ② 侧栏「归档」入口
        await c.eval(`document.querySelector('#search-modal-close')?.click()`); await sleep(400);
        await c.eval(`document.querySelector('.session-archive-entry')?.click()`); await sleep(2500);
        await shot(theme, 'archive');
        // ③ 点开第一条，进阅读页
        await c.eval(`(()=>{const r=document.querySelector('#search-modal .session-search-result');r&&r.click();})()`);
        await sleep(2500);
        await shot(theme, 'reader');
        await c.eval(`document.querySelector('#search-modal-close')?.click()`); await sleep(400);
      } catch (error) { result.errors.push({ theme, error: error.message }); console.log(theme, 'ERROR', error.message); }
      save();
    }
    result.ok = true;
    result.sessions = sessions.map(s => ({ title: s.title, ageDays: Math.round((Date.now() - s.lastMessageTime) / 86400000) }));
  } catch (error) { result.error = error.stack; console.error(error.stack); process.exitCode = 1; }
  finally {
    if (hub) { try { await gracefulQuit(hub); } catch { /* best effort */ } hub.child?.stdout?.destroy(); hub.child?.stderr?.destroy(); hub.child?.stdin?.destroy(); }
    try { await c?.close(); } catch { /* closed */ }
    save(); console.log('OUT ' + opt.out);
  }
  return result;
}

module.exports = { run };
if (require.main === module) run(parseArgs(process.argv.slice(2)));
