'use strict';
// R44（2026-11-25）：「软件更新」连不上内源时的两种界面，真实 Main/renderer/IPC + 隐藏的隔离 Hub，真实走内源（AI_HUB_OPENX=1、不注入测试源）。
//   slow：用 --proxy-server 指向一个只收连接不回话的本机端口，模拟「在公司但内源不响应」→ 20 秒后一句话 + 旁边「重试」。
// 用法：node tests/e2e-update-offline-calm-cdp.js [--shots <截图目录>] [--case offline|slow|all]
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.join(__dirname, '..');
const SHOTS = opt('shots') ? path.resolve(opt('shots')) : null;
const CASE = opt('case') || 'all';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`); };

const DIALOG_PROBE = `(() => {
  const d = document.querySelector('dialog.app-update-dialog[open]');
  if (!d) return { open: false };
  const text = d.innerText;
  return { open: true, text, bad: !!d.querySelector('.au-msg.bad'), offline: !!d.querySelector('[data-au-offline]'), slow: !!d.querySelector('[data-au-slow]'),
    sourceRows: d.querySelectorAll('[data-source]').length, retry: d.querySelectorAll('[data-au="retry"]').length,
    retryInHint: !!d.querySelector('[data-au-slow] [data-au="retry"]'), retryInOffline: !!d.querySelector('[data-au-offline] [data-au="retry"]'), primary: d.querySelectorAll('.au-btn.primary').length };
})()`;

async function runCase(kind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hub-r44-${kind}-`));
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  fs.writeFileSync(path.join(root, 'work', '.aiwork-root'), '');
  // slow：只收连接、不回话的「代理」，Chromium 的请求会一直挂着直到 Hub 自己的预算到点。
  const sockets = new Set();
  const hang = kind === 'slow' ? net.createServer(s => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); }) : null;
  const hangPort = hang ? await new Promise(resolve => hang.listen(0, '127.0.0.1', () => resolve(hang.address().port))) : 0;
  let hub = null, c = null;
  try {
    hub = await launchIsolatedHub({ entryPath: ROOT, cwd: ROOT, dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'hidden', label: `r44-${kind}`,
      extraArgs: hang ? [`--proxy-server=http://127.0.0.1:${hangPort}`] : [],
      extraEnv: {
        AI_HUB_WORKSPACE_ROOT: path.join(root, 'work'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
        CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0', AI_HUB_OPENX: '1', AI_HUB_UPDATE_SOURCES: '',
        AI_HUB_UPDATE_STARTUP_DELAY_MS: '1500' } });
    c = await connectFirstPage(hub, null, { waitMainMs: 20000 });
    const state = () => c.eval('window.__appUpdate && window.__appUpdate.state()').catch(() => null);
    // 1. 后台自动检查（启动后 1.5 秒）：失败也不弹窗、不进 error。
    let st = null;
    for (const end = Date.now() + 45000; Date.now() < end;) { st = await state(); if (st && st.checkedAt) break; await sleep(500); }
    const auto = await c.eval(DIALOG_PROBE);
    check(`${kind}：后台自动检查失败只记下、不进 error`, st && st.phase === 'idle' && st.silentFailure === true, st ? `${st.phase} / ${st.errorKind}` : 'no state');
    check(`${kind}：后台自动检查失败没有弹出更新窗`, !auto.open);
    // 2. 用户手动「检查更新」。
    await c.eval(`document.querySelectorAll('dialog[open]').forEach(d => { if (!d.classList.contains('app-update-dialog')) d.close(); })`);
    await c.eval('window.__appUpdate.open()');
    const started = Date.now();
    await c.eval(`require('electron').ipcRenderer.invoke('app-update:check')`);
    const ms = Date.now() - started;
    st = await state();
    await sleep(600);
    const p = await c.eval(DIALOG_PROBE);
    console.log(`  手动检查耗时 ${ms} ms；errorKind=${st && st.errorKind}；原始原因：${(st && st.internalSource && st.internalSource.reason) || ''}`);
    console.log('  窗口文字：' + (p.text || '').replace(/\s+/g, ' '));
    if (kind === 'offline') {
      check('offline：快判（3 秒内出结果）', ms < 3000, `${ms} ms`);
      check('offline：灰色说明「不在公司网络」', p.offline && /不在公司网络/.test(p.text));
      check('offline：没有红框；只在提示旁有一个不高亮的「重试」，底部没有高亮按钮', !p.bad && p.retry === 1 && p.retryInOffline && p.primary === 0);
    } else {
      check('slow：手动检查等满约 20 秒', ms >= 19000 && ms < 30000, `${ms} ms`);
      check('slow：一句话说明 +「重试」在提示旁边', p.slow && p.retryInHint && p.retry === 1 && /20 秒内没查完/.test(p.text));
      check('slow：没有红框、底部没有高亮重试', !p.bad && p.primary === 0);
    }
    check(`${kind}：原因只说一次（不再另列「公司内源」一行）`, p.sourceRows === 0 && ((p.text || '').match(/秒内没|不在公司网络/g) || []).length === 1);
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(500);
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(SHOTS, `20261125-r44-${kind}-after.png`);
      fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
      console.log('SHOT ' + file);
    }
  } catch (error) {
    check(`${kind}：运行没有异常`, false, (error.stack || error.message) + (error.logTail ? '\nLOG:\n' + error.logTail : ''));
  } finally {
    if (c) await c.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(() => {});
    if (hang) { for (const s of sockets) s.destroy(); hang.close(); }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
}

(async () => {
  for (const kind of CASE === 'all' ? ['offline', 'slow'] : [CASE]) await runCase(kind);
  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({ pass: results.length - failed.length, fail: failed.length }));
  process.exit(failed.length ? 1 : 0);
})();
