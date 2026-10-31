'use strict';
// 发行目标的界面裁剪（公司纯净版：只留 CodeAgent，不要额度条和账号页）。
// 在 index.html 里排在 workspace-controller.js 之前，各控制器初始化时看到的已经是裁剪后的界面。
// 主仓库与公开社区版没有这些设置，这里什么也不做。
(() => {
  const { allowedKinds, kindAllowed, featureEnabled } = require('../core/distribution');
  if (allowedKinds) {
    // 启动中心：只留允许的会话类型；没有可恢复的类型时，连「恢复会话」这一页一起去掉。
    document.querySelectorAll('.new-session-option[data-kind]').forEach(button => { if (!kindAllowed(button.dataset.kind)) button.remove(); });
    document.querySelectorAll('[data-resume-kind]').forEach(button => { if (!kindAllowed(button.dataset.resumeKind)) button.remove(); });
    if (!document.querySelector('[data-resume-kind]')) {
      document.querySelector('[data-launch-intent="resume"]')?.remove();
      document.querySelector('[data-launch-panel="resume"]')?.remove();
    }
    // 会话搜索的提供方筛选：去掉不提供的 AI（「全部」「其他模型」「群聊」不是 AI 名，保留）。
    const { ALL_AI_KINDS } = require('../core/ai-kinds');
    const { isOtherSearchProvider } = require('../core/session-search-providers');
    document.querySelectorAll('.session-search-chip[data-provider]').forEach(chip => {
      const provider = chip.dataset.provider;
      if (ALL_AI_KINDS.includes(provider) && !kindAllowed(provider)) chip.remove();
      // 留下的 AI 按钮常显（个人版零命中时隐藏，公司版只有这几个，得一直在）。
      else if (ALL_AI_KINDS.includes(provider)) { chip.hidden = false; chip.dataset.alwaysVisible = '1'; }
    });
    // 允许的 AI 都有自己的按钮时，「其他」永远是 0（公司版：全部 / CodeAgent / 群聊）。
    if (!allowedKinds.some(isOtherSearchProvider)) document.querySelector('.session-search-chip[data-provider="other"]')?.remove();
    document.querySelectorAll('.session-search-specific-providers').forEach(group => { if (!group.querySelector('[data-provider]')) group.remove(); });
    // 侧栏模型选项由 session-list-renderer 按允许的家族生成；同品牌可能有多个后端。
  }
  // 产品显示名与版本标注（公司版 2026-10-13 起有自己的名字和「内测先锋版」标注，见 target.json）；社区版没改名就不动。
  const { productName, editionBadge } = require('../core/distribution');
  if (productName && productName !== 'AI Hub Community') {
    const strong = document.querySelector('#hub-identity strong');
    if (strong) strong.textContent = productName;
    const brand = document.querySelector('.home-welcome-brand');
    if (brand && brand.lastChild && brand.lastChild.nodeType === 3) brand.lastChild.textContent = ' ' + productName;
    document.title = productName;
    document.querySelectorAll('#btn-new-hub').forEach(b => { b.title = '新建 ' + productName + ' 实例'; b.setAttribute('aria-label', b.title); });
  }
  if (editionBadge) {
    const strong = document.querySelector('#hub-identity strong');
    if (strong && !document.getElementById('hub-edition-badge')) {
      const badge = document.createElement('span');
      badge.id = 'hub-edition-badge'; badge.className = 'hub-edition-badge'; badge.textContent = editionBadge;
      strong.after(badge);
    }
  }
  const hide = [];
  if (!featureEnabled('launchEffort')) {
    // 副标题和文案同一开关：公司版不讲「提供方」「工作根」。
    const setText = (selector, text) => { const el = document.querySelector(selector); if (el) el.textContent = text; };
    setText('#launch-intent-group small', '多个 AI 一起讨论、分工');
    setText('#launch-intent-resume small', '接着聊以前的会话');
    setText('#launch-center-group-panel .launch-center-panel-head span', '选好成员和工作目录，就能开始');
    setText('#launch-center-resume-panel .launch-center-panel-head span', '点一下，在原来的文件夹里接着聊');
    setText('[data-resume-kind="codeagent-resume"] small', '列出电脑上所有 CodeAgent 历史');
    setText('.launch-center-panel-footer > span', '');
    setText('[data-workspace-mode="default"] small', '开在默认文件夹，各会话的文件互相可见');
    setText('[data-workspace-mode="scratch"] small', '新建一个空文件夹，和其他任务互不影响');
    setText('[data-workspace-mode="existing"] small', '选择电脑上已有的文件夹');
    hide.push('.launch-center-resume-note', '#new-session-tuning-details');
    // 「昨日之我」同事猜不出是搜索，公司版改个直白的名字（2026-10-30 用户同意）。
    setText('#btn-global-search span', '搜索历史');
    setText('#session-search-title', '搜索历史');
    document.getElementById('btn-global-search')?.setAttribute('title', '搜索历史 (Ctrl+Shift+F)');
    document.getElementById('btn-rail-memo')?.setAttribute('title', '回顾 · 备忘与搜索历史');
  }
  if (!featureEnabled('projectLibrary')) hide.push('.session-projects');
  // 筛选控件从页面上去掉，侧栏就按「全部」显示，升级前选过的筛选也不会留下来挡住会话。
  if (!featureEnabled('sessionFilters')) {
    document.getElementById('session-model-filter')?.closest('label')?.remove();
    document.getElementById('session-project-filter')?.closest('label')?.remove();
    hide.push('label[for="session-search-project"]');
  }
  if (!featureEnabled('completionNotification')) hide.push('#completion-notification-toggle', '.config-notification-title', '#config-notification-card');
  if (!featureEnabled('desktopOrganizer')) hide.push('#btn-desktop-organizer');
  if (!featureEnabled('multiInstance')) hide.push('#btn-new-hub');
  if (hide.length) {
    const style = document.createElement('style');
    style.textContent = hide.join(',') + '{display:none!important}';
    document.head.appendChild(style);
  }
  // 底部状态栏的「余量」：各家 AI 账号的剩余额度，CodeAgent 没有。
  if (!featureEnabled('quotaBar')) document.getElementById('rail-usage')?.remove();
  // 左侧「账号」：各家 AI 网页与命令行账号；按钮留在页面里（别处会程序化点击它来关账号页），只是不显示。
  if (!featureEnabled('accounts')) {
    const button = document.getElementById('btn-rail-accounts');
    if (button) button.style.display = 'none';
  }
})();
