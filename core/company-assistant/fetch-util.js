'use strict';

// Electron follows the system proxy/PAC settings. Node scripts and tests can
// supply their own fetch implementation or fall back to the global one.
function resolveFetch(fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl;
  try {
    const electron = require('electron');
    if (electron && electron.net && typeof electron.net.fetch === 'function') return (...args) => electron.net.fetch(...args);
  } catch (_) {}
  if (typeof globalThis.fetch === 'function') return globalThis.fetch;
  throw new Error('这个环境没有可用的下载能力，请重装 Hub');
}

module.exports = { resolveFetch };
