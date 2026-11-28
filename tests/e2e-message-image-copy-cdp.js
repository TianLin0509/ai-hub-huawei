'use strict';

// 长消息悬停复制、卡片与长消息「复制为图片」：隔离实例真实点击，深浅两套主题各测一遍，图片落盘供目检。
// 用法：node tests/e2e-message-image-copy-cdp.js [输出目录]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = JSON.stringify;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-image-copy-'));
const out = path.resolve(process.argv[2] || path.join('output', '20261128-card-image-copy-claude1'));
fs.mkdirSync(out, { recursive: true });

const para = '截断问题解决了：新开的会话里，说明已经完整显示，入口现在有规则和清单两道保险。这一段用来把消息撑成长消息，验证悬停复制只取这一块。';
const longText = ['📌 **长消息测试：复制只取这一块**', '', '## 做了什么', '',
  ...Array.from({ length: 8 }, (_, i) => `${i + 1}. **第 ${i + 1} 项**：${para}`), '',
  '| 项目 | 结果 |', '| --- | --- |', '| 单测 | 7 项通过 |', '| 界面 | 深浅色均测 |', '',
  '```js', 'function hello(name) {', '  return `你好，${name}`;', '}', '```', '',
  ...Array.from({ length: 16 }, () => para)].join('\n');

