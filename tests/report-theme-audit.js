'use strict';
// 把 capture-theme-audit-cdp.js 的结果汇总成离线 HTML「错配清单」：按根因（哪条样式给的颜色）去重，
// 列出受影响的主题与页面、局部截图、修复建议；有改后结果时给前后对比。
// 用法：node tests/report-theme-audit.js --before <目录> [--after <目录>] [--scan <scan.json>] --out <html>
const fs = require('node:fs'), path = require('node:path');

function parseArgs(argv) { const o = {}; for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1]; return o; }
const P1 = new Set(['light-block-on-dark', 'dark-block-on-light', 'text-unreadable', 'icon-invisible']);
const KIND_CN = { 'light-block-on-dark': '深色主题里的浅色块', 'dark-block-on-light': '浅色主题里的深色块', 'text-unreadable': '文字看不清（对比度<3）', 'icon-invisible': '图标几乎看不见', 'text-weak': '文字偏弱（3–4.5）' };
const THEME_CN = { codex: '冷白', claude: '暖米', hub: '紫留白', slate: '灰白', dark: '深色', frost: '冷杉' };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const literal = v => /#[0-9a-f]{3,8}\b|rgba?\(\s*\d|\bwhite\b|\bblack\b/i.test(v || '') && !/^var\(/.test(String(v || '').trim());

function causeOf(f) {
  const fg = (f.fgRule || [])[0], bg = (f.bgRule || [])[0];
  const pick = f.kind.includes('block') ? bg : (fg && literal(fg.val)) ? fg : (bg && literal(bg.val)) ? bg : fg || bg;
  if (!pick) return { key: 'unknown|' + f.el.split(' > ').pop(), src: '（未找到样式规则，可能是 JS 动态设置或继承）', sel: f.el, prop: '', val: '', literal: false };
  return { key: `${pick.src}|${pick.sel}|${pick.prop}`, src: pick.src, sel: pick.sel, prop: pick.prop, val: pick.val, literal: literal(pick.val) };
}
function advice(f, c) {
  if (f.kind === 'light-block-on-dark') return c.literal ? `把写死的 ${c.val} 换成 var(--surface-card) / var(--hw-surface) 这类会随主题翻转的底色` : '该变量在深色主题下取了浅色值，补上深色主题取值';
  if (f.kind === 'dark-block-on-light') return c.literal ? `把写死的 ${c.val} 换成主题底色变量；确需恒深（终端类）请标 theme-ok` : '该变量在浅色主题下取了深色值，补上浅色主题取值';
  if (f.kind === 'icon-invisible') return '图标改用 currentColor，跟随文字色';
  if (/brand|tint|hw-on-tint/.test(c.val + ' ' + ((f.bgRule || [])[0] || {}).val)) return '品牌/模块色块上的字改用 var(--brand-ink) / var(--hw-text-on)，随主题取深浅';
  if (c.literal) return `把写死的 ${c.val} 换成 var(--fg-default) / var(--hw-text-1) 等文字变量`;
  return '变量本身在这套主题下太淡：提一档（如 text-3→text-2）或调该主题的变量取值';
}

function load(dir) { const r = JSON.parse(fs.readFileSync(path.join(dir, 'theme-audit.json'), 'utf8')); r.dir = dir; return r; }
function aggregate(run) {
  const items = new Map(); const matrix = {}; let screens = 0, screensBad = 0;
  for (const s of run.shots) {
    screens++; let bad = 0;
    for (const f of s.findings) {
      const c = causeOf(f); const key = `${P1.has(f.kind) ? 'P1' : 'P2'}|${f.kind.includes('block') ? 'block' : f.kind}|${c.key}|${f.el.split(' > ').slice(-1)[0]}`;
      let it = items.get(key);
      if (!it) items.set(key, it = { key, kind: f.kind, p1: P1.has(f.kind), cause: c, el: f.el, text: f.text, themes: new Set(), states: new Set(), pairs: new Set(), example: null, minRatio: 99, advice: advice(f, c) });
      it.themes.add(s.theme); it.states.add(s.state.split('~')[0]); it.pairs.add(s.theme + '|' + s.state);
      const r = f.ratio != null ? f.ratio : f.lum;
      if (P1.has(f.kind)) bad++;
      if (!it.example || (f.crop && !it.example.crop) || (f.ratio != null && f.ratio < it.minRatio)) { it.example = { theme: s.theme, state: s.state, crop: f.crop, file: s.file, fg: f.fg, bg: f.bg, ratio: r }; }
      if (f.ratio != null) it.minRatio = Math.min(it.minRatio, f.ratio);
    }
    (matrix[s.state] ||= {})[s.theme] = bad; if (bad) screensBad++;
  }
  return { items: [...items.values()], matrix, screens, screensBad };
}

