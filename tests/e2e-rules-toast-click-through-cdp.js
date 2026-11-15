'use strict';
// 规则页提示条不挡按钮（真实界面，隔离 Hub、无头）。
// 用户反馈：规则页弹出的提示挡住后面的按钮、消息发不出去，只能等提示消失。
// 做法：在 1440×900 与 1280×720 下连点开关堆出 3 条提示，在每条提示中心用真实鼠标事件点一下，
// 断言点击落到提示下面的元素，而提示条本身仍显示原文。
// 可选：R13_SHOTS=<目录> R13_TAG=<前缀> 时保存截图。
// 运行：node tests/e2e-rules-toast-click-through-cdp.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs: sleep } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.env.R13_SHOTS || '';
const TAG = process.env.R13_TAG || 'e2e';
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rules-toast-'));
  const result = { sizes: [], failures: [] };
  const check = (ok, msg) => { if (!ok) result.failures.push(msg); };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: ROOT, cwd: ROOT, dataDir: path.join(testRoot, 'data'), port: await freePort(), windowMode: 'hidden', label: 'rules-toast',
      extraEnv: { CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_ATTENDANCE_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1' } });
    c = await connectFirstPage(hub);
    const wait = async (expr, label) => { for (let i = 0; i < 100; i++) { if (await c.eval(expr)) return; await sleep(200); } throw new Error('界面等待超时：' + (label || expr)); };
    const shot = async name => {
      if (!SHOTS) return '';
      fs.mkdirSync(SHOTS, { recursive: true });
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      const f = path.join(SHOTS, name); fs.writeFileSync(f, Buffer.from(s.data, 'base64')); return f;
    };
    await wait('!!document.getElementById("btn-rules")');
    // 隐藏窗口截图要等一帧，可能超过提示的 3.2 秒寿命；测试里把提示的定时消失延到 60 秒，量完再手动清掉。
    await c.eval(`(() => { const raw = window.setTimeout; window.setTimeout = (fn, ms, ...a) => raw(fn, ms === 3200 || ms === 7000 ? 60000 : ms, ...a); return true; })()`);
    await c.eval(`window.__r13Clicks = []; document.addEventListener('mousedown', e => window.__r13Clicks.push(e.target.closest('.rl-toast') ? 'toast' : (e.target.id || e.target.className || e.target.tagName)), true); true`);
    for (const [w, h] of [[1440, 900], [1280, 720]]) {
      await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      // 刚启动时规则页可能还没装好入口，点不开就隔 1 秒再点
      const rulesShown = 'getComputedStyle(document.getElementById("rules-panel")).display !== "none" && !!document.querySelector("#rules-panel .rl-switch")';
      for (let i = 0; i < 20 && !(await c.eval(rulesShown)); i++) {
        // 窗口矮时侧栏会把「规则」收进更多菜单，这时直接调规则页的打开入口
        await c.eval('(() => { const b = document.getElementById("btn-rules"); if (b && b.offsetParent) b.click(); else window.__rulesShow?.(); return true; })()'); await sleep(1000);
      }
      await wait(rulesShown + ' && !document.querySelector("#rules-panel .rl-switch").disabled', '规则页开关');
      for (let i = 0; i < 3; i++) {
        await wait('!document.querySelector("#rules-panel .rl-switch").disabled', '开关可点');
        await c.eval('document.querySelector("#rules-panel .rl-switch").click()');
        await sleep(150);
      }
      await wait('document.querySelectorAll(".rl-toast").length >= 2', '提示出现');
      const shotPath = await shot(`20261115-r13-${TAG}-规则页-${w}x${h}.png`);
      const toasts = await c.eval(`(() => {
        // 底部状态栏：从「一键放行」按钮往上找到横跨整窗的那一层
        let bar = null, el = [...document.querySelectorAll('button, a, span')].find(e => e.textContent.trim() === '一键放行' && e.getBoundingClientRect().width > 0);
        for (; el && el !== document.body; el = el.parentElement) { const r = el.getBoundingClientRect(); if (r.width >= innerWidth * 0.9) { bar = r.top; break; } }
        return { barTop: bar == null ? null : Math.round(bar), list: [...document.querySelectorAll('.rl-toast')].map(t => { const r = t.getBoundingClientRect();
          return { text: t.textContent, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), bottom: Math.round(r.bottom), visible: getComputedStyle(t).visibility === 'visible' && r.width > 0 }; }) };
      })()`);
      assert.ok(toasts.list.length >= 2, `${w}x${h} 应堆出至少 2 条提示，实际 ${toasts.list.length}`);
      const rec = { size: `${w}x${h}`, shot: shotPath, barTop: toasts.barTop, toasts: [] };
      for (const t of toasts.list) {
        await c.eval('window.__r13Clicks.length = 0; true');
        for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: t.x, y: t.y, button: 'left', clickCount: 1 });
        const hits = await c.eval('window.__r13Clicks.slice()');
        rec.toasts.push({ ...t, hit: hits[0] || null });
        check(t.visible && t.text.length > 0, `提示条应仍可见且有原文：${t.text}`);
        check(hits.length > 0 && hits[0] !== 'toast', `${w}x${h} 点在提示「${t.text}」上应落到下面的元素，实际：${hits[0]}`);
        if (toasts.barTop != null) check(t.bottom <= toasts.barTop, `${w}x${h} 提示不应压住底部状态栏（提示底 ${t.bottom} > 状态栏顶 ${toasts.barTop}）`);
      }
      result.sizes.push(rec);
      await c.eval('document.querySelectorAll(".rl-toast").forEach(e => e.remove()); true');
      await c.eval(`window.__rulesHide?.(); document.getElementById("btn-home").click(); true`);
      await sleep(1500); // 主页是异步渲染，等它画完再开规则页，免得主页盖在规则页上
    }
    console.log(JSON.stringify(result, null, 2));
    assert.deepEqual(result.failures, [], result.failures.join('；'));
    console.log('PASS 规则页提示条不拦点击、不压状态栏、原文仍可见');
  } catch (e) {
    console.log(JSON.stringify(result, null, 2));
    console.error('FAIL', e && e.message || e);
    process.exitCode = 1;
  } finally {
    try { await c?.close(); } catch {}
    try { if (hub) await gracefulQuit(hub); } catch {}
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch {}
  }
})();
