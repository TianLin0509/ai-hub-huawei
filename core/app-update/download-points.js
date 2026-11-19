'use strict';
// 下载点登记（r58）：各组件模块把「内源上找什么」登记在这里，界面的下载源标识（download-source:status）按编号来取。
// provider 返回 source-status.check 的 spec：{ items:[{file, release, version}] } 或 { files, release, version, strict }。
// 规则：登记的文件名和内源版本名必须与该组件真正下载时传给 downloadWithFallback 的完全一致。
const providers = new Map();
function register(point, provider) { if (point && typeof provider === 'function') providers.set(String(point), provider); }
function lookup(point) {
  const id = String(point || '');
  if (providers.has(id)) return providers.get(id);
  for (const [key, fn] of providers) if (key.endsWith(':') && id.startsWith(key)) return fn;
  return null;
}
function list() { return [...providers.keys()]; }
function _reset() { providers.clear(); }
module.exports = { register, lookup, list, _reset };
