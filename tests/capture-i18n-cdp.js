'use strict';
// 英文界面截图与残留中文清单（2026-11-20）：在隔离数据目录里启动 Hub，把语言设成 English，
// 按 1440×900 逐个界面截图，并列出屏幕上仍可见的中文（不含会话正文、终端、输入框等不翻区域）。
//   node tests/capture-i18n-cdp.js --out <目录> [--lang en|zh-CN] [--pages main,settings,…]
// 输出：<out>/<序号>-<界面>.png、<out>/residual.json（每个界面的残留中文）。不碰生产 Hub。
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 每个界面：怎么打开（在页面里执行的 JS），打开后等多久。成员按自己负责的界面往这里加。
const PAGES = {
  main: { open: '', wait: 800 },
  settings: { open: 'window.__hubOpenConfigModal && window.__hubOpenConfigModal()', wait: 1200, close: "document.getElementById('config-close')?.click()" },
};
// 各分组自己的界面放在 tests/i18n-pages/<分组>.js（module.exports = { 名字: { open, wait, close } }），避免多人改同一处。
try {
  const dir = path.join(__dirname, 'i18n-pages');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js')).sort()) Object.assign(PAGES, require(path.join(dir, f)));
} catch (_) { /* 没有分组页面 */ }

const RESIDUAL_JS = `(() => {
  const skip = require('../renderer/i18n-dom.js').SKIP_SELECTOR;
  const CJK = /[㐀-鿿豈-﫿]/;
  const out = new Map();
  const visible = el => { if (!el) return false; const r = el.getClientRects(); if (!r.length) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity !== 0; };
  const where = el => { const parts = []; for (let e = el; e && parts.length < 3; e = e.parentElement) { if (e.id) { parts.unshift('#' + e.id); break; } if (e.classList && e.classList[0]) parts.unshift('.' + e.classList[0]); } return parts.join(' '); };
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const t = n.nodeValue.replace(/\\s+/g, ' ').trim();
    if (!t || !CJK.test(t)) continue;
    const el = n.parentElement;
    if (!el || el.closest(skip) || !visible(el)) continue;
    if (!out.has(t)) out.set(t, where(el));
  }
  for (const el of document.querySelectorAll('[title],[placeholder],[aria-label],[data-hub-tip]')) {
    if (el.closest(skip) || !visible(el)) continue;
    for (const a of ['title', 'placeholder', 'aria-label', 'data-hub-tip']) {
      const v = el.getAttribute(a); if (v && CJK.test(v) && !out.has(v)) out.set(v, where(el) + ' @' + a);
    }
  }
  return [...out].map(([text, at]) => ({ text, at }));
})()`;

async function main() {
  const outDir = path.resolve(arg('out', path.join(os.tmpdir(), 'hub-i18n-capture')));
  const lang = arg('lang', 'en');
  const pages = arg('pages', Object.keys(PAGES).join(',')).split(',').filter(p => PAGES[p]);
  fs.mkdirSync(outDir, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-i18n-data-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ ui: { language: lang } }, null, 2));
  let hub = null, c = null;
  const residual = {};
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'background', label: 'i18n-capture', extraEnv: { HUB_I18N_MISS_LOG: '1' } });
    c = await connectFirstPage(hub, null, { waitMainMs: 20000 });
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(4000);
    const active = await c.eval('window.__hubI18n ? window.__hubI18n.i18n.getLanguage() + "/" + window.__hubI18n.translator.isActive() : "no-i18n"');
    console.log('[i18n] 当前语言/翻译层：', active);
    let idx = 1;
    for (const name of pages) {
      const page = PAGES[name];
      if (page.open) { try { await c.eval(page.open); } catch (e) { console.warn('[i18n] 打开失败', name, e.message); } }
      await sleep(page.wait || 800);
      const shot = await c.send('Page.captureScreenshot', { format: 'png' });
      const file = `${String(idx++).padStart(2, '0')}-${name}.png`;
      fs.writeFileSync(path.join(outDir, file), Buffer.from(shot.data, 'base64'));
      residual[name] = await c.eval(RESIDUAL_JS);
      console.log(`[i18n] ${name}: 截图 ${file}，残留中文 ${residual[name].length} 处`);
      if (page.close) { try { await c.eval(page.close); } catch (_) {} await sleep(300); }
    }
  } finally {
    fs.writeFileSync(path.join(outDir, 'residual.json'), JSON.stringify(residual, null, 1));
    if (c) await c.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(e => console.warn('[i18n] 关闭隔离 Hub 失败', e.message));
  }
  console.log('[i18n] 输出目录', outDir);
}

main().catch(e => { console.error(e); process.exit(1); });
