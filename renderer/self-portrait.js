'use strict';
// 分身页 ›「我的画像」（2026-11-28「蒸馏自己」）：把本人 WeLink 发言蒸馏成的本机画像摆成一屏三栏——说话 / 习性 / 应用到。
// 画像只存本机，这里只经 self-distill:* 接口读写；每条可改、删、锁定（锁定的条目重新蒸馏时原样保留）。
// 一屏放不下的列表（口头禅、口吻要点、例句）翻页，不出滚动条。
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 五处应用：每个开关下一句话写清会改变什么。
const APPLY = [
  ['assistant', '助理', '替你起草 WeLink 回复、邮件、简报时，用你的长短和口吻。'],
  ['avatar', '分身', '分身起草时用你的口吻；人设为空时用画像补上，仿写例句当口吻样本。'],
  ['pet', '桌宠', '闲聊混进你的口头禅；作息照你的习惯：你常在线的时段精神，平时不在的时段打盹。'],
  ['community', '社区', '团队代答用你的口吻（标「桌宠代答」）；串门多少、搬的小道具、气泡像你。'],
  ['ppt', 'PPT', '只用于讲稿和用词：用词偏好、句子长短，不带聊天语气。'],
];
const STEPS = [['collect', '取材'], ['scrub', '去敏'], ['stats', '统计'], ['model', '模型提炼'], ['save', '保存']];
const CAT = { chat: '闲聊', fact: '答事实', decline: '婉拒', chase: '催进度' };
const STYLE = [['conclusion', '直接给结论'], ['ask', '追问细节'], ['decline', '婉拒'], ['forward', '转给别人']];
// 每栏的翻页大小（1440×900 下三栏都不出滚动条）。
const PAGE = { catchphrases: 8, tone: 3, examples: 4, topics: 10 };
// 可逐条编辑的段落：在画像里的位置。
const SECTIONS = { catchphrases: ['speak', 'catchphrases'], tone: ['speak', 'tone'], examples: ['speak', 'examples'], topics: ['habits', 'topics'] };
const FIRST_HINT = '先用最近 36 小时的消息出初版，今晚档案建好后可重新蒸馏';

