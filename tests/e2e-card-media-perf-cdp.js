'use strict';
// 长对话打开时 mermaid 会不会卡界面：隔离 Hub、真实 Electron 页面，挂 50 张各带一张 mermaid 的回答卡片，
// 滚到底（像打开一条长对话），量 8 秒内主线程最长卡顿、累计长任务、画了几张、首张可见图多久出来。
// 用法：node tests/e2e-card-media-perf-cdp.js [--before <旧版 card-media.js>] [--out <目录>]
//   --before 给一份旧版 card-media.js，会临时复制进 renderer/ 换掉新版来量（量完删掉），同一台机器前后对比。
const fs = require('fs'), os = require('os'), net = require('net'), path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const before = arg('--before');
const out = path.resolve(arg('--out') || 'artifacts/card-media-perf');
const tag = before ? 'before' : 'after';
const CARDS = 50;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function answer(i) {
  return [`### 第 ${i + 1} 步`, '说明文字。'.repeat(6), '', '```mermaid', 'flowchart LR',
    `  A${i}[输入 ${i}] --> B${i}{判断 ${i}}`, `  B${i} -- 是 --> C${i}[处理 ${i}]`, `  B${i} -- 否 --> D${i}[跳过 ${i}]`,
    `  C${i} --> E${i}[输出 ${i}]`, `  D${i} --> E${i}`, '```', '', '收尾说明。'].join('\n');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-card-media-perf-'));
  const project = path.join(root, 'project'); fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(out, { recursive: true });
  const swap = before ? path.join(__dirname, '..', 'renderer', 'card-media-perf-before.tmp.js') : null;
  if (swap) fs.copyFileSync(path.resolve(before), swap);
  let hub, c, result;
  try {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), label: 'card-media-perf-' + tag, windowMode: 'hidden' });
    for (let n = 0; n < 40 && !c; n++) {
      try { c = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\/]index\.html/i.test(t.url || '')); }
      catch { await sleep(500); }
    }
    for (let n = 0; n < 150; n++) { if (await c.eval('!!document.body && document.readyState === "complete" && !!document.getElementById("msg-overlay")')) break; await sleep(100); }
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const answers = Array.from({ length: CARDS }, (_, i) => answer(i));
    result = await c.eval(`(async () => {
      if (${JSON.stringify(!!swap)}) {
        // 换上旧版 card-media，再重新载入卡片渲染器，让它用旧版。
        const key = require.resolve('../renderer/card-media');
        require.cache[key] = { id: key, filename: key, loaded: true, exports: require(${JSON.stringify(swap)}) };
        delete require.cache[require.resolve('../renderer/turn-card-renderer')];
      }
      const session = { id: 'perf', kind: 'claude', status: 'idle', cwd: ${JSON.stringify(project)} };
      const panel = document.createElement('div'); panel.className = 'msg-overlay';
      panel.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#fff;padding:24px 120px;overflow:auto';
      document.body.append(panel);
      const view = require('../renderer/turn-card-renderer').createTurnCardRenderer({ document, window, state: {}, root: panel, container: panel,
        getSessionContext: () => session, marked: require('marked').marked, DOMPurify: require('dompurify'),
        escapeHtml: s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        normalizeMarkdownPathBreaks: s => s, formatAbsoluteTime: () => '' });
      const answers = ${JSON.stringify(answers)};
      // 主线程卡顿：每 16 毫秒打一次点，记录两次之间最长的间隔；再加长任务观察。
      let maxGap = 0, last = performance.now(), longTotal = 0, longCount = 0;
      const tick = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last - 16); last = now; }, 16);
      const po = new PerformanceObserver(list => { for (const e of list.getEntries()) { longTotal += e.duration; longCount++; } });
      try { po.observe({ type: 'longtask', buffered: false }); } catch {}
      const t0 = performance.now();
      answers.forEach((text, i) => {
        view.mountSessionTurnCard(session.id, { id: 'u' + i, role: 'user', text: '下一步？' }, { container: panel });
        view.mountSessionTurnCard(session.id, { id: 'a' + i, role: 'assistant', text, phase: 'final_answer' }, { container: panel });
      });
      const mountMs = performance.now() - t0;
      panel.scrollTop = panel.scrollHeight;
      const visible = () => [...panel.querySelectorAll('.code-block-wrap[data-lang="mermaid"]')].filter(w => {
        const r = w.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
      let firstVisibleMs = null;
      const end = t0 + 8000;
      while (performance.now() < end) {
        await new Promise(r => setTimeout(r, 50));
        if (firstVisibleMs === null && visible().some(w => w.classList.contains('card-mermaid-rendered'))) firstVisibleMs = performance.now() - t0;
      }
      clearInterval(tick); po.disconnect();
      const all = panel.querySelectorAll('.code-block-wrap[data-lang="mermaid"]');
      const drawn = panel.querySelectorAll('.card-mermaid-rendered').length;
      const visibleNow = visible();
      return { cards: answers.length, mountMs: Math.round(mountMs), maxMainThreadStallMs: Math.round(maxGap),
        longTaskMs: Math.round(longTotal), longTaskCount: longCount, drawn, totalDiagrams: all.length,
        visibleDiagrams: visibleNow.length, visibleDrawn: visibleNow.filter(w => w.classList.contains('card-mermaid-rendered')).length,
        firstVisibleMs: firstVisibleMs === null ? null : Math.round(firstVisibleMs),
        frames: document.querySelectorAll('iframe.card-mermaid-sandbox').length };
    })()`, { timeoutMs: 60000 });
    result.tag = tag;
    const { data } = await c.send('Page.captureScreenshot', { format: 'png' });
    result.shot = path.join(out, `20261120-renderG-perf-${tag}.png`); fs.writeFileSync(result.shot, Buffer.from(data, 'base64'));
  } finally {
    if (result) fs.writeFileSync(path.join(out, `20261120-renderG-perf-${tag}.json`), JSON.stringify(result, null, 2));
    if (c) c.close?.();
    if (hub) await gracefulQuit(hub);
    if (swap) try { fs.rmSync(swap, { force: true }); } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  console.log(JSON.stringify(result, null, 1));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
