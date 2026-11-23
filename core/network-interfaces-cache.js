'use strict';
// 网卡清单的短时缓存（2026-11-23）。
// Windows 上 os.networkInterfaces() 是同步调用（底层 GetAdaptersAddresses），装了 VPN / 虚拟网卡的电脑一次要几十毫秒，
// 实测 12 个会话同时干活时，主进程每分钟在这里花掉约 1.7 秒、单次最长上百毫秒。界面每 5 秒读一次反馈收件状态、
// 侧栏网速条每几秒读一次本机地址，都会调它；网卡几十秒内基本不会变，读同一份结果即可。
const os = require('os');

const DEFAULT_TTL_MS = 30000;

function createNetworkInterfacesCache({ read = () => os.networkInterfaces(), now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
  let value = null, at = -Infinity;
  function get() {
    if (value && now() - at < ttlMs) return value;
    value = read() || {};
    at = now();
    return value;
  }
  get.invalidate = () => { value = null; at = -Infinity; };
  return get;
}

const cachedNetworkInterfaces = createNetworkInterfacesCache();

module.exports = { cachedNetworkInterfaces, createNetworkInterfacesCache, DEFAULT_TTL_MS };
