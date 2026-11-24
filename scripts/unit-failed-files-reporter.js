'use strict';
// 只记「哪些测试文件有失败」，给 run-unit-tests.js 单独重跑用。
module.exports = async function* failedFilesReporter(source) {
  const failed = new Set();
  for await (const ev of source) {
    if (ev.type === 'test:fail' && ev.data && ev.data.file) failed.add(ev.data.file);
  }
  yield JSON.stringify([...failed]);
};
