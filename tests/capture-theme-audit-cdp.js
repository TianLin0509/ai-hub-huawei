'use strict';
// 主题错配全量走查：6 套主题 × 全部左栏页面 + 弹窗/悬停/菜单/选项各页签/启动中心/会话卡片（Markdown、表格、代码块）。
// 每个状态：截一张全屏图，并在页面内找三类错配——
//   ① 文字对比度不足（实际前景色叠到实际背景上，WCAG 比值 <3 记「看不清」，<4.5 记「偏弱」）；
//   ② 底色极性反了：深色主题里出现大块灰白底、浅色主题里出现大块近黑底（终端、代码块这类恒深的机器输出面除外）；
//   ③ 图标/SVG 与背景几乎同色（比值 <1.6）。
// 每条错配附「是谁给的颜色」：命中该元素的 CSS 规则（文件 + 选择器 + 值）或内联样式，便于定位根因。
// 隔离数据、后台离屏窗口、假 CodeAgent，不调模型。--entry 可指向改前检出拍对照。
// 用法：node tests/capture-theme-audit-cdp.js [--entry <检出>] [--out <目录>] [--themes codex,dark] [--states home,options]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { randomUUID } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const THEMES = ['codex', 'claude', 'hub', 'slate', 'dark', 'frost'];
const DARK = new Set(['dark', 'frost']);

function parseArgs(argv) {
  const opt = { entry: REPO, out: path.join(REPO, 'artifacts', 'theme-audit-' + Date.now()), themes: THEMES, states: null, width: 1440, height: 900, crops: 6 };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, ''), v = argv[i + 1];
    if (k === 'themes' || k === 'states') opt[k] = v.split(',');
    else if (['width', 'height', 'crops'].includes(k)) opt[k] = Number(v);
    else if (k === 'probe') opt.probe = JSON.parse(fs.readFileSync(path.resolve(v), 'utf8')); // {"状态名":[[x,y],…],"*":[…]}
    else opt[k] = path.resolve(v);
  }
  return opt;
}

// 定位用：给定坐标，报出该点元素（及两层父级）的计算颜色和设置颜色的样式规则。
function probeAt(points) {
  const props = ['color', 'background-color', 'background', 'border-color', 'border', 'outline', 'box-shadow', 'fill', 'stroke', 'filter', 'opacity'];
  const rules = [];
  const walk = (list, src) => { for (const r of list || []) { if (r.cssRules && !r.selectorText) walk(r.cssRules, src); else if (r.selectorText) rules.push([r, src]); } };
  for (const s of document.styleSheets) { try { walk(s.cssRules, (s.href || 'inline').split('/').slice(-2).join('/')); } catch { /* cross-origin */ } }
  const desc = e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : '');
  return points.map(([x, y]) => {
    let e = document.elementFromPoint(x, y); const out = { at: [x, y], chain: [] };
    for (let d = 0; e && d < 3; d++, e = e.parentElement) {
      const cs = getComputedStyle(e);
      const hit = [];
      for (const [r, src] of rules) {
        let ok = false; try { ok = e.matches(r.selectorText); } catch { /* pseudo */ }
        if (!ok) continue;
        for (const p of props) { const v = r.style.getPropertyValue(p); if (v) hit.push(`${src} | ${r.selectorText.slice(0, 140)} | ${p}: ${v}`); }
      }
      out.chain.push({ el: desc(e).slice(0, 160), color: cs.color, bg: cs.backgroundColor, border: cs.borderTopColor + ' ' + cs.borderTopWidth, outline: cs.outlineColor + ' ' + cs.outlineWidth, shadow: cs.boxShadow.slice(0, 80), opacity: cs.opacity, inline: (e.getAttribute('style') || '').slice(0, 160), rules: hit.slice(-8) });
    }
    return out;
  });
}

