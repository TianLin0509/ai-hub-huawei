'use strict';
// 工作线程：日志可能有几 GB，放主线程会让界面卡住。
const { parentPort, workerData } = require('node:worker_threads');
const { scanAll } = require('./scanner');

scanAll({ ...workerData, onStage: stage => parentPort.postMessage({ stage }) })
  .then(result => parentPort.postMessage({ result }))
  .catch(error => parentPort.postMessage({ error: error.message || String(error) }));