let hub, c;
async function until(expr, ms = 15000, debug = '') {
  for (const t = Date.now(); Date.now() - t < ms;) { if (await c.eval(expr)) return; await sleep(100); }
  throw new Error('timeout: ' + expr + (debug ? ' | ' + j(await c.eval(debug)) : ''));
}
async function point(selector, hover = false) {
  const p = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:Math.min(r.y+r.height/2,r.y+60),w:r.width,h:r.height}})()`);
  if (hover) await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  return p;
}
async function click(selector) {
  await c.eval(`document.querySelector(${j(selector)}).scrollIntoView({block:'nearest'})`); await sleep(120);
  const p = await point(selector);
  const hit = await c.eval(`(()=>{const e=document.elementFromPoint(${p.x},${p.y});return e?(e.outerHTML||'').slice(0,160):null})()`);
  if (process.env.E2E_DEBUG) console.log('click', selector, j(p), hit);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
}
async function readImage() {
  return c.eval(`(()=>{const img=require('electron').clipboard.readImage();return img.isEmpty()?null:{size:img.getSize(),data:img.toDataURL()}})()`);
}
async function shot(file) {
  const res = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, file), Buffer.from(res.data, 'base64'));
}
function saveDataUrl(file, url) { fs.writeFileSync(path.join(out, file), Buffer.from(url.split(',')[1], 'base64')); }

async function main() {
  const evidence = { out, themes: {} };
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port, label: 'image-copy', windowMode: 'background', extraEnv: {
    CLAUDE_HUB_E2E: '1', CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude') } });
  c = await connectFirstPage(hub);
  // 不用 Emulation 改视口：窗口截图按真实窗口取像素，改了视口会和截图区域错位。
  await until('!!window.__hubE2E');
  await c.eval(`(()=>{
    window.__hubE2E.cardQuestionNavigator.mountFixture({sessionId:'image-copy-fixture',count:2,clear:true});
    window._mountSessionTurnCard('image-copy-fixture',{id:'long-answer',role:'assistant',kind:'codex',text:${j(longText)},ts:Date.now()+50},{kind:'codex'});
  })()`);
  await until(`!!document.querySelector('.turn-card[data-turn-id="long-answer"] .conversation-long-frame')`);
  for (const theme of ['dark', 'claude']) {
    const ev = evidence.themes[theme] = {};
    await c.eval(`document.documentElement.dataset.theme=${j(theme)}`);
    await sleep(200);
    const frame = '.turn-card[data-turn-id="long-answer"] .conversation-long-frame';
    await c.eval(`document.querySelector(${j(frame)}).scrollIntoView({block:'start'})`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await sleep(300);
    // 1) 悬停出按钮
    const before = await c.eval(`getComputedStyle(document.querySelector(${j(frame + ' > .conversation-long-actions')})).opacity`);
    await point(frame, true); await sleep(250);
    const after = await c.eval(`getComputedStyle(document.querySelector(${j(frame + ' > .conversation-long-actions')})).opacity`);
    ev.hoverOpacity = [before, after];
    ev.hoverDebug = await c.eval(`(()=>{const f=document.querySelector(${j(frame)});const r=f.getBoundingClientRect();const e=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {hover:f.matches(':hover'),hit:e&&e.className,r:[r.x,r.y,r.width,r.height],ih:innerHeight}})()`);
    console.log(JSON.stringify(ev.hoverDebug));
    assert.equal(before, '0'); assert.equal(after, '1');
    await shot(`20261128-${theme}-hover-long-actions.png`);
    // 2) 长消息复制：只含这一块正文
    await c.eval("require('electron').clipboard.writeText('SENTINEL')");
    await click(frame + ' [data-action="long-copy"]'); await sleep(300);
    const text = await c.eval("require('electron').clipboard.readText()");
    ev.longCopyLength = text.length;
    assert.ok(text.startsWith('📌 长消息测试'), text.slice(0, 40));
    assert.ok(!/长消息 ·|展开全文|收起全文|复制为图片|codex|回答 1/.test(text), '混进了界面文字或别的消息');
    assert.ok(text.includes('function hello(name)') && text.includes('7 项通过'));
    // 3) 长消息复制为图片（超过一屏，要拼接）
    const scrollerTop = await c.eval("document.getElementById('msg-overlay').scrollTop");
    await click(frame + ' [data-action="long-copy-image"]');
    await until(`!document.body.classList.contains('hub-image-capturing') && /已复制|失败/.test(document.querySelector(${j(frame + ' [data-action="long-copy-image"]')}).textContent)`, 30000,
      `[document.body.className, document.querySelector(${j(frame + ' [data-action="long-copy-image"]')}).textContent, document.querySelector(${j(frame + ' [data-action="long-copy-image"]')}).title]`);
    const label = await c.eval(`document.querySelector(${j(frame + ' [data-action="long-copy-image"]')}).textContent`);
    const img = await readImage();
    const frameH = await c.eval(`document.querySelector(${j(frame)}).getBoundingClientRect().height`);
    ev.longImage = { label, size: img && img.size, frameHeight: frameH, scrollRestored: await c.eval("document.getElementById('msg-overlay').scrollTop") === scrollerTop };
    assert.equal(label, '已复制图片');
    assert.ok(img && img.size.height >= frameH && frameH > 900, `长消息应超过一屏并完整拼接：${j(ev.longImage)}`);
    assert.ok(ev.longImage.scrollRestored, '截图后应回到原滚动位置');
    saveDataUrl(`20261128-${theme}-long-message-image.png`, img.data);
    // 4) 卡片「复制」旁下拉 → 复制为图片
    const card = '.turn-card[data-turn-id="answer-1"]';
    await c.eval(`document.querySelector(${j(card)}).scrollIntoView({block:'center'})`); await sleep(150);
    await point(card, true); await sleep(200);
    await click(card + ' .card-copy-caret'); await sleep(200);
    await shot(`20261128-${theme}-card-copy-menu.png`);
    await c.eval("require('electron').clipboard.writeText('SENTINEL')");
    await click(card + ' [data-action="copy-image"]');
    // 菜单点完即收起，进度和结果显示在卡片头看得见的「复制」按钮上
    await until(`/已复制|失败/.test(document.querySelector(${j(card + ' .turn-actions .ta-btn[data-action="copy"]')}).textContent)`, 30000);
    const cardImg = await readImage();
    ev.cardImage = { label: await c.eval(`document.querySelector(${j(card + ' .turn-actions .ta-btn[data-action="copy"]')}).textContent`), menuClosed: await c.eval(`!document.querySelector(${j(card + ' .card-copy-menu')}).open`), size: cardImg && cardImg.size };
    assert.equal(ev.cardImage.label, '已复制图片');
    assert.ok(ev.cardImage.menuClosed);
    assert.ok(cardImg && cardImg.size.width > 300);
    saveDataUrl(`20261128-${theme}-card-image.png`, cardImg.data);
    // 卡片原有「复制」仍是文字
    await sleep(1600);
    await click(card + ' .ta-btn[data-action="copy"]'); await sleep(300);
    ev.cardTextCopy = (await c.eval("require('electron').clipboard.readText()")).slice(0, 20);
    assert.ok(ev.cardTextCopy.includes('回答 1'));
  }
  evidence.passed = true;
  fs.writeFileSync(path.join(out, '20261128-image-copy-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(async () => { try { if (c) c.close?.(); if (hub) await gracefulQuit(hub); } catch {} });