// ---------------------------------------------------------------- 页面内普查
function census({ dark, state }) {
  const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const num = t => (t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t));
  const parse = s => {
    s = s || '';
    let m = /rgba?\(([^)]+)\)/.exec(s);
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(num); return [p[0], p[1], p[2], p[3] == null ? 1 : p[3]]; }
    m = /color\(srgb\s+([^)]+)\)/.exec(s);
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(num); return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] == null ? 1 : p[3]]; }
    return null;
  };
  const blend = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const ratioOf = (a, b) => { const L1 = lum(a), L2 = lum(b); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); };
  const sat = c => (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])) / Math.max(1, Math.max(c[0], c[1], c[2]));
  const canvasCol = parse(getComputedStyle(document.body).backgroundColor) || (dark ? [13, 17, 23, 1] : [251, 252, 253, 1]);
  // 实际背景：往上找到第一块不透明底，逐层叠加；遇到渐变/图片底记为「不确定」。
  const bgInfo = el => {
    const stack = []; let uncertain = false, source = null;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      // 到达不透明底之前，任一参与合成的层带渐变/图片，背景就依位置而定，记为不确定。
      if (cs.backgroundImage && cs.backgroundImage !== 'none') uncertain = true;
      const c = parse(cs.backgroundColor);
      if (c && c[3] > 0) { stack.push(c); if (!source) source = e; if (c[3] >= 0.98) { source = e; break; } }
    }
    let col = canvasCol[3] >= 1 ? canvasCol : [canvasCol[0], canvasCol[1], canvasCol[2], 1];
    for (let i = stack.length - 1; i >= 0; i--) col = blend(stack[i], col);
    return { col, uncertain, source };
  };
  const opacityChain = el => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= +getComputedStyle(e).opacity; return o; };
  // 半透明组（opacity<1）是整组——字和组内底色一起——再叠到组外的底上。返回 [实际字色, 实际底色]。
  const groupComposite = (el, fg, bgFull, op) => {
    const f = blend(fg, bgFull);
    if (op >= 0.999) return [f, bgFull];
    let g = null; for (let e = el; e && e.nodeType === 1; e = e.parentElement) if (+getComputedStyle(e).opacity < 1) g = e;
    const under = g && g.parentElement ? bgInfo(g.parentElement).col : bgFull;
    return [blend([f[0], f[1], f[2], op], under), blend([bgFull[0], bgFull[1], bgFull[2], op], under)];
  };
  // 恒深的机器输出面（终端、代码块）与媒体，本来就不随主题翻，不算极性错配。
  const MACHINE = '.xterm, pre, code, .hljs, [class*="terminal"], [class*="machine"], [class*="code-block"], .monaco-editor, video, canvas, img, picture';
  const isMachine = el => !!el.closest(MACHINE);
  const vis = el => {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return !(r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight || r.width < 1 || r.height < 1);
  };
  // 被弹窗/遮罩盖住的底层不算（用户看不到它）。
  const onTop = el => { const r = el.getBoundingClientRect(); const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), y = Math.min(innerHeight - 1, Math.max(0, r.top + Math.min(r.height / 2, 12))); const hit = document.elementFromPoint(x, y); return !!hit && (hit === el || el.contains(hit) || hit.contains(el)); };
  const short = el => { if (!el) return ''; const parts = []; for (let e = el, n = 0; e && e.nodeType === 1 && n < 4; e = e.parentElement, n++) { let s = e.tagName.toLowerCase(); if (e.id) { s += '#' + e.id; parts.unshift(s); break; } const cls = String(e.className && e.className.baseVal != null ? e.className.baseVal : e.className).trim().split(/\s+/).filter(Boolean).slice(0, 2); if (cls.length) s += '.' + cls.join('.'); parts.unshift(s); } return parts.join(' > '); };
  // 根因：找出给这个属性赋值的样式规则（文件 + 选择器 + 值）和内联样式。
  const sheets = [];
  const walk = (rules, href) => { for (const r of rules) { if (r.selectorText && r.style) sheets.push({ r, href }); else if (r.cssRules) { try { walk(r.cssRules, href); } catch { /* cross-origin */ } } } };
  for (const s of document.styleSheets) { try { walk(s.cssRules, (s.href || 'inline').split('/').slice(-2).join('/')); } catch { /* ignore */ } }
  const who = (el, props) => {
    if (!el) return [];
    const out = [];
    for (const p of props) { const v = el.style && el.style.getPropertyValue(p); if (v) out.push({ src: 'inline-style', sel: short(el), prop: p, val: v.slice(0, 80) }); }
    for (let i = sheets.length - 1; i >= 0 && out.length < 4; i--) {
      const { r, href } = sheets[i];
      let hit = false; try { hit = el.matches(r.selectorText); } catch { hit = false; }
      if (!hit) continue;
      for (const p of props) { const v = r.style.getPropertyValue(p); if (v) out.push({ src: href, sel: r.selectorText.slice(0, 120), prop: p, val: v.trim().slice(0, 80) }); }
    }
    return out.slice(0, 4);
  };
  let n = 0;
  const tag = el => { if (!el.dataset.taId) el.dataset.taId = state + '-' + (++n); return el.dataset.taId; };
  const findings = []; let checked = 0;
  const rect = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    if (+cs.opacity === 0) continue;
    const inTerm = !!el.closest('.xterm');
    if (inTerm) continue;
    const own = [...el.childNodes].some(x => x.nodeType === 3 && x.textContent.trim());
    const isInput = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !['checkbox', 'radio', 'range', 'color', 'hidden'].includes(el.type);
    // 纯装饰的单个符号（面包屑分隔 ›、下拉小三角 ▾、圆点 ·）有意做淡，不计。
    const decorative = own && !isInput && /^[›‹»«▾▸▴▿·•|/]$/.test(el.textContent.trim());
    if (!decorative && (own || (isInput && (el.value || el.textContent))) && onTop(el)) {
      checked++;
      const fg0 = parse(cs.color); const b = bgInfo(el);
      if (fg0) {
        const op = opacityChain(el);
        if (op < 0.2) continue; // 悬停才显现的操作（父级 opacity:0），平时用户看不到
        const [fg, bgEff] = groupComposite(el, fg0, b.col, op);
        const ratio = ratioOf(fg, bgEff);
        const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700, large = size >= 24 || (bold && size >= 18.66);
        const disabled = el.closest(':disabled,[aria-disabled="true"],.disabled,.is-disabled,.dim,.is-dim,[class*="-dim"],[class*="is-paused"]');
        const failAt = disabled ? 1.8 : 3, warnAt = disabled ? 0 : (large ? 3 : 4.5);
        if (!b.uncertain && (ratio < failAt || ratio < warnAt)) {
          findings.push({ kind: ratio < failAt ? 'text-unreadable' : 'text-weak', ratio: +ratio.toFixed(2), text: (el.value || el.textContent).trim().slice(0, 30), el: short(el), id: tag(el), rect: rect(el),
            fg: cs.color, bg: `rgb(${bgEff.slice(0, 3).map(Math.round)})`, opacity: +op.toFixed(2), bgFrom: short(b.source), disabled: !!disabled, size,
            fgRule: who(el, ['color']), bgRule: who(b.source, ['background-color', 'background']) });
        }
      }
    }
    // ② 极性：大块不透明低饱和底色，和主题明暗相反。
    const c = parse(cs.backgroundColor);
    const r = el.getBoundingClientRect(), area = r.width * Math.min(r.height, innerHeight);
    if (c && c[3] > 0.6 && area > 2400 && sat(c) < 0.25 && !isMachine(el) && !/^(svg|path|IMG)$/i.test(el.tagName) && !el.closest('button,[role=button],a,summary,.btn,[class*="-btn"],[class*="chip"],[class*="avatar"]') && onTop(el)) {
      const L = lum(c);
      const bad = dark ? L > 0.45 : L < 0.06;
      if (bad) findings.push({ kind: dark ? 'light-block-on-dark' : 'dark-block-on-light', lum: +L.toFixed(3), el: short(el), id: tag(el), rect: rect(el), bg: cs.backgroundColor, area: Math.round(area), bgRule: who(el, ['background-color', 'background']) });
    }
    // ③ 图标：svg 形状的填充/描边与背景几乎同色。
    if (el instanceof SVGElement && /^(path|circle|rect|polygon|line|polyline|ellipse)$/i.test(el.tagName)) {
      const svg = el.ownerSVGElement; if (!svg || svg.dataset.taChecked) continue;
      const fill = parse(cs.fill) || parse(cs.stroke); if (!fill || fill[3] < 0.3) continue;
      const rr = svg.getBoundingClientRect(); if (rr.width < 8 || rr.width > 120) continue;
      svg.dataset.taChecked = '1';
      const b = bgInfo(svg); if (b.uncertain) continue;
      const ratio = ratioOf(blend(fill, b.col), b.col);
      if (ratio < 1.6 && onTop(svg)) findings.push({ kind: 'icon-invisible', ratio: +ratio.toFixed(2), el: short(svg), id: tag(svg), rect: rect(svg), fill: cs.fill, stroke: cs.stroke, bg: `rgb(${b.col.slice(0, 3).map(Math.round)})`, fgRule: who(el, ['fill', 'stroke']).concat(el.getAttribute('fill') ? [{ src: 'svg-attr', sel: short(el), prop: 'fill', val: el.getAttribute('fill') }] : []) });
    }
  }
  document.querySelectorAll('[data-ta-checked]').forEach(e => delete e.dataset.taChecked);
  return { checked, findings };
}

