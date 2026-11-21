'use strict';
// 关窗口最小化到托盘（2026-11-12 同事提出）：「可选功能」里打开后，点主窗口的关闭只把窗口藏起来，
// 托盘留一个图标：单击或双击图标、右键「打开 AI Hub」都能把窗口叫回来，右键「退出 AI Hub」才真正退出。
// 默认关：老习惯是关窗口就退出（会话随之收尾），不替用户改。开关存在 optional-features.json 的 tray 项。

// closeChoice（2026-11-21，同事反馈「点关闭直接退出，找不到最小化到托盘」）：托盘没开、也从没选过时，
// 第一次点关闭就地问一句「最小化到托盘 / 退出」，选择记住，之后在「可选功能」里随时改。
//   { pending(): bool, ask(win): 'tray' | 'quit' | 'cancel', remember(tray: bool) }
function createTrayController({ Tray, Menu, getIcon, getMainWindow, focusWindow, quit, isEnabled, canNotify = () => true, closeChoice = null, logger = console, title = 'AI Hub' }) {
  let tray = null;
  let quitting = false;
  let hintShown = false;

  function ensureTray() {
    if (tray) return tray;
    tray = new Tray(getIcon());
    tray.setToolTip(title);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `打开 ${title}`, click: () => focusWindow() },
      { type: 'separator' },
      { label: `退出 ${title}`, click: () => { quitting = true; quit(); } },
    ]));
    tray.on('click', () => focusWindow());
    tray.on('double-click', () => focusWindow());
    return tray;
  }

  function destroyTray() {
    if (!tray) return;
    try { tray.destroy(); } catch (_) {}
    tray = null;
  }

  // 开关变化或启动时调用：开着就常驻托盘图标，关掉就收起（窗口藏着时先叫回来，免得找不到）。
  function sync() {
    if (isEnabled()) { try { ensureTray(); } catch (error) { logger.warn?.('[tray] 托盘图标没建起来：', error && error.message); } return; }
    const win = getMainWindow();
    if (win && !win.isDestroyed() && !win.isVisible()) focusWindow();
    destroyTray();
  }

  // 界面语言切换后重建托盘菜单（菜单文字在建菜单时按当前语言翻译）。
  function refresh() {
    if (!tray) return;
    destroyTray();
    sync();
  }

  function askFirstClose(event, win) {
    let pending = false;
    try { pending = !!(closeChoice && closeChoice.pending()); } catch (_) { pending = false; }
    if (!pending) return 'quit';
    let choice = 'quit';
    try { choice = closeChoice.ask(win); } catch (error) { logger.warn?.('[tray] 关窗选择框没弹出来，按原样退出：', error && error.message); return 'quit'; }
    // 点了「取消」或按 Esc：窗口不关，下次点关闭再问。
    if (choice === 'cancel') { event.preventDefault(); return 'cancel'; }
    try { closeChoice.remember(choice === 'tray'); } catch (error) { logger.warn?.('[tray] 关窗选择没存上：', error && error.message); }
    return choice === 'tray' ? 'tray' : 'quit';
  }

  // 主窗口 close 事件里先问它：返回 true 表示已藏到托盘（或用户取消了关闭），调用方别再走退出流程。
  function interceptClose(event) {
    if (quitting) return false;
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return false;
    if (!isEnabled()) {
      const choice = askFirstClose(event, win);
      if (choice === 'cancel') return true;
      if (choice !== 'tray' || !isEnabled()) return false;
    }
    try { ensureTray(); } catch (error) { logger.warn?.('[tray] 托盘图标没建起来，按原样退出：', error && error.message); return false; }
    event.preventDefault();
    win.hide();
    if (!hintShown && canNotify() && typeof tray.displayBalloon === 'function') {
      hintShown = true;
      try { tray.displayBalloon({ title, content: '已最小化到托盘，单击图标打开；右键可退出。', noSound: true }); } catch (_) {}
    }
    return true;
  }

  return {
    sync,
    refresh,
    interceptClose,
    markQuitting() { quitting = true; },
    resetQuitting() { quitting = false; },
    dispose: destroyTray,
    get active() { return !!tray; },
  };
}

// 首次关窗的选择框（Electron dialog.showMessageBoxSync，按钮顺序即返回下标）。文字经 main/i18n-main.js 按词典翻译。
const CLOSE_CHOICE_BUTTONS = ['最小化到托盘', '退出 AI Hub', '取消'];
function closeChoiceDialogOptions() {
  return {
    type: 'question',
    title: '关闭 AI Hub',
    message: '点关闭时，要最小化到托盘还是退出？',
    detail: [
      '最小化到托盘：窗口收到右下角托盘，会话照常在后台跑；单击托盘图标打开，右键「退出 AI Hub」才真正退出。',
      '退出：结束所有会话，关掉 Hub。',
      '',
      '这个选择会记住，以后可在「设置菜单 → 可选功能 → 关窗口时最小化到托盘」里改。',
    ].join('\n'),
    buttons: CLOSE_CHOICE_BUTTONS.slice(),
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
}
function closeChoiceFromButton(index) {
  return index === 0 ? 'tray' : index === 1 ? 'quit' : 'cancel';
}

module.exports = { createTrayController, closeChoiceDialogOptions, closeChoiceFromButton };
