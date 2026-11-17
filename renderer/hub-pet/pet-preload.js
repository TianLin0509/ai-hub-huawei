'use strict';
// 桌宠窗口的 preload：只开放桌宠自己用的几条 IPC。
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, fn) {
  if (typeof fn !== 'function') return;
  ipcRenderer.on(channel, (_event, payload) => fn(payload));
}

contextBridge.exposeInMainWorld('hubPet', {
  ready: () => ipcRenderer.send('hub-pet:ready'),
  hit: (value) => ipcRenderer.send('hub-pet:hit', !!value),
  press: (target) => ipcRenderer.send('hub-pet:press', { target: String(target || 'pet') }),
  release: () => ipcRenderer.send('hub-pet:release'),
  bodyBox: (box) => ipcRenderer.send('hub-pet:body-box', box && typeof box === 'object' ? { left: +box.left || 0, right: +box.right || 0, top: +box.top || 0, bottom: +box.bottom || 0, role: String(box.role || '').slice(0, 40) } : null),
  menu: () => ipcRenderer.send('hub-pet:menu'),
  // 2026-11-12：鼠标在身上来回蹭 = 摸摸。
  pet: () => ipcRenderer.send('hub-pet:pet'),
  openNotice: (item) => ipcRenderer.send('hub-pet:open-notice', { id: String(item && item.id || ''), sessionId: item && item.sessionId ? String(item.sessionId) : '' }),
  // 2026-11-09：通知卡片（停留、收起）、问助理输入框。
  hold: (on) => ipcRenderer.send('hub-pet:hold', on === true),
  dismiss: () => ipcRenderer.send('hub-pet:dismiss'),
  // 2026-11-17：闲聊气泡下的回应按钮（up 喜欢 / down 少说 / snooze 久坐提醒晚 20 分钟）。
  reply: (id, choice) => ipcRenderer.send('hub-pet:reply', { id: String(id || '').slice(0, 160), choice: String(choice || '').slice(0, 12) }),
  ask: (text, enableAssistant = false) => ipcRenderer.send('hub-pet:ask', { text: String(text || '').slice(0, 2000), enableAssistant: enableAssistant === true }),
  askClose: () => ipcRenderer.send('hub-pet:ask-close'),
  // 2026-11-17 r27c：点会话状态灯直达那个会话。
  openSession: (id) => ipcRenderer.send('hub-pet:open-session', String(id || '').slice(0, 160)),
  // 2026-11-17 r27f：悬停快捷钮（问 / 信 / 摸）、系统偏好（减少动态效果）、鼠标靠近。
  quick: (type) => ipcRenderer.send('hub-pet:quick', String(type || '').slice(0, 12)),
  prefs: (p) => ipcRenderer.send('hub-pet:prefs', { reducedMotion: !!(p && p.reducedMotion) }),
  onNear: (fn) => on('hub-pet:near', fn),
  onAskOpen: (fn) => on('hub-pet:ask-open', fn),
  onAskResult: (fn) => on('hub-pet:ask-result', fn),
  onState: (fn) => on('hub-pet:state', fn),
  onMotion: (fn) => on('hub-pet:motion', fn),
  onPanel: (fn) => on('hub-pet:panel', fn),
  onProbe: (fn) => on('hub-pet:probe', fn),
});