// ---------------------------------------------------------------- 造数
const RICH = [
  '## 结论：瓶颈在第 2 步',
  '',
  '- **原因一**：重复读取配置，`loadConfig()` 每轮都调',
  '- 原因二：没有缓存 → [详见文档](https://example.invalid/doc)',
  '',
  '> 提示：引用块在每套主题下都要看得清。',
  '',
  '| 指标 | 改前 | 改后 |',
  '| --- | --- | --- |',
  '| 吞吐 | 120 | 185 |',
  '| 时延 | 42 ms | 18 ms |',
  '',
  '```js',
  'const cache = new Map(); // 代码块恒深',
  'function get(k) { return cache.get(k) ?? load(k); }',
  '```',
].join('\n');

function seed(root, entry) {
  const data = path.join(root, 'data'), claudeDir = path.join(root, 'claude'), cwd = path.join(root, 'project'), work = path.join(root, 'work'), personal = path.join(root, 'personal');
  for (const d of [path.join(data, 'sessions'), cwd, work, personal, path.join(root, 'scan')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  fs.writeFileSync(path.join(personal, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'theme-personal', expiresAt: Date.now() + 86400000 } }));
  const slug = require(path.join(entry, 'core/claude-prefix-fork')).projectSlug(cwd);
  const now = Date.now();
  const sessions = [['周期方案重构', 0.02], ['调度器单测补齐', 0.3], ['上周的信道对比', 3]].map(([title, ageDays]) => {
    const id = randomUUID(), nativeId = randomUUID(), t = now - ageDays * 86400000;
    const file = path.join(claudeDir, 'projects', slug, nativeId + '.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows = []; let parent = null;
    for (let k = 0; k < 2; k++) {
      const u = randomUUID(), a = randomUUID();
      rows.push({ type: 'user', uuid: u, parentUuid: parent, sessionId: nativeId, cwd, timestamp: new Date(t - 60000 + k * 2000).toISOString(), message: { role: 'user', content: `${title}：第 ${k + 1} 个问题，帮我看一下这里为什么慢` } });
      rows.push({ type: 'assistant', uuid: a, parentUuid: u, sessionId: nativeId, cwd, timestamp: new Date(t - 59000 + k * 2000).toISOString(), message: { role: 'assistant', id: 'msg_' + a.replace(/-/g, ''), content: [{ type: 'text', text: RICH }], stop_reason: 'end_turn' } });
      parent = a;
    }
    fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    fs.utimesSync(file, new Date(t), new Date(t));
    const record = { schemaVersion: 1, hubId: id, title, kind: 'claude', cwd, ccSessionId: nativeId, transcriptPath: file, agentRuntime: 'pty', status: 'dormant', createdAt: t - 120000, updatedAt: t, lastMessageTime: t, lastCompletedAt: t };
    fs.writeFileSync(path.join(data, 'sessions', id + '.json'), JSON.stringify(record));
    return record;
  });
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ version: 1, cleanShutdown: true, sessions, meetings: [] }));
  try {
    const pool = require(path.join(entry, 'core/codeagent-pool')), quota = require(path.join(entry, 'core/codeagent-quota'));
    for (const [note, pct] of [['算法研发', 83], ['日常工作', 42], ['额度暂停', 0]]) {
      const id = pool.addAccount(data, { note }); const dir = pool.accountDir(data, id); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: id, expiresAt: Date.now() + 86400000 } }));
      quota.recordCredit(data, id, { remaining: pct * 10, total: 1000, pct, bucket: 'monthly' });
      if (pct === 0) quota.markAvoid(data, id, { source: 'quota', kind: 'credit', reason: '额度用完', until: Date.now() + 3600000 });
    }
  } catch (error) { console.warn('pool seed skipped:', error.message); }
  return { data, claudeDir, work, personal, sessions };
}