function paginate(list, page, size) {
  const rows = Array.isArray(list) ? list : [];
  const pages = Math.max(1, Math.ceil(rows.length / size)), at = Math.min(Math.max(0, page || 0), pages - 1);
  return { rows: rows.slice(at * size, at * size + size), at, pages };
}
// 核心存的就是 0–100 的整数百分比，这里只加 %。
const pct = v => `${Math.round(Number(v) || 0)}%`;
const sectionOf = (p, sec) => { const [a, b] = SECTIONS[sec] || []; return (p && p[a] && Array.isArray(p[a][b])) ? p[a][b] : []; };
// 改动后的局部画像：数组整段替换（删除＝去掉该条，改字 / 锁定＝改该条）。
function patchFor(p, sec, list) {
  const [a, b] = SECTIONS[sec];
  return { [a]: { [b]: list } };
}
function applyPatch(p, patch) {
  const out = { ...(p || {}) };
  for (const [k, v] of Object.entries(patch || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(out[k] || {}), ...v } : v;
  return out;
}
// 话多话少、回复快慢：给数字配一句人话。
function talkLevel(daily) {
  const n = Number(daily) || 0;
  return n >= 80 ? '话多' : n >= 25 ? '适中' : '话少';
}
// 回复中位：核心在有样本但不到 1 分钟时记 1，0 表示没有数据。
function replyValue(min) {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return '<b>—</b> 分钟';
  return m <= 1 ? '<b>1</b> 分钟内' : `<b>${Math.round(m)}</b> 分钟`;
}
function replyLevel(min) {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return '—';
  return m <= 5 ? '秒回型' : m <= 30 ? '回得挺快' : m <= 120 ? '攒一攒再回' : '回得慢';
}
const hourSpan = (from, to) => (Number.isFinite(Number(from)) && Number.isFinite(Number(to)) ? `${Number(from)}:00–${Number(to)}:00 最活跃` : '');

function createSelfPortrait({ ipcRenderer, rerender = () => {}, flash = () => {}, confirm = () => {} }) {
  const st = { loaded: false, loading: false, error: '', status: null, portrait: null, running: false, steps: {}, last: null, page: {}, edit: null, busy: '' };
  const invoke = async (name, payload) => {
    const r = await ipcRenderer.invoke(name, payload);
    if (!r || r.ok === false) throw new Error(r?.error || '没有收到结果，请重试');
    return r;
  };
  async function load() {
    st.loading = true;
    try {
      const r = await invoke('self-distill:status');
      st.status = r; st.portrait = r.portrait || null; st.running = !!r.running; st.error = '';
    } catch (e) {
      // 主进程还没有这组接口（旧版本）：如实说明，不假装能用。
      st.error = /No handler registered/i.test(e?.message || '') ? '这个版本还没装好「蒸馏自己」，更新后再试' : e.message;
    } finally { st.loading = false; st.loaded = true; rerender(); }
  }
  function onProgress(_event, ev) {
    if (!ev || !ev.step) return;
    st.last = ev;
    if (ev.step === 'error') { st.running = false; st.error = ev.text || '蒸馏没成功'; rerender(); return; }
    if (ev.step === 'done') { st.running = false; st.steps = {}; flash(ev.text || '画像已更新'); void load(); return; }
    st.running = true; st.steps[ev.step] = ev;
    rerender();
  }
  ipcRenderer.on?.('self-distill:progress', onProgress);
  // 别处改了画像（另一个窗口、蒸馏完成、删除）：已经打开过就重读一次。
  function onChanged() { if (st.loaded && !st.loading) void load(); }
  ipcRenderer.on?.('self-distill:changed', onChanged);
  async function runDistill(statsOnly = false) {
    st.running = true; st.steps = {}; st.last = { step: 'collect', text: '正在取材…' }; st.error = ''; rerender();
    try { await invoke('self-distill:run', statsOnly ? { statsOnly: true } : {}); } catch (e) { st.running = false; st.error = e.message; rerender(); }
  }
  async function savePatch(patch, done = '已保存') {
    st.busy = 'save'; rerender();
    try {
      const r = await invoke('self-distill:save', { patch });
      st.portrait = r.portrait || (r.v ? r : applyPatch(st.portrait, patch));
      flash(done);
    } catch (e) { st.error = e.message; } finally { st.busy = ''; rerender(); }
  }
  async function setApply(target, on) {
    st.busy = 'apply:' + target; rerender();
    try {
      const r = await invoke('self-distill:apply', { target, on });
      st.portrait = { ...st.portrait, apply: r.apply || { ...(st.portrait?.apply || {}), [target]: on } };
      flash(on ? `已应用到${(APPLY.find(x => x[0] === target) || [])[1] || target}` : '已关闭，那边恢复原样');
    } catch (e) { st.error = e.message; } finally { st.busy = ''; rerender(); }
  }
  async function useBackend(kind) {
    st.busy = 'backend'; rerender();
    try {
      const r = await ipcRenderer.invoke('feature-agents:set', { feature: 'distill', choice: { kind, model: '' } });
      if (!r || r.ok === false) throw new Error(r?.error || '没有保存成功');
    } catch (e) { st.error = e.message; st.busy = ''; rerender(); return; }
    st.busy = ''; await runDistill(false);
  }

  // ---- 交互 ----
  async function act(op, d) {
    const p = st.portrait;
    if (op === 'sd-reload') { await load(); return; }
    if (op === 'sd-run') { await runDistill(d.stats === '1'); return; }
    if (op === 'sd-backend') { await useBackend(d.k || 'codeagent'); return; }
    if (op === 'sd-delete') {
      confirm({ title: '删除全部画像？', body: '画像和蒸馏的中间结果都会从本机删除；助理、分身、桌宠、社区、PPT 立刻恢复原样。可以随时重新蒸馏。', yes: '全部删除', run: async () => {
        try { await invoke('self-distill:delete'); st.portrait = null; st.edit = null; st.page = {}; flash('画像已全部删除'); await load(); } catch (e) { st.error = e.message; rerender(); }
      } });
      return;
    }
    if (op === 'sd-page') { const k = d.sec; st.page[k] = Math.max(0, (st.page[k] || 0) + Number(d.d || 0)); rerender(); return; }
    if (!p) return;
    const sec = d.sec, list = sectionOf(p, sec);
    // 关心的领域只认白名单里的公开领域词：只能锁定、删除，不能改字。
    if (op === 'sd-edit' && sec === 'topics') return;
    if (op === 'sd-edit') { const it = list.find(x => x.id === d.id); if (it) st.edit = { sec, id: it.id, text: it.text }; rerender(); return; }
    if (op === 'sd-cancel') { st.edit = null; rerender(); return; }
    if (op === 'sd-ok') {
      const e = st.edit; if (!e) return;
      const text = String(e.text || '').trim(); st.edit = null;
      if (!text) { rerender(); return; }
      // 改过的条目自动锁住：重新蒸馏时不被覆盖。
      await savePatch(patchFor(p, e.sec, sectionOf(p, e.sec).map(x => (x.id === e.id ? { ...x, text, locked: true } : x))), '已改，并锁住这一条');
      return;
    }
    if (op === 'sd-lock') { await savePatch(patchFor(p, sec, list.map(x => (x.id === d.id ? { ...x, locked: !x.locked } : x))), list.find(x => x.id === d.id)?.locked ? '已解锁，重新蒸馏时会重算' : '已锁定，重新蒸馏时保留'); return; }
    if (op === 'sd-del') { await savePatch(patchFor(p, sec, list.filter(x => x.id !== d.id)), '已删除这一条'); return; }
    if (op === 'sd-tag') { await savePatch({ tags: (p.tags || []).map(t => (t.id === d.id ? { ...t, on: !t.on } : t)) }, '已更新性格标签'); return; }
  }
  function input(value) { if (st.edit) st.edit.text = value; }
  async function change(kind, el) { if (kind === 'sd-apply') await setApply(el.dataset.k, !!el.checked); }

  // ---- 画面 ----
  const pager = (sec, pg) => (pg.pages > 1 ? `<div class="avx-line sd-pg"><span class="avx-m">${pg.at + 1} / ${pg.pages}</span><button class="avx-btn s" data-av="sd-page" data-sec="${sec}" data-d="-1" ${pg.at ? '' : 'disabled'}>上一页</button><button class="avx-btn s" data-av="sd-page" data-sec="${sec}" data-d="1" ${pg.at < pg.pages - 1 ? '' : 'disabled'}>下一页</button></div>` : '');
  const tools = (sec, x) => `<span class="sd-ops"><button class="avx-btn s" data-av="sd-edit" data-sec="${sec}" data-id="${esc(x.id)}" title="改">改</button><button class="avx-btn s${x.locked ? ' p' : ''}" data-av="sd-lock" data-sec="${sec}" data-id="${esc(x.id)}" title="${x.locked ? '已锁定：重新蒸馏时保留' : '锁定后重新蒸馏时保留'}">${x.locked ? '已锁' : '锁定'}</button><button class="avx-btn s d" data-av="sd-del" data-sec="${sec}" data-id="${esc(x.id)}" title="删">删</button></span>`;
  const editor = sec => `<div class="sd-ed"><input class="avx-in" data-sd-edit="${sec}" maxlength="120" value="${esc(st.edit.text)}"><button class="avx-btn s p" data-av="sd-ok" data-sec="${sec}">保存</button><button class="avx-btn s" data-av="sd-cancel" data-sec="${sec}">取消</button></div>`;
  const row = (sec, x, body) => (st.edit && st.edit.sec === sec && st.edit.id === x.id ? editor(sec) : `<div class="sd-row${x.locked ? ' lk' : ''}">${body}${tools(sec, x)}</div>`);
  function chips(sec, list, empty, { editable = true } = {}) {
    const pg = paginate(list, st.page[sec], PAGE[sec]);
    st.page[sec] = pg.at;
    const inEdit = st.edit && st.edit.sec === sec;
    return `${inEdit ? editor(sec) : ''}<div class="avx-chips sd-chips">${pg.rows.length ? pg.rows.map(x => `<span class="avx-ch${x.locked ? ' b' : ''} sd-chip">${editable ? `<button class="sd-x" data-av="sd-edit" data-sec="${sec}" data-id="${esc(x.id)}" title="改">` : '<span class="sd-x">'}${esc(x.text)}${x.n ? `<small>${Number(x.n)}</small>` : ''}${editable ? '</button>' : '</span>'}<button class="sd-x" data-av="sd-lock" data-sec="${sec}" data-id="${esc(x.id)}" title="${x.locked ? '已锁定，点一下解锁' : '锁定后重新蒸馏时保留'}">${x.locked ? '🔒' : '🔓'}</button><button class="sd-x" data-av="sd-del" data-sec="${sec}" data-id="${esc(x.id)}" title="删">×</button></span>`).join('') : `<span class="avx-m">${empty}</span>`}</div>${pager(sec, pg)}`;
  }
  function speakCol(p) {
    const s = p.speak || {}, t = s.stats || {};
    const tone = paginate(s.tone, st.page.tone, PAGE.tone), ex = paginate(s.examples, st.page.examples, PAGE.examples);
    st.page.tone = tone.at; st.page.examples = ex.at;
    return `<div class="avx-card col sd-col" data-col="speak"><h3>说话</h3>
      <div class="sd-stats"><span><b>${Number(t.median) || 0}</b> 字<small>一条的中位长度</small></span><span><b>${Number(t.p90) || 0}</b> 字<small>九成不超过</small></span><span><b>${pct(t.periodRate)}</b><small>带句号</small></span><span><b>${pct(t.emojiRate)}</b><small>带表情</small></span><span><b>${pct(t.burstRate)}</b><small>连发几条</small></span><span><b>${pct(t.enMixRate)}</b><small>中英混用</small></span></div>
      <div class="sd-sec">口头禅</div>${chips('catchphrases', s.catchphrases, '还没有统计出口头禅')}
      <div class="sd-sec">口吻要点</div><div class="sd-list">${tone.rows.length ? tone.rows.map(x => row('tone', x, `<span class="sd-tx">${esc(x.text)}<small>${esc(x.basis || '')}</small></span>`)).join('') : '<span class="avx-m">只统计档不归纳口吻；选了模型后重新蒸馏会补上</span>'}</div>${pager('tone', tone)}
      <div class="sd-sec">仿写例句<small>只仿语气，内容是新编的</small></div><div class="sd-list">${ex.rows.length ? ex.rows.map(x => row('examples', x, `<span class="sd-tx"><span class="avx-ch">${esc(CAT[x.cat] || '闲聊')}</span> ${esc(x.text)}</span>`)).join('') : '<span class="avx-m">还没有例句</span>'}</div>${pager('examples', ex)}</div>`;
  }
  function habitsCol(p) {
    const h = p.habits || {}, hours = Array.isArray(h.hours) && h.hours.length === 24 ? h.hours.map(n => Number(n) || 0) : new Array(24).fill(0), max = Math.max(1, ...hours);
    const style = h.style || {}, total = STYLE.reduce((n, [k]) => n + (Number(style[k]) || 0), 0) || 1;
    const bars = hours.map((n, i) => `<i style="height:${Math.max(2, Math.round(n / max * 100))}%" title="${i}:00 · ${n} 条"></i>`).join('');
    return `<div class="avx-card col sd-col" data-col="habits"><h3>习性</h3>
      <div class="sd-sec">作息<small>${esc(hourSpan(h.activeFrom, h.activeTo))}</small></div><div class="sd-hours">${bars}</div><div class="sd-axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>
      <div class="sd-stats two"><span>${replyValue(h.replyMedianMin)}<small>回复中位 · ${replyLevel(h.replyMedianMin)}</small></span><span><b>${Number(h.dailyMsgs) || 0}</b> 条/天<small>${talkLevel(h.dailyMsgs)}</small></span></div>
      <div class="sd-sec">处事方式</div><div class="sd-bars">${STYLE.map(([k, n]) => `<div><span>${n}</span><i><b style="width:${Math.round((Number(style[k]) || 0) / total * 100)}%"></b></i><em>${Math.round((Number(style[k]) || 0) / total * 100)}%</em></div>`).join('')}</div>
      <div class="sd-sec">关心的领域<small>只认公开领域词</small></div>${chips('topics', h.topics, '还没有统计出领域', { editable: false })}
      <div class="sd-sec">性格标签<small>社区广场只放你勾选的</small></div><div class="avx-chips">${(p.tags || []).length ? p.tags.map(t => `<button class="avx-ch${t.on ? ' b' : ''} sd-tag" data-av="sd-tag" data-id="${esc(t.id)}">${t.on ? '✓ ' : ''}${esc(t.text)}</button>`).join('') : '<span class="avx-m">没有标签</span>'}</div></div>`;
  }
  function applyCol(p) {
    const a = p.apply || {};
    return `<div class="avx-card col sd-col" data-col="apply"><h3>应用到<small>默认都关，关掉即恢复原样</small></h3>${APPLY.map(([k, n, d]) => `<label class="sd-ap${a[k] ? ' on' : ''}"><span class="avx-line"><input type="checkbox" data-chg="sd-apply" data-k="${k}" ${a[k] ? 'checked' : ''} ${st.busy === 'apply:' + k ? 'disabled' : ''}><b>${n}</b>${a[k] ? '<span class="avx-ch g">已应用</span>' : ''}</span><small>${d}</small></label>`).join('')}
      <p class="sd-foot">画像只存本机，不进团队信箱、广场或任何上传；别人的话一个字都不用。</p></div>`;
  }
  function progressBar() {
    if (!st.running) return '';
    const cur = st.last?.step, at = STEPS.findIndex(([k]) => k === cur);
    return `<div class="sd-prog">${STEPS.map(([k, n], i) => { const ev = st.steps[k]; return `<span class="${i < at ? 'ok' : i === at ? 'now' : ''}"><i>${i < at ? '✓' : i + 1}</i>${n}${ev && ev.n != null ? ` <small>${Number(ev.n)}${ev.total ? `/${Number(ev.total)}` : ''} 条</small>` : ''}</span>`; }).join('<em>→</em>')}<span class="avx-m">${esc(st.last?.text || '')}</span></div>`;
  }
  // 后端没配：就地给两个选择，不让用户跑到设置页。
  function backendPick() {
    const s = st.status || {};
    if (s.backendOk !== false) return '';
    return `<div class="avx-bn w slim">还没选蒸馏用的模型。<button class="avx-btn s p" data-av="sd-backend" data-k="codeagent" ${st.busy ? 'disabled' : ''}>用 CodeAgent 并继续</button><button class="avx-btn s" data-av="sd-run" data-stats="1">只统计、不调模型</button></div>`;
  }
  function sourceChip(p) {
    const s = p.source || {};
    return s.kind === 'snapshot' ? `<span class="avx-ch w" title="${esc(FIRST_HINT)}">初版 · 最近 36 小时 ${Number(s.kept) || 0} 条</span>` : `<span class="avx-ch">本人 ${Number(s.kept) || 0} 条消息${s.days ? ` · 近 ${Number(s.days)} 天` : ''}</span>`;
  }
  // 用不了的原因（比如还没登录 WeLink）：就地写清，给扫码和重新检查，不再给「一键继续」。
  function reasonBox() {
    const s = st.status || {};
    if (!s.reason) return '';
    return `<div class="avx-bn w slim">${esc(s.reason)}${/登录/.test(s.reason) ? '<button class="avx-btn s p" data-av="scan">就地扫码登录</button>' : ''}<button class="avx-btn s" data-av="sd-reload">重新检查</button></div>`;
  }
  function emptyView() {
    const s = st.status || {};
    if (s.reason) return `<div class="avx-empty"><h2>把你自己的说话和习性蒸馏成一张画像</h2><p>只读你本人发出的 WeLink 消息，别人的话不读；画像只存本机，默认哪里都不用，你勾了才生效。</p>${reasonBox()}</div>`;
    const hint = s.archiveReady === false ? `<p class="avx-m sd-hint">${FIRST_HINT}</p>` : '';
    return `<div class="avx-empty"><h2>把你自己的说话和习性蒸馏成一张画像</h2><p>只读你本人发出的 WeLink 消息，别人的话不读；画像只存本机，默认哪里都不用，你勾了才生效。</p>${backendPick()}
      <div class="avx-line"><button class="avx-btn p" data-av="sd-run" ${st.running ? 'disabled' : ''}>${s.archiveReady === false ? '一键继续' : '开始蒸馏'}</button><button class="avx-btn" data-av="sd-run" data-stats="1" ${st.running ? 'disabled' : ''}>只统计、不调模型</button></div>${hint}${progressBar()}</div>`;
  }
  function html({ back = false } = {}) {
    if (!st.loaded) return '<div class="avx-empty"><p class="avx-m">正在读取画像…</p></div>';
    const p = st.portrait, s = st.status || {};
    const err = st.error ? `<div class="avx-bn r slim">${esc(st.error)}</div>` : '';
    const head = `<div class="avx-dh">${back ? '<button class="avx-btn s" data-av="self-back">‹ 返回分身</button>' : ''}<h2>我的画像</h2>${p ? sourceChip(p) : ''}${s.backendLabel ? `<span class="avx-ch b" title="蒸馏用的模型">${esc(s.backendLabel)}</span>` : ''}${p && p.note ? `<span class="avx-ch w sd-note" title="${esc(p.note)}">${esc(p.note)}</span>` : ''}
      <div class="avx-right">${p && s.archiveReady === false ? `<span class="avx-m">${FIRST_HINT}</span>` : ''}${p ? `<button class="avx-btn s" data-av="sd-run" ${st.running || s.reason ? 'disabled' : ''}>重新蒸馏</button><button class="avx-btn s d" data-av="sd-delete" ${st.running ? 'disabled' : ''}>全部删除</button>` : ''}</div></div>`;
    if (!p) return `<section class="avx-detail" data-self-portrait>${head}${err}<div class="avx-body">${emptyView()}</div></section>`;
    return `<section class="avx-detail" data-self-portrait>${head}${err}${reasonBox() || backendPick()}${progressBar()}<div class="avx-body"><div class="sd-grid">${speakCol(p)}${habitsCol(p)}${applyCol(p)}</div></div></section>`;
  }
  return { st, load, act, input, change, html, destroy() { ipcRenderer.removeListener?.('self-distill:progress', onProgress); ipcRenderer.removeListener?.('self-distill:changed', onChanged); } };
}

module.exports = { createSelfPortrait, APPLY, STEPS, FIRST_HINT, PAGE, paginate, patchFor, applyPatch, talkLevel, replyLevel, replyValue, pct };
