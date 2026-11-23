'use strict';
// 设置弹窗按类分页签（2026-11-21「一个 Tab 一屏」）：原来一整页 1930px 长表单要翻 2.4 屏。
// 各设置项的 DOM、id、取值与保存逻辑一行不动，只在 #config-main-view 的直接子元素上打一个页签标记，
// 不在当前页签的加 .cfg-tab-off 隐藏。别的模块后插进来的项（自有 API、号池共享、桌宠、桌面回执…）按规则归类，
// 认不出的跟着相邻项走。搜索框始终显示；搜索、回执齿轮等「跳到某项」先调 reveal() 切到它所在的页签。
// 以 <script> 加载（与其他脚本共用全局作用域），整体包在函数里免得顶层名字撞车。
(function settingsTabsModule() {
const TABS = [
  { id: 'general', label: '常用' },
  { id: 'display', label: '外观与输入' },
  { id: 'pet', label: '桌宠与回执' },
  { id: 'notify', label: '通知' },
  { id: 'advanced', label: '高级' },
  // 2026-11-22：工作台服务器监控单独一页（原来和工作目录、组队挤在「高级」，1440×900 下超出一屏 136px）。
  { id: 'server', label: '服务器监控' },
];
// 先匹配先得：桌宠段落里也有 .config-operations-card，所以 pet 要排在 server 前面。
const RULES = [
  ['shared', '.hub-feature-search, .cfg-tabs'],
  ['pet', '#cfg-hub-pet, #cfg-notify-mode-section'],
  ['notify', '.config-notification-title, #config-notification-card'],
  ['server', '.config-operations-title, .config-operations-card'],
  ['advanced', '#cfg-team-auto-approve-field, #cfg-work-file-root-field'],
  ['display', '#cfg-boot-splash-field, .config-reading-title, #cfg-card-font-size, #cfg-composer-enter-field, #cfg-workspace-root-field, #cfg-codeagent-quota-placement-field'],
  ['general', '.company-api-settings-entry, .config-language-field, #cfg-model-unavailable-policy, #cfg-proxy, #btn-config-accounts, .config-hint'],
];

function ruleTab(el) {
  for (const [tab, sel] of RULES) if (el.matches(sel) || el.querySelector(sel)) return tab;
  return null;
}

// 给每个直接子元素定页签：认得的按规则；小节标题跟下一项，说明文字跟上一项；都没有就放「常用」。
function classifyChildren(children) {
  const tabs = children.map(ruleTab);
  const near = (i, step) => { for (let j = i + step; j >= 0 && j < tabs.length; j += step) if (tabs[j] && tabs[j] !== 'shared') return tabs[j]; return null; };
  return tabs.map((tab, i) => {
    if (tab) return tab;
    const isLabel = children[i].classList?.contains('config-section-label');
    return (isLabel ? near(i, 1) || near(i, -1) : near(i, -1) || near(i, 1)) || 'general';
  });
}

function createSettingsTabs({ document, window }) {
  const view = document.getElementById('config-main-view');
  const modal = document.getElementById('config-modal');
  if (!view || !modal) return null;
  // 高级页只留操作项，长说明收进标签旁的悬停提示；状态与报错仍在原位。
  const { setFieldHint } = require('./launch-field-hint');
  const rootField = document.getElementById('cfg-work-file-root-field');
  const rootNote = rootField?.querySelector('p.config-reading-note:not([role="status"])');
  if (rootNote) setFieldHint(rootNote, rootNote.textContent, { label: rootField.querySelector('label') });
  const teamField = document.getElementById('cfg-team-auto-approve-field');
  const teamNote = teamField?.querySelector('small');
  if (teamNote) setFieldHint(teamNote, teamNote.textContent, { label: teamField.querySelector('strong') });
  // 外观页新增启动动画入口后仍保持一屏：静态说明收进 ⓘ，工作目录等动态状态照常就地显示。
  const readingGrid = document.getElementById('cfg-card-font-size')?.closest('.config-reading-grid');
  const readingNote = readingGrid?.nextElementSibling;
  if (readingNote?.classList.contains('config-reading-note')) {
    setFieldHint(readingNote, readingNote.textContent, { label: readingGrid.querySelector('label') });
  }
  for (const id of ['cfg-composer-enter-field', 'cfg-codeagent-quota-placement-field']) {
    const field = document.getElementById(id);
    const note = field?.querySelector('.config-reading-note');
    if (note) setFieldHint(note, note.textContent, { label: field.querySelector('label') });
  }
  const bar = document.createElement('div');
  bar.className = 'cfg-tabs';
  bar.id = 'cfg-tabs';
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', '设置分类');
  bar.innerHTML = TABS.map(t => `<button type="button" role="tab" class="cfg-tab" data-cfg-tab-btn="${t.id}" id="cfg-tab-${t.id}" aria-selected="false">${t.label}</button>`).join('');
  let active = 'general', applying = false;

  // 搜索框和页签条固定在最上面（别的模块后来 prepend 的入口行会把它们挤下去，这里挪回顶上）。
  function place() {
    const search = view.querySelector(':scope > .hub-feature-search');
    if (search) {
      if (view.firstElementChild !== search) view.prepend(search);
      if (search.nextElementSibling !== bar) search.after(bar);
    } else if (view.firstElementChild !== bar) view.prepend(bar);
  }

  // 只看别人设的显隐（hidden 属性、edition-trim 的 display:none），先摘掉自己的隐藏类再读。
  function presentTabs(kids, tabs) {
    kids.forEach(c => c.classList.remove('cfg-tab-off'));
    const present = new Set();
    kids.forEach((c, i) => { if (!c.hidden && window.getComputedStyle(c).display !== 'none') present.add(tabs[i]); });
    return present;
  }

  function apply() {
    if (applying) return;
    applying = true;
    try {
      place();
      const kids = [...view.children];
      const tabs = classifyChildren(kids);
      const present = presentTabs(kids, tabs);
      if (!present.has(active)) active = TABS.find(t => present.has(t.id))?.id || 'general';
      kids.forEach((c, i) => {
        if (c.dataset.cfgTab !== tabs[i]) c.dataset.cfgTab = tabs[i];
        c.classList.toggle('cfg-tab-off', tabs[i] !== 'shared' && tabs[i] !== active);
      });
      bar.querySelectorAll('[data-cfg-tab-btn]').forEach(b => {
        const id = b.dataset.cfgTabBtn, on = id === active, show = present.has(id);
        if (b.hidden === show) b.hidden = !show;
        if (b.getAttribute('aria-selected') !== String(on)) b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
      });
    } finally { applying = false; }
  }

  function activate(id) {
    if (!TABS.some(t => t.id === id)) return false;
    active = id; apply();
    return active === id;
  }

  // 让 el 所在的页签显示出来（搜索跳转、回执齿轮、通知设置入口用）。
  function reveal(el) {
    if (!el || !view.contains(el)) return false;
    let node = el;
    while (node && node.parentElement !== view) node = node.parentElement;
    if (!node) return false;
    if (!node.dataset.cfgTab) apply();
    const tab = node.dataset.cfgTab;
    return tab === 'shared' || activate(tab);
  }

  bar.addEventListener('click', event => {
    const b = event.target.closest('[data-cfg-tab-btn]');
    if (b) activate(b.dataset.cfgTabBtn);
  });
  bar.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const shown = [...bar.querySelectorAll('[data-cfg-tab-btn]:not([hidden])')];
    const i = shown.findIndex(b => b.dataset.cfgTabBtn === active);
    const next = event.key === 'Home' ? shown[0] : event.key === 'End' ? shown[shown.length - 1] : shown[(i + (event.key === 'ArrowRight' ? 1 : -1) + shown.length) % shown.length];
    if (!next) return;
    event.preventDefault();
    activate(next.dataset.cfgTabBtn);
    next.focus();
  });

  // 默认页签由打开流程同步初始化；观察器只更新布局，保留入口 reveal 指定的目标。
  new window.MutationObserver(() => {
    if (!modal.classList.contains('hidden')) apply();
  }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  new window.MutationObserver(records => {
    if (records.some(r => (r.type === 'childList' && r.target === view) || r.target.parentElement === view)) apply();
  }).observe(view, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'style'] });
  apply();
  return { activate, reveal, apply, get active() { return active; } };
}

function mountSettingsTabs({ document, window }) {
  if (!document.getElementById('config-main-view') && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mountSettingsTabs({ document, window }), { once: true });
    return null;
  }
  if (window.__hubSettingsTabs) return window.__hubSettingsTabs;
  const api = createSettingsTabs({ document, window });
  if (api) window.__hubSettingsTabs = api;
  return api;
}

const api = { TABS, RULES, classifyChildren, ruleTab, mountSettingsTabs, createSettingsTabs };
if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById) mountSettingsTabs({ document, window });
else if (typeof module !== 'undefined') module.exports = api;
})();
