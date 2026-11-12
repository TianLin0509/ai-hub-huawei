'use strict';
// 关窗口最小化到托盘（2026-11-12 同事提出）：「可选功能」里打开后，点主窗口的关闭只把窗口藏起来，
// 托盘留一个图标：单击或双击图标、右键「打开 AI Hub」都能把窗口叫回来，右键「退出 AI Hub」才真正退出。
// 默认关：老习惯是关窗口就退出（会话随之收尾），不替用户改。开关存在 optional-features.json 的 tray 项。

function createTrayController({ Tray, Menu, getIcon, getMainWindow, focusWindow, quit, isEnabled, logger = console, title = 'AI Hub' }) {
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

  // 主窗口 close 事件里先问它：返回 true 表示已藏到托盘，调用方别再走退出流程。
  function interceptClose(event) {
    if (quitting || !isEnabled()) return false;
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return false;
    try { ensureTray(); } catch (error) { logger.warn?.('[tray] 托盘图标没建起来，按原样退出：', error && error.message); return false; }
    event.preventDefault();
    win.hide();
    if (!hintShown && typeof tray.displayBalloon === 'function') {
      hintShown = true;
      try { tray.displayBalloon({ title, content: '已最小化到托盘，单击图标打开；右键可退出。', noSound: true }); } catch (_) {}
    }
    return true;
  }

  return {
    sync,
    interceptClose,
    markQuitting() { quitting = true; },
    resetQuitting() { quitting = false; },
    dispose: destroyTray,
    get active() { return !!tray; },
  };
}

module.exports = { createTrayController };
