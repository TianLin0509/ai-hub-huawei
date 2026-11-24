'use strict';
// 会话卡片里的图片与 mermaid 图（反馈 24156241）：地址分类、本地图片限工作目录、mermaid 尺寸、网络图片取回。
const test = require('node:test');
const assert = require('node:assert/strict');
const { holdEventLoop } = require('./helpers/hold-event-loop');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyImageSource, resolveLocalImage, sizeMermaidSvg, mermaidRisk } = require('../renderer/card-media.js');
const { EventEmitter } = require('node:events');
const { fetchRemoteImage, isPrivateAddress, createElectronSingleHopFetch } = require('../core/remote-image-fetch.js');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a6a40000000049454e44ae426082', 'hex');

test('图片地址分类：本地、data、https；http 与其他协议不显示', () => {
  assert.equal(classifyImageSource('D:\\work\\a.png').kind, 'local');
  assert.equal(classifyImageSource('out/chart.png').kind, 'local');
  assert.equal(classifyImageSource('file:///D:/work/a.png').path, path.normalize('D:/work/a.png'));
  assert.equal(classifyImageSource('data:image/png;base64,AAAA').kind, 'data');
  assert.equal(classifyImageSource('https://example.com/x.png').host, 'example.com');
  assert.equal(classifyImageSource('http://example.com/x.png').kind, 'invalid');
  assert.equal(classifyImageSource('javascript:alert(1)').kind, 'invalid');
  assert.equal(classifyImageSource('data:text/html,<b>').kind, 'invalid');
  assert.equal(classifyImageSource('').kind, 'invalid');
});

test('本地图片只放行会话工作目录里的图片文件', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'card-media-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'proj'), outside = path.join(root, 'secret');
  fs.mkdirSync(path.join(cwd, 'out'), { recursive: true }); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(cwd, 'out', 'chart.png'), PNG);
  fs.writeFileSync(path.join(outside, 'leak.png'), PNG);
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'x');

  const rel = resolveLocalImage('out/chart.png', cwd);
  assert.equal(rel.ok, true);
  assert.match(rel.src, /^file:\/\/\/.*chart\.png\?v=\d+$/);
  assert.equal(resolveLocalImage(path.join(cwd, 'out', 'chart.png'), cwd).ok, true);
  assert.equal(resolveLocalImage(path.join(outside, 'leak.png'), cwd).ok, false);
  assert.equal(resolveLocalImage('../secret/leak.png', cwd).ok, false);
  assert.match(resolveLocalImage('notes.txt', cwd).reason, /不是图片/);
  assert.match(resolveLocalImage('out/none.png', cwd).reason, /不存在/);
  assert.match(resolveLocalImage('\\\\server\\share\\a.png', cwd).reason, /网络共享/);
  assert.match(resolveLocalImage('out/chart.png', null).reason, /没有工作目录/);
  // 工作目录里的目录链接指向外面：按真实路径判断，挡住。
  const link = path.join(cwd, 'linked');
  try { fs.symlinkSync(outside, link, 'junction'); } catch { t.diagnostic('无法建目录链接，跳过链接用例'); return; }
  assert.match(resolveLocalImage('linked/leak.png', cwd).reason, /目录链接/);
});

test('工作目录外的图片一次都不碰文件系统；路径上的链接不解析', () => {
  const calls = [];
  const touch = name => p => { calls.push(name + ':' + p); return p; };
  const fakeFs = { realpathSync: Object.assign(touch('real'), { native: touch('real') }),
    lstatSync: p => { calls.push('lstat:' + p); return { isSymbolicLink: () => /link$/.test(p), isFile: () => true, size: 1, mtimeMs: 1 }; } };
  assert.equal(resolveLocalImage('C:\\Windows\\a.png', 'D:\\proj', fakeFs).ok, false);
  assert.equal(resolveLocalImage('..\\other\\a.png', 'D:\\proj', fakeFs).ok, false);
  assert.deepEqual(calls, []);
  assert.match(resolveLocalImage('sub\\link\\a.png', 'D:\\proj', fakeFs).reason, /目录链接/);
  assert.deepEqual(calls, ['real:D:\\proj', 'lstat:D:\\proj\\sub', 'lstat:D:\\proj\\sub\\link']);
  const uncFs = { ...fakeFs, realpathSync: Object.assign(() => '\\\\nas\\share', { native: () => '\\\\nas\\share' }) };
  assert.match(resolveLocalImage('a.png', 'D:\\proj', uncFs).reason, /网络共享/);
  assert.match(resolveLocalImage('a.png:stream', 'D:\\proj', fakeFs).reason, /不是图片/);
  assert.match(resolveLocalImage('\\\\?\\C:\\a.png', 'D:\\proj', fakeFs).reason, /网络共享/);
});

