'use strict';
// 桌宠待办卡片（2026-11-26，同事需求：桌宠当一个快捷、简单的待办入口）。
// 双击桌宠或右键「打开待办 / 添加待办…」弹出一张小卡片：一行输入回车就记下，勾掉算完成，拖动排序。
// 数据就是桌宠提醒（core/company-assistant/pet-reminders.js），经 noticeBus 读写，不另起一套；只存本机。
// 窗口照右键菜单的做法：透明小窗，第一次用时建好，失焦或 Esc 收起；不常驻刷新——只在卡片开着、数据真变了才推一次。
const path = require('path');
const { parseTodo, whenText } = require('../core/hub-pet/todo-parse');

const CARD_W = 312;          // 卡片 284 + 左右各 14 给阴影
const GAP = 8;               // 卡片和桌宠身体之间的空隙

function createTodoCard({ BrowserWindow, ipcMain, rendererDir, noticeBus, ensureOwner = () => null, petBody = () => null, displayFor,
  openAssistant = () => {}, onShown = () => {}, logger = console, now = () => Date.now() }) {
  let win = null, ready = false, size = { width: CARD_W, height: 360 }, pendingOpen = null, disposed = false;
  const alive = () => !!(win && !win.isDestroyed());
  const visible = () => alive() && win.isVisible();
  const available = () => !!noticeBus?.hasTodos?.();
  const fromCard = event => !!(event && alive() && event.sender === win.webContents);
  const send = (channel, payload) => { if (alive() && ready) win.webContents.send(channel, payload); };

  function state() {
    let data = null, error = '';
    try { data = noticeBus.todos(); } catch (e) { error = e.message || '待办读取失败'; }
    return { ...(data || { today: [], later: [], done: [] }), error };
  }
  function push() { if (visible()) send('hub-pet-todo:state', state()); }

  function ensure() {
    if (alive()) return win;
    const parent = ensureOwner();
    ready = false;
    win = new BrowserWindow({
      ...(parent ? { parent } : {}),
      width: CARD_W, height: size.height, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: true, alwaysOnTop: true, hasShadow: false, title: 'AI Hub 桌宠待办',
      webPreferences: { preload: path.join(rendererDir, 'pet-todo-preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    try { win.setAlwaysOnTop(true, 'pop-up-menu'); } catch (_) {}
    win.setMenuBarVisibility?.(false);
    win.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('blur', () => hide());
    win.on('closed', () => { win = null; ready = false; });
    Promise.resolve(win.loadFile(path.join(rendererDir, 'pet-todo.html'))).catch(error => logger.warn?.('[hub-pet] todo card load failed:', error && error.message));
    return win;
  }

  // 放在桌宠身体旁边：左边放得下放左边，否则放右边；底边和身体底边对齐，超出屏幕就往里收。
  function bounds() {
    const body = petBody();
    const anchor = body || { x: 0, y: 0, width: 0, height: 0 };
    const area = displayFor({ x: Math.round(anchor.x + anchor.width / 2), y: Math.round(anchor.y + anchor.height / 2) }).workArea;
    const w = CARD_W, h = Math.max(120, Math.min(area.height, size.height));
    let x = anchor.x - w - GAP + 14, side = 'left';
    if (x < area.x) { x = anchor.x + anchor.width + GAP - 14; side = 'right'; }
    let y = anchor.y + anchor.height - h + 18;
    x = Math.max(area.x, Math.min(area.x + area.width - w, x));
    y = Math.max(area.y, Math.min(area.y + area.height - h, y));
    return { bounds: { x: Math.round(x), y: Math.round(y), width: w, height: Math.round(h) }, side };
  }

  // focus：add＝光标放进输入框（右键「添加待办…」和双击都这样）。
  function open({ focus = 'add' } = {}) {
    if (disposed || !available()) return false;
    ensure();
    const show = () => {
      if (!alive()) return;
      const { bounds: b, side } = bounds();
      win.setBounds(b, false);
      send('hub-pet-todo:state', state());
      win.show();
      win.focus();
      send('hub-pet-todo:open', { focus, side });
      try { onShown(); } catch (_) {}
    };
    if (ready) show(); else pendingOpen = show;
    return true;
  }
  function hide() { if (visible()) win.hide(); }
  // 返回 'closed'（本来开着，收起了）、'opened'，或 false（待办不可用，调用方改走别的入口）。
  function toggle(opts) { if (visible()) { hide(); return 'closed'; } return open(opts) ? 'opened' : false; }

  function preview(text) {
    const r = parseTodo(text, now());
    return { title: r.title, when: r.at ? whenText(r.at, now()) : '', later: r.later, warn: r.warn || '' };
  }
  function add(text) {
    const raw = String(text || '').trim();
    if (!raw) return { ok: false, error: '' };
    const r = parseTodo(raw, now());
    try {
      noticeBus.addTodo({ title: r.title, at: r.at, later: r.later });
      return { ok: true, warn: r.warn || '', state: state() };
    } catch (error) { return { ok: false, error: error.message || '没记上，请再试一次' }; }
  }
  function act(a = {}) {
    if (a.type === 'assistant') { hide(); openAssistant({}); return { ok: true }; }
    if (a.type === 'close') { hide(); return { ok: true }; }
    if (!['done', 'reopen', 'remove', 'reorder'].includes(a.type)) return { ok: false };
    let ok = false;
    try { ok = noticeBus.todoAction({ op: a.type, id: a.id, ids: a.ids }); } catch (error) { return { ok: false, error: error.message, state: state() }; }
    return { ok, state: state() };
  }

  const onChanged = () => push();
  noticeBus?.on?.('reminders-changed', onChanged);
  const handlers = {
    'hub-pet-todo:ready': event => { if (!fromCard(event)) return; ready = true; if (pendingOpen) { const fn = pendingOpen; pendingOpen = null; fn(); } },
    'hub-pet-todo:size': (event, box) => {
      if (!fromCard(event) || !box) return;
      const h = Math.round(Number(box.height) || 0);
      if (h < 100 || h > 1200 || h === size.height) return;
      size = { width: CARD_W, height: h };
      if (visible()) win.setBounds(bounds().bounds, false);
    },
  };
  const invokes = {
    'hub-pet-todo:add': (event, text) => (fromCard(event) ? add(text) : null),
    'hub-pet-todo:act': (event, a) => (fromCard(event) ? act(a || {}) : null),
    'hub-pet-todo:preview': (event, text) => (fromCard(event) ? preview(text) : null),
  };
  for (const [ch, fn] of Object.entries(handlers)) ipcMain.on(ch, fn);
  for (const [ch, fn] of Object.entries(invokes)) ipcMain.handle?.(ch, fn);

  function close() { if (alive()) win.destroy(); win = null; ready = false; pendingOpen = null; }
  function dispose() {
    if (disposed) return;
    disposed = true;
    close();
    noticeBus?.removeListener?.('reminders-changed', onChanged);
    for (const [ch, fn] of Object.entries(handlers)) ipcMain.removeListener?.(ch, fn);
    for (const ch of Object.keys(invokes)) ipcMain.removeHandler?.(ch);
  }
  function todayCount() { try { return (noticeBus.todos()?.today || []).length; } catch (_) { return 0; } }

  return { open, hide, toggle, close, dispose, available, visible, todayCount, add, act, preview, state, bounds, debug: () => ({ alive: alive(), visible: visible(), ready, size }) };
}

module.exports = { CARD_W, createTodoCard };
