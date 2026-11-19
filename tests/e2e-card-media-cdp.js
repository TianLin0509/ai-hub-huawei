'use strict';
// 会话卡片里的图片与 mermaid 图（反馈 24156241）：隔离 Hub、真实 Electron 页面、真实 marked/DOMPurify/mermaid。
// 合成一条回答（本地图、工作目录外的图、网络图、两张 mermaid、一张写错的 mermaid），
// 检查显示、放大、看源码、复制源码、整条复制仍带源码，1440 宽截图。不连任何 AI 服务。
// 用法：node tests/e2e-card-media-cdp.js [--before <基线仓库目录>] [--out <截图目录>]
const fs = require('fs'), os = require('os'), net = require('net'), path = require('path');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const beforeRoot = arg('--before');
const out = path.resolve(arg('--out') || 'artifacts/card-media-gui');
const tag = beforeRoot ? 'before' : 'after';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function chartSvg() {
  const bars = [62, 88, 120, 96, 140].map((h, i) => `<rect x="${40 + i * 70}" y="${180 - h}" width="44" height="${h}" fill="#3478f6"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="220"><rect width="420" height="220" fill="#f4f6fa"/>${bars}`
    + '<line x1="30" y1="180" x2="400" y2="180" stroke="#333"/><text x="40" y="205" font-size="14" fill="#333">周一 至 周五 吞吐量</text></svg>';
}

const ANSWER = [
  '## 吞吐量分析结果',
  '本地生成的柱状图（工作目录内，直接显示）：',
  '',
  '![五天吞吐量](out/chart.svg)',
  '',
  '工作目录外的文件不直接显示：![外部](OUTSIDE_PATH)',
  '',
  '网络图片点一下才加载：![网络图](https://www.baidu.com/favicon.ico)',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[用户提问] --> B{需要画图?}',
  '  B -- 是 --> C[生成 mermaid]',
  '  B -- 否 --> D[纯文字回答]',
  '  C --> E[Hub 渲染成图]',
  '```',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  participant U as 用户',
  '  participant H as Hub',
  '  U->>H: 发送问题',
  '  H-->>U: 回答 + 图',
  '```',
  '',
  '写错的图表回退成代码块：',
  '```mermaid',
  'flowchart LR',
  '  A -->',
  '```',
  '',
  '引用本地图片的图表不画（防绕过工作目录限制）：',
  '```mermaid',
  'flowchart TD',
  '  A@{ img: "OUTSIDE_URL", label: "x", pos: "t", h: 60 }',
  '```',
].join('\n');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-card-media-'));
  const project = path.join(root, 'project'), outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(project, 'out'), { recursive: true }); fs.mkdirSync(outside, { recursive: true }); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(project, 'out', 'chart.svg'), chartSvg());
  fs.writeFileSync(path.join(outside, 'secret.svg'), chartSvg());
  const report = { tag, providerNetworkTested: false, checks: [] };
  const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail }); if (!beforeRoot) assert.ok(ok, name + (detail ? '：' + JSON.stringify(detail) : '')); };
  let hub, c;
  try {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), label: 'card-media-' + tag,
      windowMode: 'hidden', ...(beforeRoot ? { entryPath: path.resolve(beforeRoot), cwd: path.resolve(beforeRoot) } : {}) });
    for (let n = 0; n < 40 && !c; n++) {
      try { c = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\/]index\.html/i.test(t.url || '')); }
      catch { await sleep(500); }
    }
    for (let n = 0; n < 150; n++) { if (await c.eval('!!document.body && document.readyState === "complete" && !!document.getElementById("msg-overlay")')) break; await sleep(100); }
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const answer = ANSWER.replace('OUTSIDE_PATH', path.join(outside, 'secret.svg').replace(/\\/g, '/'))
      .replace('OUTSIDE_URL', require('url').pathToFileURL(path.join(outside, 'secret.svg')).href);
    await c.eval(`(() => {
      const session = { id: 'media-fixture', kind: 'claude', status: 'idle', cwd: ${JSON.stringify(project)} };
      const panel = document.createElement('div'); panel.id = 'media-test-panel'; panel.className = 'msg-overlay';
      panel.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:var(--bg-app,#fff);padding:24px 120px;overflow:auto';
      document.body.append(panel);
      const copied = window.__mediaCopied = [];
      const { marked } = require('marked');
      const view = require('../renderer/turn-card-renderer').createTurnCardRenderer({ document, window, state: {}, root: panel, container: panel,
        getSessionContext: () => session, marked, DOMPurify: require('dompurify'),
        escapeHtml: s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        normalizeMarkdownPathBreaks: s => s, formatAbsoluteTime: () => '',
        copyText: async text => { copied.push(text); return { ok: true }; } });
      window.__mediaView = view; window.__mediaPanel = panel;
      view.mountSessionTurnCard(session.id, { id: 'u1', role: 'user', text: '把这周吞吐量画个图，再画一下流程' }, { container: panel });
      view.mountSessionTurnCard(session.id, { id: 'a1', role: 'assistant', text: ${JSON.stringify(answer)}, phase: 'final_answer' }, { container: panel });
    })()`);
    let state = null;
    for (let n = 0; n < 100; n++) {
      // 长回答有一份「预览」副本（conversation-long-preview），只数正文那份。
      state = await c.eval(`(() => { const p = window.__mediaPanel; const q = sel => [...p.querySelectorAll(sel)].filter(e => !e.closest('.conversation-long-preview'));
        return { shown: q('.card-mermaid-rendered').length, failed: q('[data-mermaid-state="failed"]').length,
        pending: q('[data-mermaid-state="pending"]').length, notes: q('.card-mermaid-note').map(n => n.textContent.slice(0, 80)), lazy: window.__mediaView._cardMedia._mermaidStats?.(), scrollTop: p.scrollTop,
        images: q('.card-md-image').map(h => ({ state: h.dataset.mdImageState || '', text: h.textContent.trim().slice(0, 80),
          loaded: !!h.querySelector('img')?.naturalWidth })) }; })()`);
      if (beforeRoot || (state.shown >= 2 && state.failed >= 2 && state.images.some(i => i.loaded))) break;
      // 懒渲染：图进入可视区才画，慢慢往下滚，像人在读。
      await c.eval(`window.__mediaPanel.scrollTop += 250`);
      await sleep(200);
    }
    report.state = state;
    await sleep(300);
    const shot = async name => {
      const { data } = await c.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(out, `20261119-renderG-${tag}-${name}.png`); fs.writeFileSync(file, Buffer.from(data, 'base64')); return file;
    };
    report.shots = [await shot('card')];
    if (beforeRoot) return;

    check('两张 mermaid 画成图', state.shown === 2, state);
    check('写错的 mermaid 回退成代码块并说明', state.failed === 2
      && await c.eval(`(() => { const w = window.__mediaPanel.querySelector('[data-mermaid-state="failed"]');
        return w.querySelector('pre').style.display !== 'none' && /图表没画出来/.test(w.querySelector('.card-mermaid-note').textContent); })()`));
    const risky = await c.eval(`[...window.__mediaPanel.querySelectorAll('[data-mermaid-state="failed"] .card-mermaid-note')].at(-1).textContent`);
    check('引用图片的 mermaid 不画并说明', /为安全起见不画/.test(risky), risky);
    const leaked = await c.eval(`performance.getEntriesByType('resource').filter(e => /secret\\.svg/.test(e.name)).map(e => e.name)`);
    check('工作目录外的图片一次都没被加载', leaked.length === 0, leaked);
    const [local, blocked, remote] = state.images;
    check('工作目录内的本地图直接显示', local.state === 'shown' && local.loaded, local);
    check('工作目录外的图不显示并说明原因', blocked.state === 'blocked' && /工作目录/.test(blocked.text), blocked);
    check('网络图片先给加载按钮', remote.state === 'remote' && /显示网络图片（www\.baidu\.com）/.test(remote.text), remote);
    check('mermaid 图是白底 data:image/svg+xml', await c.eval(`(() => { const img = window.__mediaPanel.querySelector('.card-mermaid-img');
      return img.src.startsWith('data:image/svg+xml') && img.naturalWidth > 100; })()`));

    const click = async selector => {
      const point = await c.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: 'center' });
        const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
      await sleep(250);
    };
    await click('#media-test-panel .card-mermaid-rendered [data-action="card-mermaid-copy"]');
    check('复制源码拿到 mermaid 原文', await c.eval('window.__mediaCopied.at(-1)') === 'flowchart LR\n  A[用户提问] --> B{需要画图?}\n  B -- 是 --> C[生成 mermaid]\n  B -- 否 --> D[纯文字回答]\n  C --> E[Hub 渲染成图]');
    await click('#media-test-panel .card-mermaid-rendered [data-action="card-mermaid-source"]');
    check('看源码展开代码块', await c.eval(`document.querySelector('#media-test-panel .card-mermaid-rendered pre').style.display === ''`));
    report.shots.push(await shot('source'));
    await click('#media-test-panel .card-mermaid-rendered [data-action="card-mermaid-source"]');
    const copyAll = await c.eval(`require('../renderer/visible-card-text').copyableCardText(window.__mediaPanel.querySelector('.turn-card.assistant .turn-body, .turn-card:last-of-type .turn-body'))`);
    check('整条复制仍带 mermaid 源码、不带按钮字样', /flowchart LR/.test(copyAll) && !/复制源码|看源码/.test(copyAll), copyAll.slice(0, 200));

    await click('#media-test-panel .card-mermaid-rendered .card-mermaid-thumb');
    check('点图放大', await c.eval(`!!document.querySelector('dialog.card-media-dialog[open] .card-media-zoom-img')`));
    report.shots.push(await shot('zoom-mermaid'));
    await c.eval(`document.querySelector('dialog.card-media-dialog[open]').close()`);
    await click('#media-test-panel .card-md-image-thumb');
    check('本地图也能放大', await c.eval(`!!document.querySelector('dialog.card-media-dialog[open] .card-media-zoom-img')`));
    report.shots.push(await shot('zoom-image'));
    await c.eval(`document.querySelector('dialog.card-media-dialog[open]').close()`);

    // 同一回答再挂一次（模拟流式刷新整张卡）：已画过的图直接贴回，不再等。
    const remount = await c.eval(`(async () => { const p = window.__mediaPanel; const card = p.querySelector('.turn-card:last-of-type');
      const turn = { id: 'a1', role: 'assistant', text: ${JSON.stringify(answer)} + '\\n\\n补一句', phase: 'final_answer' };
      window.__mediaView.mountSessionTurnCard('media-fixture', turn, { container: p });
      await new Promise(r => setTimeout(r, 50)); return p.querySelectorAll('.card-mermaid-rendered').length; })()`);
    check('刷新卡片时已画的图立刻贴回', remount >= 2, remount);

    // 第二道防线：跳过关键字检查直接画引用本地图片的图，沙箱框架照样拦下（不透明来源读不到本地文件，请求都不发；安全策略再兜一层）。
    // 画图框架是沙箱（不透明来源），主页面摸不到它的内部。
    const url = require('url').pathToFileURL(path.join(outside, 'secret.svg')).href;
    await c.eval(`window.__mediaView._cardMedia._drawMermaidUnchecked(['flowchart TD', '  A --> B'].join(String.fromCharCode(10)))`);
    const frameInfo = await c.eval(`(() => { const f = document.querySelector('iframe.card-mermaid-sandbox');
      let docAccess; try { docAccess = typeof f.contentWindow.document.title; } catch (e) { docAccess = 'blocked:' + e.name; }
      return { sandbox: f.getAttribute('sandbox'), docAccess, count: document.querySelectorAll('iframe.card-mermaid-sandbox').length }; })()`);
    check('画图框架是 sandbox="allow-scripts"，主页面读不到框架内部', frameInfo.sandbox === 'allow-scripts' && /^blocked:/.test(frameInfo.docAccess) && frameInfo.count === 1, frameInfo);
    // 沙箱框架跑在独立进程里（CDP 里是单独的 iframe 目标），直接连上它在框架自己的页面里检查。
    let fc = null;
    for (let n = 0; n < 20 && !fc; n++) {
      try { fc = await connectFirstPage(hub, t => t.type === 'iframe' && /card-mermaid-frame\.html/.test(t.url || ''), { waitMainMs: 0 }); }
      catch { await sleep(250); }
    }
    assert.ok(fc, '找不到画图框架的调试目标');
    const inFrame = expression => fc.eval(expression);
    const probe = await inFrame(`({ require: typeof require, process: typeof process, mermaid: typeof mermaid, origin: self.origin,
      parentRequire: (() => { try { return typeof parent.require; } catch (e) { return 'blocked:' + e.name; } })(),
      parentDoc: (() => { try { return typeof parent.document.title; } catch (e) { return 'blocked:' + e.name; } })() })`);
    report.frameProbe = probe;
    check('框架里没有 require，parent.require、parent.document 都拿不到', probe.mermaid === 'object' && probe.require === 'undefined'
      && probe.process === 'undefined' && probe.origin === 'null' && /^blocked:/.test(probe.parentRequire) && /^blocked:/.test(probe.parentDoc), probe);
    await inFrame(`(() => { window.__blocked = []; document.addEventListener('securitypolicyviolation', e => window.__blocked.push(e.violatedDirective)); return true; })()`);
    const drawn = await c.eval(`window.__mediaView._cardMedia._drawMermaidUnchecked(['flowchart TD', '  A@{ img: "${url}", label: "x", pos: "t", h: 60 }', '  A --> B[终点]'].join(String.fromCharCode(10))).then(() => 'ok', e => 'error:' + e.message)`);
    const imgInFrame = await inFrame(`new Promise(r => { const i = new Image(); i.onload = () => r('load'); i.onerror = () => r('error'); i.src = ${JSON.stringify(url + '?f=1')}; setTimeout(() => r('timeout'), 3000); })`);
    await sleep(300);
    const sandbox = { drawn, imgInFrame, blocked: await inFrame('window.__blocked'),
      inParent: await c.eval(`new Promise(r => { const i = new Image(); i.onload = () => r('load'); i.onerror = () => r('error'); i.src = ${JSON.stringify(url + '?p=1')}; setTimeout(() => r('timeout'), 3000); })`) };
    report.sandbox = sandbox;
    fc.close?.();
    check('小框架里画图碰不到本地文件（安全策略拦下，主页面对照能加载）',
      sandbox.imgInFrame === 'error' && sandbox.inParent === 'load'
      && (sandbox.blocked.includes('img-src') || /^error:/.test(sandbox.drawn)), sandbox);

    // 群聊会议室：用会议室真实的 Markdown 渲染，内嵌 data: 图片仍是可点开的缩略图按钮，点了能看图。
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    const meeting = await c.eval(`(() => { if (typeof window.__mrRenderMarkdown !== 'function') return { missing: true };
      const box = document.createElement('div'); box.id = 'mr-image-test'; box.style.cssText = 'position:fixed;left:20px;top:20px;z-index:2147483001;background:#fff;padding:8px';
      box.innerHTML = window.__mrRenderMarkdown('会议室里的图：![流程图](${png})'); document.body.append(box);
      const b = box.querySelector('button.conversation-image-thumb[data-action="card-open-image"]');
      return { button: !!b, text: b?.textContent, src: (b?.dataset.imageSrc || '').slice(0, 22) }; })()`);
    check('会议室内嵌图片保持可点开的缩略图按钮', meeting.button && meeting.text === '流程图' && meeting.src === 'data:image/png;base64,', meeting);
    if (meeting.button) {
      await click('#mr-image-test button.conversation-image-thumb');
      const opened = await c.eval(`(() => { const d = [...document.querySelectorAll('dialog[open]')].at(-1); const img = d?.querySelector('img');
        const r = { open: !!d, img: !!img, src: (img?.src || '').slice(0, 22) }; d?.close(); document.getElementById('mr-image-test')?.remove(); return r; })()`);
      check('会议室缩略图点开能看图', opened.open && opened.img && opened.src === 'data:image/png;base64,', opened);
    }

    // 网络图片：经主进程取回（需要能上网；失败时如实记录，不判失败）。
    await click('#media-test-panel [data-action="card-media-load-remote"]');
    let remoteState = '';
    for (let n = 0; n < 60; n++) {
      remoteState = await c.eval(`(() => { const h = [...window.__mediaPanel.querySelectorAll('.card-md-image')].find(x => /baidu/.test(x.dataset.mdImageSrc));
        return h.dataset.mdImageState + '|' + h.textContent.trim().slice(0, 60) + '|' + !!h.querySelector('img')?.naturalWidth; })()`);
      if (!/^loading/.test(remoteState) && !/^shown\|.*\|false$/.test(remoteState)) break; await sleep(250);
    }
    report.remote = remoteState;
    report.checks.push({ name: '网络图片点击后加载（依赖外网，仅记录）', ok: /^shown\|.*\|true$/.test(remoteState), detail: remoteState });
    const httpBlocked = await c.eval(`require('electron').ipcRenderer.invoke('card-media:fetch-remote-image', 'http://www.baidu.com/favicon.ico')`);
    check('主进程只取 https 图片', httpBlocked.ok === false && /https/.test(httpBlocked.reason), httpBlocked);
    const lanBlocked = await c.eval(`require('electron').ipcRenderer.invoke('card-media:fetch-remote-image', 'https://127.0.0.1:9/x.png')`);
    check('主进程不取本机/内网图片', lanBlocked.ok === false && /内网/.test(lanBlocked.reason), lanBlocked);
    // 会跳转的网址（逐跳自己跟）：依赖外网，仅记录。
    const redirected = await c.eval(`require('electron').ipcRenderer.invoke('card-media:fetch-remote-image', 'https://baidu.com/favicon.ico').then(r => ({ ok: r.ok, reason: r.reason, bytes: r.bytes }))`);
    report.redirected = redirected;
    report.checks.push({ name: '会跳转的网络图片（依赖外网，仅记录）', ok: !!redirected.ok, detail: redirected });
    report.shots.push(await shot('remote'));
  } finally {
    fs.writeFileSync(path.join(out, `20261119-renderG-${tag}-report.json`), JSON.stringify(report, null, 2));
    if (c) c.close?.();
    if (hub) await gracefulQuit(hub);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  console.log(JSON.stringify({ tag, checks: report.checks.map(x => (x.ok ? 'PASS ' : 'FAIL ') + x.name), shots: report.shots }, null, 1));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