test('mermaid 源码引用图片、外部样式就不画', () => {
  assert.match(mermaidRisk('flowchart TD\n  A@{ img: "file:///C:/x.png", label: "a" }'), /不画/);
  assert.match(mermaidRisk('flowchart TD\n  A["<img src=x>"]'), /不画/);
  assert.match(mermaidRisk('%%{init: {"themeCSS": ".node{background:url(file:///C:/x.png)}"}}%%\nflowchart TD\n A'), /不画/);
  assert.equal(mermaidRisk('flowchart LR\n  A[src 目录] --> B[href 说明]\n  B --> C{需要画图?}'), '');
  assert.equal(mermaidRisk('sequenceDiagram\n  U->>H: 发送问题'), '');
});

test('mermaid SVG 按 viewBox 写回像素宽高', () => {
  const out = sizeMermaidSvg('<svg id="m" width="100%" style="max-width: 320.5px;" viewBox="0 0 320.5 140" xmlns="http://www.w3.org/2000/svg"><g/></svg>');
  assert.equal(out.width, 321); assert.equal(out.height, 140);
  assert.match(out.svg, /^<svg id="m" viewBox="0 0 320.5 140" xmlns="http:\/\/www.w3.org\/2000\/svg" width="321" height="140">/);
  assert.equal(sizeMermaidSvg('<svg></svg>').width, 0);
});

test('卡片 Markdown：图片输出占位，文字仍是原地址；链接里的图片不嵌套；alt 不能注入属性', t => {
  let marked;
  try { ({ marked } = require('marked')); } catch { t.skip('没有 marked'); return; }
  const { parseCardMarkdown } = require('../renderer/card-markdown.js');
  const html = parseCardMarkdown(marked, '看图 ![趋势](out/chart.png) 和 ![](https://e.com/a.png "t")');
  assert.match(html, /<span class="card-md-image" data-md-image-src="out\/chart.png" data-md-image-alt="趋势"><a href="out\/chart.png">out\/chart.png<\/a><\/span>/);
  assert.match(html, /data-md-image-src="https:\/\/e.com\/a.png"/);
  const inLink = parseCardMarkdown(marked, '[![x](a.png)](https://e.com)');
  assert.doesNotMatch(inLink, /card-md-image/);
  const evil = parseCardMarkdown(marked, '![a" onerror="x](b.png)');
  assert.doesNotMatch(evil, /" onerror="/);
});

function fakeResponse({ status = 200, type = 'image/png', body = PNG, url = 'https://e.com/a.png', length } = {}) {
  return { ok: status >= 200 && status < 300, status, url,
    headers: { get: k => (k === 'content-type' ? type : k === 'content-length' ? (length ?? String(body.length)) : null) },
    arrayBuffer: async () => body };
}

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('网络图片：只取 https 图片，限大小，结果是 data: 地址，不带 Cookie', async () => {
  const opts = extra => ({ lookup: publicLookup, ...extra });
  assert.match((await fetchRemoteImage('http://e.com/a.png', opts({ fetch: async () => fakeResponse() }))).reason, /https/);
  assert.match((await fetchRemoteImage('https://e.com/a', opts({ fetch: async () => fakeResponse({ type: 'text/html' }) }))).reason, /不是图片/);
  assert.match((await fetchRemoteImage('https://e.com/a', opts({ fetch: async () => fakeResponse({ status: 404 }) }))).reason, /404/);
  assert.match((await fetchRemoteImage('https://e.com/a', opts({ maxBytes: 10, fetch: async () => fakeResponse({ length: '0' }) }))).reason, /10 MB/);
  let init;
  const ok = await fetchRemoteImage('https://e.com/a.png', opts({ fetch: async (u, i) => { init = i; return fakeResponse(); } }));
  assert.equal(ok.ok, true);
  assert.equal(ok.dataUrl, 'data:image/png;base64,' + PNG.toString('base64'));
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'manual');
  const err = await fetchRemoteImage('https://e.com/a.png', opts({ fetch: async () => { throw new Error('ECONNRESET'); } }));
  assert.match(err.reason, /ECONNRESET/);
});

