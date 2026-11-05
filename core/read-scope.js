'use strict';
// 一次同步计算内，同一个文件只读一次。只保存文件原文（读失败也保存同一个错误），每个调用方各自 JSON.parse，
// 拿到的是独立对象，改动不会串到别的账号。作用域随 withReadScope 结束而清空，不是长期缓存，也不用于凭据文件。
// 只能包同步函数：同步代码执行期间不会插入别的写入逻辑，所以读到的是同一版内容。作用域外和传入替身 fs 时都直接读文件。
const fs = require('fs');

let scope = null;

function withReadScope(fn) {
  if (scope) return fn();
  scope = new Map();
  try { return fn(); }
  finally { scope = null; }
}

function readTextInScope(file, fsModule = fs) {
  if (!scope || fsModule !== fs) return fsModule.readFileSync(file, 'utf8');
  if (!scope.has(file)) {
    try { scope.set(file, { text: fs.readFileSync(file, 'utf8') }); }
    catch (error) { scope.set(file, { error }); }
  }
  const entry = scope.get(file);
  if (entry.error) throw entry.error;
  return entry.text;
}

module.exports = { withReadScope, readTextInScope };
