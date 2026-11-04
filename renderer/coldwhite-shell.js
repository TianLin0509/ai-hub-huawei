'use strict';

// Layout only: preserve each existing panel, IPC owner and stateful DOM element.
function installColdwhiteShell(doc = globalThis.document) {
  const app = doc?.getElementById('app-container');
  if (!app || doc.getElementById('hub-system-footer')) return;
  const badge = doc.getElementById('coldwhite-preview-label');
  if (badge && globalThis.process?.env?.CLAUDE_HUB_UI_PREVIEW === 'coldwhite') {
    badge.hidden = false;
    badge.textContent = '冷白预览 0.2';
  }
  const footer = doc.createElement('footer');
  footer.id = 'hub-system-footer';
  footer.setAttribute('aria-label', '系统、账户用量与网络状态；点击详情查看全部读数');
  footer.tabIndex = 0;
  const strip = doc.getElementById('sidebar-strip');
  if (strip) footer.append(strip);
  const usage = doc.getElementById('rail-usage');
  if (usage) footer.append(usage);
  const codeagentQuota = doc.getElementById('rail-codeagent-quota');
  if (codeagentQuota) footer.append(codeagentQuota);
  app.append(footer);
  require('./status-footer-layout').installStatusFooterLayout(doc);
  installHwShell(doc);
  const panelIds = ['team-page', 'cloud-page', 'hub-workspace', 'rules-panel', 'writing-panel', 'account-page', 'codeagent-accounts-page', 'xresearch-panel', 'study-panel', 'progress-panel'];
  const watched = new Set();
  const navigation = ['btn-home','btn-rules','btn-assistant','btn-company-assistant','btn-company-meeting','btn-company-ppt',
    'btn-company-forum','btn-research','btn-study','btn-progress','btn-wireless','btn-rail-memo','btn-rail-capabilities','btn-cloud','btn-team','btn-rail-accounts','btn-writing'];
  let scheduled = false;
  const sync = () => {
    scheduled = false;
    const visible = panelIds.some(id => {
      const panel = doc.getElementById(id);
      return panel && !panel.hidden && doc.defaultView.getComputedStyle(panel).display !== 'none';
    });
    app.classList.toggle('workspace-active', visible);
    const isVisible = id => {
      const e = doc.getElementById(id);
      return e && !e.hidden && doc.defaultView.getComputedStyle(e).display !== 'none';
    };
    let current = 'btn-home';
    if (isVisible('team-page')) {
      current = 'btn-team';
    } else if (isVisible('cloud-page')) {
      current = 'btn-cloud';
    } else if (isVisible('hub-workspace')) {
      current = doc.getElementById('hub-workspace').dataset.area === 'review' ? 'btn-rail-memo' : 'btn-rail-capabilities';
    } else {
      for (const [panel, button] of [['rules-panel','btn-rules'],['account-page','btn-rail-accounts'],['codeagent-accounts-page','btn-rail-accounts'],['writing-panel','btn-writing'],['xresearch-panel','btn-research'],['study-panel','btn-study'],['progress-panel','btn-progress']]) {
        if (isVisible(panel)) { current = button; break; }
      }
      if (current === 'btn-home' && doc.body.classList.contains('wireless-page-open')) current = 'btn-wireless';
      // 公司版「助理」页（core/company-assistant）
      if (current === 'btn-home' && doc.body.classList.contains('company-assistant-page-open')) current = 'btn-company-assistant';
      if (current === 'btn-home' && doc.body.classList.contains('company-meeting-page-open')) current = 'btn-company-meeting';
      if (current === 'btn-home' && doc.body.classList.contains('company-ppt-page-open')) current = 'btn-company-ppt';
      // 公司版「论坛」页（core/company-forum）
      if (current === 'btn-home' && doc.body.classList.contains('company-forum-page-open')) current = 'btn-company-forum';
      if (current === 'btn-home' && (doc.body.classList.contains('assistant-session-active') || doc.body.classList.contains('assistant-page-open'))) current = 'btn-assistant';
    }
    for (const id of navigation) {
      const button = doc.getElementById(id);
      if (!button) continue;
      button.classList.toggle('cw-current', id === current);
      if (id === current) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  };
  const schedule = () => {
    if (!scheduled) { scheduled = true; doc.defaultView.requestAnimationFrame(sync); }
  };
  const observer = new doc.defaultView.MutationObserver(schedule);
  observer.observe(doc.body, { attributes: true, attributeFilter: ['class'] });
  const discover = () => {
    for (const id of panelIds) {
      const panel = doc.getElementById(id);
      if (panel && !watched.has(panel)) {
        watched.add(panel);
        observer.observe(panel, { attributes: true, attributeFilter: ['style', 'hidden', 'class', 'data-area'] });
      }
    }
    schedule();
  };
  // Observe panel mounting, not high-frequency conversation descendants.
  const mounts = new doc.defaultView.MutationObserver(discover);
  mounts.observe(doc.body, { childList: true });
  mounts.observe(app, { childList: true });
  discover();
}

// 公司版外壳换皮（定稿 CDCCBCC，样式见 styles/hw-shell.css）。只加外观钩子：
// data-hw-shell 打开换皮；分组标题是不可聚焦的说明节点；data-hw-rail 按导航实际宽度切换宽 / 窄两种排版。
// 不移动、不替换任何按钮，顺序靠 CSS order。
const HW_NAV_CAPS = [['work', '工作'], ['tools', '工具'], ['community', '社区']];
function installHwShell(doc, target = require('../core/distribution').target) {
  if (target !== 'company') return false;
  const root = doc.documentElement, rail = doc.getElementById('scene-rail');
  root.dataset.hwShell = '1';
  const list = rail?.querySelector('.rail-navigation');
  if (list && !list.querySelector('.hw-nav-cap')) {
    for (const [key, text] of HW_NAV_CAPS) {
      const cap = doc.createElement('div');
      cap.className = 'hw-nav-cap'; cap.dataset.cap = key; cap.setAttribute('aria-hidden', 'true'); cap.textContent = text;
      list.append(cap);
    }
  }
  const mode = () => { root.dataset.hwRail = (rail?.getBoundingClientRect().width || 0) >= 150 ? 'wide' : 'narrow'; };
  mode();
  const View = doc.defaultView;
  if (rail && View?.ResizeObserver) new View.ResizeObserver(mode).observe(rail);
  return true;
}

module.exports = { installColdwhiteShell, installHwShell };