// ---------------------------------------------------------------- 状态表
// 每个状态：open（进入）、close（退出，回到主页前执行）。js 字符串在页面里执行。
const ESC = '__esc__';
const click = sel => `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'missing';e.click();return 'ok';})()`;
const HOME = `(()=>{document.querySelector('#btn-home')?.click();try{window.__askAsideUi&&window.__askAsideUi.hide()}catch{}})()`;
function baseStates(sessions) {
  const sid = JSON.stringify(sessions[0].hubId);
  const pages = [
    ['home', null], ['accounts', '#btn-rail-accounts'], ['assistant', '#btn-company-assistant'], ['meeting', '#btn-company-meeting'],
    ['ppt', '#btn-company-ppt'], ['rooms', '#btn-company-rooms'], ['attendance', '#btn-company-attendance'], ['w3', '#btn-company-w3'],
    ['forum', '#btn-company-forum'], ['community', '#btn-community'], ['avatar', '#btn-avatar'], ['profile', '#btn-profile'],
  ];
  const states = pages.map(([name, sel]) => ({ name, open: sel ? click(sel) : 'void 0' }));
  states.push(
    { name: 'hover-rail', open: 'void 0', hover: '#btn-company-meeting', wait: 900 },
    { name: 'session-cards', open: `(()=>{selectSession(${sid});return 'ok'})()`, wait: 2500 },
    { name: 'session-hover', open: `(()=>{selectSession(${sid});return 'ok'})()`, hover: '[class*="turn-content"]', wait: 2500 },
    // 同事反馈的实例：卡片「更多」弹出菜单（多选/重新生成/从此处分支）在浅色主题里成了深底深字。
    { name: 'card-more', open: `(()=>{selectSession(${sid});setTimeout(()=>{const l=[...document.querySelectorAll('#terminal-panel details.card-actions-menu')];const d=l[l.length-1];if(d){d.scrollIntoView({block:'center'});d.open=true;}},1500);return 'ok'})()`, wait: 2600 },
    // 顶栏「后台」按钮的下拉菜单（跳转后台、排查等）。
    { name: 'backstage-menu', open: `(()=>{selectSession(${sid});setTimeout(()=>document.querySelector('#btn-backstage-menu')?.click(),1500);return 'ok'})()`, wait: 2600, close: ESC },
    { name: 'session-details', open: `(()=>{selectSession(${sid});setTimeout(()=>document.querySelector('#btn-session-details')?.click(),600);return 'ok'})()`, wait: 2200, close: ESC },
    { name: 'running-overview', open: click('#btn-running-overview'), close: ESC },
    { name: 'global-search', open: click('#btn-global-search'), wait: 2200, close: `document.querySelector('#search-modal-close')?.click()` },
    { name: 'theme-picker', open: click('#btn-theme'), close: ESC },
    { name: 'launch-center', open: click('#btn-new-more'), wait: 1500, close: ESC, tabs: '#new-session-menu .launch-center-intent' },
    { name: 'rail-group', open: click('#btn-rail-group-rules'), close: ESC, items: '.rail-group-open .rail-group-menu button' },
    // 选项菜单：逐项打开（检查更新、更新日志、版本与回退、一键反馈、快捷键、可选功能、组件中心、我的反馈…）；开关类菜单项不点。
    { name: 'options', open: click('#btn-options'), wait: 900, close: ESC, items: '#options-menu .options-item', skip: '自动休眠|导航显示文字|设置$' },
    { name: 'settings', open: `(()=>{document.querySelector('#btn-options')?.click();const e=document.querySelector('#options-settings');if(!e)return 'missing';e.click();return 'ok'})()`, wait: 1500, close: ESC,
      tabs: '#config-modal [role=tab], #config-modal [data-tab], #config-modal .config-nav button, #config-modal .config-tab' },
  );
  return states;
}