test('网络图片：重定向逐跳检查，http 与内网那一跳不发请求', async () => {
  const redirect = location => ({ ok: false, status: 302, headers: { get: k => (k === 'location' ? location : null) } });
  const seen = [];
  const chain = { 'https://e.com/a.png': redirect('https://cdn.e.com/b.png'), 'https://cdn.e.com/b.png': fakeResponse() };
  const ok = await fetchRemoteImage('https://e.com/a.png', { lookup: publicLookup, fetch: async u => { seen.push(u); return chain[u]; } });
  assert.equal(ok.ok, true); assert.deepEqual(seen, ['https://e.com/a.png', 'https://cdn.e.com/b.png']);

  seen.length = 0;
  const toHttp = await fetchRemoteImage('https://e.com/a.png', { lookup: publicLookup, fetch: async u => { seen.push(u); return redirect('http://e.com/b.png'); } });
  assert.match(toHttp.reason, /非 https/); assert.deepEqual(seen, ['https://e.com/a.png']);

  seen.length = 0;
  const toLan = await fetchRemoteImage('https://e.com/a.png', { lookup: publicLookup, fetch: async u => { seen.push(u); return redirect('https://192.168.1.5/x.png'); } });
  assert.match(toLan.reason, /内网/); assert.deepEqual(seen, ['https://e.com/a.png']);

  const never = async () => { throw new Error('不应发请求'); };
  assert.match((await fetchRemoteImage('https://127.0.0.1/a.png', { lookup: publicLookup, fetch: never })).reason, /内网/);
  assert.match((await fetchRemoteImage('https://localhost/a.png', { lookup: publicLookup, fetch: never })).reason, /本机/);
  assert.match((await fetchRemoteImage('https://intra.corp/a.png', { lookup: async () => [{ address: '10.1.2.3', family: 4 }], fetch: never })).reason, /内网/);
  // 解析不了（公司网经代理出网）照常取。
  assert.equal((await fetchRemoteImage('https://e.com/a.png', { lookup: async () => { throw new Error('ENOTFOUND'); }, fetch: async () => fakeResponse() })).ok, true);
  const loop = await fetchRemoteImage('https://e.com/a.png', { lookup: publicLookup, fetch: async () => redirect('https://e.com/a.png') });
  assert.match(loop.reason, /跳转太多/);
});

test('内网地址判断', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.3.4', '192.168.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:192.168.1.1',
    '::ffff:7f00:1', '::ffff:c0a8:101', '::7f00:1']) assert.equal(isPrivateAddress(ip), true, ip);
  assert.equal(isPrivateAddress(new URL('https://[::ffff:127.0.0.1]/').hostname), true);
  for (const ip of ['8.8.8.8', '93.184.216.34', '198.18.0.5', '2400:3200::1', '172.32.0.1']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('接线：卡片后处理调用 card-media，页面图片安全策略不放开网络地址，mermaid 离线打包', () => {
  const root = path.join(__dirname, '..');
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'turn-card-renderer.js'), 'utf8');
  assert.match(renderer, /cardMedia\.processCard\(card, \{ sessionId \}\)/);
  assert.match(renderer, /if \(cardMedia\.onClick\(e\)\) return;/);
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  assert.match(html, /img-src 'self' file: data:;/);
  assert.match(html, /styles\/card-media\.css/);
  assert.ok(fs.statSync(path.join(root, 'renderer', 'vendor', 'mermaid', 'mermaid.min.js')).size > 1e6);
  const main = fs.readFileSync(path.join(root, 'main', 'ipc', 'app-utility-handlers.js'), 'utf8');
  assert.match(main, /'card-media:fetch-remote-image'/);
});

