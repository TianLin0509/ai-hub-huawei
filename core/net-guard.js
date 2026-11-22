'use strict';
// 网络用量与上传限制的统一入口（2026-11-23）。
// 具体规则在可选模块里；这台电脑没有它时（普通安装），这里返回一个什么都不做的直通对象：请求原样发出，不装任何钩子，不写任何文件。
let real;
function load() {
  if (real !== undefined) return real;
  real = null;
  return real;
}
const passthrough = Object.freeze({
  restricted: false,
  send: (fetchFn, url, init) => fetchFn(url, init),
  prepare: (_url, init = {}) => init,
  inspect: () => ({ reason: null, bytes: 0, ours: false }),
});
function getGate() { const m = load(); return m ? m.getGate() : passthrough; }
function installAll(electron) { const m = load(); return m ? m.installAll(electron) : { restricted: false }; }
function installNodeGuard(opts) { const m = load(); return m ? m.installNodeGuard({ gate: m.getGate(), ...(opts || {}) }) : { installed: false }; }
function available() { return !!load(); }
module.exports = { getGate, installAll, installNodeGuard, available };