async function thumb(file, width = 560) {
  try { const sharp = require('sharp'); const b = await sharp(file).resize({ width }).jpeg({ quality: 72 }).toBuffer(); return 'data:image/jpeg;base64,' + b.toString('base64'); }
  catch { try { return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64'); } catch { return ''; } }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const before = load(o.before), after = o.after ? load(o.after) : null;
  const A = aggregate(before), B = after ? aggregate(after) : null;
  const scan = o.scan ? JSON.parse(fs.readFileSync(o.scan, 'utf8')) : null;
  const scanAfter = o.scanAfter ? JSON.parse(fs.readFileSync(o.scanAfter, 'utf8')) : null;
  const themes = before.themes;
  const p1 = A.items.filter(i => i.p1).sort((a, b) => b.themes.size - a.themes.size || a.minRatio - b.minRatio);
  const p2 = A.items.filter(i => !i.p1);
  const remain = B ? new Set(B.items.filter(i => i.p1).map(i => i.key)) : null;
  // 只有改后确实拍到了同一主题、同一状态，才能说「已修」；没拍到的记「未复验」。
  const shotAfter = B ? new Set(after.shots.map(s => s.theme + '|' + s.state)) : null;
  const verified = it => B && [...it.pairs].every(p => shotAfter.has(p));
  const statusOf = it => !remain ? '' : remain.has(it.key) ? 'remain' : verified(it) ? 'fixed' : 'unverified';
  const fixedN = remain ? p1.filter(i => statusOf(i) === 'fixed').length : 0;
  const unverifiedN = remain ? p1.filter(i => statusOf(i) === 'unverified').length : 0;
  const newInAfter = B ? B.items.filter(i => i.p1 && !A.items.some(x => x.key === i.key)) : [];

  const rows = [];
  for (const [n, it] of p1.entries()) {
    const ex = it.example; const crop = ex.crop ? await thumb(path.join(before.dir, ex.crop), 420) : '';
    const st = statusOf(it);
    const status = st === 'remain' ? '<span class="tag warn">仍在</span>' : st === 'fixed' ? '<span class="tag ok">已修</span>' : st === 'unverified' ? '<span class="tag warn">未复验</span>' : '';
    rows.push(`<tr><td>${n + 1}</td><td>${esc(KIND_CN[it.kind])}${status}</td><td><b>${esc(ex.state)}</b><br><small>${[...it.states].map(esc).join('、')}</small></td>
<td>${[...it.themes].map(t => `<span class="th th-${t}">${THEME_CN[t] || t}</span>`).join('')}</td>
<td><code>${esc(it.el.split(' > ').slice(-2).join(' > '))}</code><br><small>「${esc(it.text || '')}」 ${ex.ratio != null ? '比值 ' + ex.ratio : ''}</small></td>
<td><small>${esc(it.cause.src)}</small><br><code>${esc(it.cause.sel.slice(0, 90))}</code><br><small>${esc(it.cause.prop)}: ${esc(it.cause.val)}</small></td>
<td>${esc(it.advice)}</td><td>${crop ? `<img class="crop" src="${crop}">` : ''}</td></tr>`);
  }
  // 截图墙：每个状态一行，6 主题并排（改前；有改后时再给一行改后）
  const wallStates = Object.keys(A.matrix);
  const wall = [];
  for (const st of wallStates) {
    const anyBad = themes.some(t => (A.matrix[st] || {})[t]);
    if (!anyBad && !o.all) continue;
    const cells = [];
    for (const t of themes) { const f = path.join(before.dir, `${t}-${st}.png`); cells.push(`<figure><img src="${await thumb(f, 360)}"><figcaption>${THEME_CN[t]} · 改前 ${(A.matrix[st] || {})[t] || 0} 处</figcaption></figure>`); }
    if (B) for (const t of themes) { const f = path.join(after.dir, `${t}-${st}.png`); if (fs.existsSync(f)) cells.push(`<figure class="after"><img src="${await thumb(f, 360)}"><figcaption>${THEME_CN[t]} · 改后 ${(B.matrix[st] || {})[t] || 0} 处</figcaption></figure>`); }
    wall.push(`<h3>${esc(st)}</h3><div class="wall">${cells.join('')}</div>`);
  }
  const matrixHtml = `<table class="mx"><tr><th>界面状态</th>${themes.map(t => `<th>${THEME_CN[t]}</th>`).join('')}</tr>${wallStates.map(st => `<tr><td>${esc(st)}</td>${themes.map(t => { const a = (A.matrix[st] || {})[t] || 0; const shot = B && B.matrix[st] && t in B.matrix[st]; const b = shot ? B.matrix[st][t] : null; return `<td class="${a ? 'bad' : ''}">${a}${B ? (shot ? ` → <b class="${b ? 'bad' : 'okc'}">${b}</b>` : ' → <b class="bad">未拍</b>') : ''}</td>`; }).join('')}</tr>`).join('')}</table>`;
  const scanHtml = scan ? `<p>扫描 ${scan.files} 个界面文件，写死颜色（计入门槛的三类）共 <b>${scan.gated}</b> 处${scanAfter ? `，修后 <b>${scanAfter.gated}</b> 处` : ''}。分类：${esc(JSON.stringify(scan.byKind))}</p>
<table class="mx"><tr><th>文件</th><th>改前</th>${scanAfter ? '<th>改后</th>' : ''}</tr>${Object.entries(scan.byFile).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([f, n]) => `<tr><td>${esc(f)}</td><td>${n}</td>${scanAfter ? `<td>${scanAfter.byFile[f] || 0}</td>` : ''}</tr>`).join('')}</table>` : '<p>未附静态扫描。</p>';

  const concl = `<ul class="kpi">
<li><b>${themes.length}</b><span>套主题（${themes.map(t => THEME_CN[t]).join('、')}）</span></li>
<li><b>${A.screens}</b><span>个画面（主题 × 界面状态）</span></li>
<li><b>${A.screensBad}</b><span>个画面里有明显错配（${A.screens} 个里 ${A.screensBad} 个）</span></li>
<li><b>${p1.length}</b><span>条去重后的明显错配${B ? `，改后复验已消失 ${fixedN} 条${unverifiedN ? `，${unverifiedN} 条改后没拍到、未复验` : ''}` : ''}</span></li>
${B ? `<li><b>${B.screensBad}</b><span>修后仍有错配的画面（${B.screens} 个里）</span></li>` : ''}
<li><b>${p2.length}</b><span>条「偏弱」文字（3–4.5，参考）</span></li></ul>`;

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>HUB-H 主题错配清单</title><style>
:root{--bg:#f4f6f9;--card:#fff;--ink:#1d2530;--muted:#5d6878;--line:#e3e7ee;--blue:#3478f6}
*{box-sizing:border-box}body{margin:0;font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif;background:var(--bg);color:var(--ink)}
nav{position:fixed;left:0;top:0;bottom:0;width:200px;background:#fff;border-right:1px solid var(--line);padding:20px 12px}
nav h1{font-size:15px;margin:0 0 16px}nav a{display:block;padding:8px 10px;border-radius:6px;color:var(--ink);text-decoration:none;cursor:pointer}nav a.on{background:#e8f0fe;color:var(--blue);font-weight:600}
main{margin-left:200px;padding:24px 32px;max-width:1500px}section{display:none}section.on{display:block}
h2{font-size:20px;margin:0 0 14px}h3{font-size:15px;margin:22px 0 8px}
.kpi{display:flex;flex-wrap:wrap;gap:12px;list-style:none;padding:0}.kpi li{background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px 16px;min-width:180px}.kpi b{display:block;font-size:24px;color:var(--blue)}.kpi span{color:var(--muted);font-size:12px}
table{border-collapse:collapse;width:100%;background:#fff}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top;font-size:12.5px}th{background:#f8f9fb}
code{font:12px Consolas,monospace;background:#f1f3f6;padding:1px 4px;border-radius:3px;word-break:break-all}small{color:var(--muted)}
.crop{max-width:300px;max-height:160px;border:1px solid var(--line);cursor:zoom-in}.crop.big{max-width:none;max-height:none;position:fixed;z-index:9;left:50%;top:50%;transform:translate(-50%,-50%);box-shadow:0 10px 40px rgba(0,0,0,.4)}
.th{display:inline-block;font-size:11px;padding:0 6px;border-radius:9px;margin:1px;border:1px solid var(--line)}.th-dark,.th-frost{background:#1d2530;color:#fff}
.tag{margin-left:6px;font-size:11px;padding:0 6px;border-radius:9px}.tag.ok{background:#e3f6e8;color:#1d7a3a}.tag.warn{background:#fdecea;color:#b42318}
.mx td.bad{background:#fdecea}.mx .bad{color:#b42318}.mx .okc{color:#1d7a3a}
.wall{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}.wall figure{margin:0}.wall img{width:100%;border:1px solid var(--line);cursor:zoom-in}.wall figcaption{font-size:11.5px;color:var(--muted)}.wall .after figcaption{color:#1d7a3a}
</style></head><body>
<nav><h1>主题错配清单</h1><a data-s="s1" class="on">结论</a><a data-s="s2">错配清单</a><a data-s="s3">主题 × 页面</a><a data-s="s4">截图对比</a><a data-s="s5">静态扫描</a><a data-s="s6">偏弱文字</a></nav>
<main>
<section id="s1" class="on"><h2>结论</h2>${concl}
<p>改前提交 ${esc(before.commit)}${after ? `，改后提交 ${esc(after.commit)}` : ''}。检测口径：文字按 WCAG 对比度（实际前景叠到实际背景），&lt;3 记「看不清」；深色主题里大块灰白底、浅色主题里大块近黑底记「极性错配」（终端、代码块等恒深区域除外）；图标填充与背景比值 &lt;1.6 记「看不见」。</p>
${[before, after].filter(Boolean).some(r => (r.errors || []).length) ? `<p><b>采集错误</b>：${[['改前', before], ['改后', after]].filter(([, r]) => r && (r.errors || []).length).map(([n, r]) => n + ' ' + r.errors.length + ' 处（' + r.errors.slice(0, 6).map(e => esc(e.theme + '/' + e.state + '：' + e.error)).join('；') + '）').join('；')}</p>` : ''}
${newInAfter.length ? `<p><b>改后新出现 ${newInAfter.length} 条</b>：${newInAfter.slice(0, 8).map(i => esc(i.el.split(' > ').pop() + '@' + [...i.states].join('/'))).join('；')}</p>` : ''}</section>
<section id="s2"><h2>错配清单（去重 ${p1.length} 条，按影响主题数排序）</h2><table><tr><th>#</th><th>类型</th><th>页面/状态</th><th>主题</th><th>位置</th><th>根因（给颜色的样式）</th><th>修复建议</th><th>局部截图</th></tr>${rows.join('')}</table></section>
<section id="s3"><h2>主题 × 界面状态（明显错配处数${B ? '，改前 → 改后' : ''}）</h2>${matrixHtml}</section>
<section id="s4"><h2>截图对比（只列有错配的状态）</h2>${wall.join('')}</section>
<section id="s5"><h2>静态扫描：写死的颜色</h2>${scanHtml}</section>
<section id="s6"><h2>偏弱文字（参考，共 ${p2.length} 条）</h2><table><tr><th>位置</th><th>主题</th><th>状态</th><th>最低比值</th><th>根因</th></tr>${p2.sort((a, b) => a.minRatio - b.minRatio).slice(0, 120).map(i => `<tr><td><code>${esc(i.el.split(' > ').slice(-2).join(' > '))}</code> 「${esc(i.text)}」</td><td>${[...i.themes].map(t => THEME_CN[t]).join('、')}</td><td>${[...i.states].join('、')}</td><td>${i.minRatio}</td><td><small>${esc(i.cause.src)} ${esc(i.cause.sel.slice(0, 60))} ${esc(i.cause.val)}</small></td></tr>`).join('')}</table></section>
</main><script>
document.querySelectorAll('nav a').forEach(a=>a.onclick=()=>{document.querySelectorAll('nav a,section').forEach(x=>x.classList.remove('on'));a.classList.add('on');document.getElementById(a.dataset.s).classList.add('on');scrollTo(0,0)});
document.addEventListener('click',e=>{if(e.target.tagName==='IMG')e.target.classList.toggle('big')});
</script></body></html>`;
  fs.writeFileSync(o.out, html, 'utf8');
  console.log(JSON.stringify({ out: o.out, themes: themes.length, screens: A.screens, screensBad: A.screensBad, p1: p1.length, p2: p2.length, fixed: fixedN, unverified: unverifiedN, errorsBefore: (before.errors || []).length, errorsAfter: after ? (after.errors || []).length : null, afterScreensBad: B ? B.screensBad : null, newInAfter: newInAfter.length }));
}
main().catch(e => { console.error(e.stack); process.exit(1); });
