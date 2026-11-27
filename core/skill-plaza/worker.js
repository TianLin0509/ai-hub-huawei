'use strict';
// 技能广场的 Worker 入口：workerData = { op, ctx }，回 { ok, data } 或 { ok:false, error, residue }。
const { parentPort, workerData } = require('node:worker_threads');
const { OPS } = require('./ops');

try {
  const fn = OPS[workerData?.op];
  if (!fn) throw new Error('技能广场：未知操作');
  parentPort.postMessage({ ok: true, data: fn(workerData.ctx) });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message, residue: error.residue || undefined });
}