async function run(opt) {
  fs.mkdirSync(opt.out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-theme-audit-'));
  const { data, claudeDir, work, personal, sessions } = seed(root, opt.entry);
  const result = { entry: opt.entry, commit: '', themes: opt.themes, startedAt: new Date().toISOString(), shots: [], errors: [] };
  try { result.commit = require('node:child_process').execFileSync('git', ['-C', opt.entry, 'rev-parse', '--short', 'HEAD'], { windowsHide: true }).toString().trim(); } catch { /* not git */ }
  const save = () => fs.writeFileSync(path.join(opt.out, 'theme-audit.json'), JSON.stringify(result, null, 1));
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: opt.entry, cwd: opt.entry, dataDir: data, port: await freePort(), windowMode: 'background', label: 'theme-audit', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: personal,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), CODEAGENT_POOL_FAKE_LOG: path.join(root, 'fake.jsonl'), CLAUDE_CONFIG_DIR: claudeDir,
      CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
    } });
    c = await connectFirstPage(hub);
    const wait = async (expr, label, timeout = 30000) => {
      for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* reload */ } await sleep(150); }
      throw Error('Timeout ' + label);
    };
    const esc = async () => { for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(250); };
    const mouseTo = async (x, y) => c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    const ready = 'typeof selectSession === "function"';
    await wait(ready, 'renderer ready');
    const all = baseStates(sessions).filter(s => !opt.states || opt.states.includes(s.name));
    const snap = async (theme, name) => {
      const file = `${theme}-${name}.png`;
      fs.writeFileSync(path.join(opt.out, file), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      const stats = await c.eval(`(${census.toString()})(${JSON.stringify({ dark: DARK.has(theme), state: name })})`);
      // 关键错配逐条截局部图（加红框），方便人工判断。
      const order = { 'light-block-on-dark': 0, 'dark-block-on-light': 0, 'text-unreadable': 1, 'icon-invisible': 2, 'text-weak': 3 };
      const top = stats.findings.slice().sort((a, b) => (order[a.kind] - order[b.kind]) || ((a.ratio || 0) - (b.ratio || 0))).slice(0, opt.crops);
      for (const f of top) {
        const [x, y, w, h] = f.rect; const pad = 24;
        const clip = { x: Math.max(0, x - pad), y: Math.max(0, y - pad), width: Math.min(opt.width, w + pad * 2), height: Math.min(opt.height, Math.min(h, 400) + pad * 2), scale: 1 };
        if (clip.width < 4 || clip.height < 4) continue;
        await c.eval(`(()=>{const e=document.querySelector('[data-ta-id=${JSON.stringify(f.id)}]');if(e){e.dataset.taOutline=e.style.outline;e.style.outline='2px solid #ff2d55';e.style.outlineOffset='1px';}})()`);
        const crop = `crop-${theme}-${name}-${f.id.split('-').pop()}.png`;
        try { fs.writeFileSync(path.join(opt.out, crop), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png', clip })).data, 'base64')); f.crop = crop; } catch { /* clip out of view */ }
        await c.eval(`(()=>{const e=document.querySelector('[data-ta-id=${JSON.stringify(f.id)}]');if(e){e.style.outline=e.dataset.taOutline||'';e.style.outlineOffset='';}})()`);
      }
      const pts = opt.probe && (opt.probe[name] || opt.probe['*']);
      const probe = pts ? await c.eval(`(${probeAt.toString()})(${JSON.stringify(pts)})`) : undefined;
      result.shots.push({ theme, state: name, file, checked: stats.checked, findings: stats.findings, probe });
      const k = stats.findings.reduce((m, f) => (m[f.kind] = (m[f.kind] || 0) + 1, m), {});
      console.log(theme.padEnd(6), name.padEnd(22), 'checked', String(stats.checked).padStart(4), JSON.stringify(k));
    };
    for (const theme of opt.themes) {
      await c.eval(`localStorage.setItem('hub.theme',${JSON.stringify(theme)})`);
      await c.send('Page.reload', {}); await sleep(1200);
      await wait(ready + ` && document.documentElement.dataset.theme===${JSON.stringify(theme)}`, 'theme ' + theme);
      await c.send('Emulation.setDeviceMetricsOverride', { width: opt.width, height: opt.height, deviceScaleFactor: 1, mobile: false });
      await sleep(1500);
      for (const st of all) {
        try {
          await c.eval(HOME); await mouseTo(700, 450); await sleep(300);
          const r = await c.eval(st.open);
          if (r === 'missing') { result.errors.push({ theme, state: st.name, error: 'entry missing' }); continue; }
          if (st.hover) {
            const pt = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(st.hover)});if(!e)return null;const r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
            if (pt) await mouseTo(pt[0], pt[1]);
          }
          await sleep(st.wait || 1200);
          await snap(theme, st.name);
          // 子项：页签逐个点、菜单项逐个开。
          const subSel = st.tabs || st.items;
          if (subSel) {
            const count = await c.eval(`(()=>{const skip=${JSON.stringify(st.skip || '')};return [...document.querySelectorAll(${JSON.stringify(subSel)})].filter(e=>e.getClientRects().length&&!(skip&&new RegExp(skip).test(e.textContent.trim()))).length})()`);
            for (let i = 0; i < Math.min(count, 14); i++) {
              if (st.items && i > 0) { await esc(); await esc(); await c.eval(HOME); await sleep(200); await c.eval(st.open); await sleep(500); }
              const label = await c.eval(`(()=>{const skip=${JSON.stringify(st.skip || '')};const l=[...document.querySelectorAll(${JSON.stringify(subSel)})].filter(e=>e.getClientRects().length&&!(skip&&new RegExp(skip).test(e.textContent.trim())));const e=l[${i}];if(!e)return null;const t=(e.dataset.tab||e.dataset.page||e.getAttribute('aria-label')||e.textContent||'').trim().replace(/[^\\w\\u4e00-\\u9fa5]+/g,'').slice(0,10);e.click();return t||'${i}';})()`);
              if (!label) continue;
              await sleep(1300);
              await snap(theme, `${st.name}~${i}-${label}`);
            }
          }
          if (st.close === ESC) await esc(); else if (st.close) await c.eval(st.close);
          await esc();
        } catch (error) { result.errors.push({ theme, state: st.name, error: error.message }); console.log(theme, st.name, 'ERROR', error.message); }
        save();
      }
    }
    result.ok = true; result.complete = result.errors.length === 0; // ok 只表示流程跑完；complete 才表示每个状态都拍到了
  } catch (error) { result.error = error.stack; console.error(error.stack); process.exitCode = 1; }
  finally {
    if (hub) { try { await gracefulQuit(hub); } catch { /* best effort */ } hub.child?.stdout?.destroy(); hub.child?.stderr?.destroy(); hub.child?.stdin?.destroy(); }
    try { await c?.close(); } catch { /* closed */ }
    result.finishedAt = new Date().toISOString();
    save(); console.log('OUT ' + opt.out);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
  }
  return result;
}

module.exports = { census, run, THEMES, __seed: seed };
if (require.main === module) run(parseArgs(process.argv.slice(2)));
