'use strict';
// 桌宠待办卡片的 preload（2026-11-26）：只开放卡片自己用的几条 IPC。
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, fn) {
  if (typeof fn !== 'function') return;
  ipcRenderer.on(channel, (_event, payload) => fn(payload));
}

contextBridge.exposeInMainWorld('hubPetTodo', {
  ready: () => ipcRenderer.send('hub-pet-todo:ready'),
  size: (box) => ipcRenderer.send('hub-pet-todo:size', { width: Number(box && box.width) || 0, height: Number(box && box.height) || 0 }),
  add: (text) => ipcRenderer.invoke('hub-pet-todo:add', String(text || '').slice(0, 400)),
  act: (payload) => ipcRenderer.invoke('hub-pet-todo:act', payload && typeof payload === 'object' ? payload : {}),
  preview: (text) => ipcRenderer.invoke('hub-pet-todo:preview', String(text || '').slice(0, 400)),
  onState: (fn) => on('hub-pet-todo:state', fn),
  onOpen: (fn) => on('hub-pet-todo:open', fn),
});