// 假的 Electron net：记录 abort，按脚本发 redirect / response / data / end。
function fakeNet(script) {
  const made = [];
  return { made, request(opts) {
    const req = new EventEmitter(); req.opts = opts; req.aborted = false;
    req.abort = () => { req.aborted = true; }; req.end = () => setImmediate(() => script(req));
    made.push(req); return req;
  } };
}
function fakeIncoming(status, headers) { const r = new EventEmitter(); r.statusCode = status; r.headers = headers; return r; }

test('Electron 一跳 fetch：跳转返回 3xx 与 location，不带 Cookie', async () => {
  const netApi = fakeNet(req => req.emit('redirect', 302, 'GET', 'https://cdn.e.com/b.png'));
  const res = await createElectronSingleHopFetch(netApi)('https://e.com/a.png', {});
  assert.equal(res.status, 302); assert.equal(res.headers.get('Location'), 'https://cdn.e.com/b.png');
  assert.equal(netApi.made[0].aborted, true);
  assert.equal(netApi.made[0].opts.redirect, 'manual'); assert.equal(netApi.made[0].opts.useSessionCookies, false);
});

test('Electron 一跳 fetch：超时时正在读的正文立即失败，请求被中止', async t => {
  holdEventLoop(t);
  const netApi = fakeNet(req => {
    const res = fakeIncoming(200, { 'content-type': 'image/png' });
    req.emit('response', res); res.emit('data', Buffer.from([1, 2, 3])); // 之后再也不来数据
  });
  const started = Date.now();
  const out = await fetchRemoteImage('https://e.com/a.png', { lookup: publicLookup, timeoutMs: 200, fetch: createElectronSingleHopFetch(netApi) });
  assert.match(out.reason, /超时/); assert.ok(Date.now() - started < 3000);
  assert.equal(netApi.made[0].aborted, true);
});

test('Electron 一跳 fetch：返回的不是图片时请求被中止', async () => {
  const netApi = fakeNet(req => req.emit('response', fakeIncoming(200, { 'content-type': 'text/html' })));
  const out = await fetchRemoteImage('https://e.com/a', { lookup: publicLookup, fetch: createElectronSingleHopFetch(netApi) });
  assert.match(out.reason, /不是图片/); assert.equal(netApi.made[0].aborted, true);
});

test('Electron 一跳 fetch：正常读完正文', async () => {
  const netApi = fakeNet(req => {
    const res = fakeIncoming(200, { 'content-type': ['image/png'] });
    req.emit('response', res); res.emit('data', PNG.subarray(0, 10)); setImmediate(() => { res.emit('data', PNG.subarray(10)); res.emit('end'); });
  });
  const out = await fetchRemoteImage('https://e.com/a.png', { lookup: publicLookup, fetch: createElectronSingleHopFetch(netApi) });
  assert.equal(out.ok, true); assert.equal(out.bytes, PNG.length);
});

// 最小假 DOM：只够 card-media 的 mermaid 排队与回退路径用。
function fakeNode(tag = 'div') {
  const kids = [];
  const node = { tagName: tag, dataset: {}, style: {}, isConnected: true, textContent: '', kids,
    classList: { s: new Set(), add(c) { this.s.add(c); }, contains(c) { return this.s.has(c); } },
    appendChild(c) { kids.push(c); return c; }, append(...c) { kids.push(...c); }, insertBefore(c) { kids.unshift(c); },
    remove() {}, addEventListener() {}, setAttribute() {},
    querySelector(sel) { return kids.find(k => sel === '.' + k.className) || null; } };
  return node;
}
function mermaidWrap(source) {
  const wrap = fakeNode(), pre = fakeNode('pre'), code = { textContent: source };
  const base = wrap.querySelector;
  wrap.querySelector = sel => (sel === 'pre code' ? code : sel === 'pre' ? pre : base(sel));
  return wrap;
}

