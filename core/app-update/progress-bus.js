'use strict';
// 主进程 main/download-source-ipc.js 统一转发给界面（download-progress:update），界面用 renderer/download-progress-view.js 画。
// 每个点最多 4 次/秒；阶段变化（开始、完成、出错）立刻发。
const { EventEmitter } = require('node:events');
const bus = new EventEmitter();
bus.setMaxListeners(50);
const last = new Map();   // point → { at, phase }

function emit(point, progress = {}) {
  const key = String(point || '');
  if (!key) return;
  const now = Date.now(), prev = last.get(key), phase = progress.phase || 'downloading';
  if (prev && prev.phase === phase && phase === 'downloading' && now - prev.at < 250 && progress.received !== progress.total) return;
  last.set(key, { at: now, phase });
  if (phase === 'done' || phase === 'error' || phase === 'cancelled') last.delete(key);
  bus.emit('progress', { ...progress, phase, point: key, at: now });
}
const on = fn => { bus.on('progress', fn); return () => bus.off('progress', fn); };

module.exports = { emit, on };