test('mermaid 懒渲染：只画当前卡片里进入可视区的图，屏幕外、已脱离页面的不画', async () => {
  const { createCardMedia } = require('../renderer/card-media.js');
  let observed = [], callback = null;
  class FakeIO { constructor(cb) { callback = cb; } observe(el) { observed.push(el); } unobserve(el) { observed = observed.filter(x => x !== el); } }
  const doc = { createElement: tag => fakeNode(tag), querySelectorAll: () => { throw new Error('不该扫整页'); } };
  const media = createCardMedia({ document: doc, window: { IntersectionObserver: FakeIO } });
  // 引用图片的源码在第一道检查就失败，不会去建画图框架，正好用来观察排队。
  const risky = n => 'flowchart TD\n  A' + n + '@{ img: "x.png" }';
  const [a, b, c] = [mermaidWrap(risky(1)), mermaidWrap(risky(2)), mermaidWrap(risky(3))];
  const card = { querySelectorAll: sel => (/mermaid/.test(sel) ? [a, b, c].filter(w => !w.dataset.mermaidState) : []) };
  media.processCard(card, {});
  assert.equal(observed.length, 3, '三张图都交给可视区观察');
  assert.equal(a.dataset.mermaidState, undefined, '挂上卡片时一张都不立刻画');
  callback([{ target: a, isIntersecting: true }, { target: c, isIntersecting: true }, { target: b, isIntersecting: false }]);
  c.isConnected = false; // 流式重画：旧图块脱离页面
  await new Promise(r => setTimeout(r, 750));
  await new Promise(r => setImmediate(r));
  assert.equal(a.dataset.mermaidState, 'failed', '可视区里的图画了（这里按规则回退成代码块）');
  assert.match(a.kids[0].textContent, /为安全起见不画/);
  assert.equal(b.dataset.mermaidState, undefined, '屏幕外的不画');
  assert.equal(c.dataset.mermaidState, undefined, '脱离页面的不画');
  assert.deepEqual(observed, [b], '画过的、脱离页面的都不再观察');
  callback([{ target: b, isIntersecting: true }]);
  await new Promise(r => setTimeout(r, 750));
  await new Promise(r => setImmediate(r));
  assert.equal(b.dataset.mermaidState, 'failed', '滚进可视区后再画');
  assert.equal(media._mermaidStats().drawing, false);
});

test('mermaid 画图框架：sandbox 只给 allow-scripts，不给同源；源码与 SVG 走 postMessage', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'card-media.js'), 'utf8');
  assert.match(src, /setAttribute\('sandbox', 'allow-scripts'\)/);
  assert.doesNotMatch(src, /allow-same-origin/);
  assert.doesNotMatch(src, /contentWindow\.(?:mermaid|document)/, '主页面不直接摸框架内部');
  assert.match(src, /event\.source !== mermaidFrame\.contentWindow/, '只认画图框架发来的消息');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'card-mermaid-frame.html'), 'utf8'), /default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:/);
});

test('会议室：内嵌 data: 图片恢复成可点开的缩略图按钮，其余图片保持原地址', () => {
  const { restoreDataImageThumbs } = require('../renderer/card-markdown.js');
  const made = [];
  const holder = (src, alt) => ({ attrs: { 'data-md-image-src': src, 'data-md-image-alt': alt }, getAttribute(k) { return this.attrs[k]; },
    replaceWith(n) { this.replaced = n; } });
  const h1 = holder('data:image/png;base64,AAAA', '流程图'), h2 = holder('out/a.png', ''), h3 = holder('data:text/html,x', '');
  const doc = { createElement: tag => { const n = { tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }; made.push(n); return n; } };
  restoreDataImageThumbs({ ownerDocument: doc, querySelectorAll: () => [h1, h2, h3] });
  assert.equal(made.length, 1);
  assert.equal(h1.replaced.className, 'conversation-image-thumb');
  assert.equal(h1.replaced.attrs['data-action'], 'card-open-image');
  assert.equal(h1.replaced.attrs['data-image-src'], 'data:image/png;base64,AAAA');
  assert.equal(h1.replaced.textContent, '流程图');
  assert.equal(h2.replaced, undefined); assert.equal(h3.replaced, undefined);
  const meeting = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf8');
  assert.match(meeting, /cardMarkdown\.restoreDataImageThumbs\(wrapper\)/);
});
