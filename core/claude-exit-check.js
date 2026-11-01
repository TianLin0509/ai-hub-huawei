'use strict';
// 账号页「检查出口」（2026-10-31 用户要）：一键核对本机每个 Claude 出口是否连通、出口 IP 是否对、延迟多少。
const { requestViaProxy } = require('./claude-account-network');

// Every exit this computer can use: the shared one, each dedicated IP an account runs on, and wired routes no account uses yet.
function exitList({ profiles = [], sharedProxy = null, sharedIp = '', wired = {} }) {
  const exits = new Map();
  const add = (key, value) => { if (!exits.has(key)) exits.set(key, { ...value, accounts: [] }); return exits.get(key); };
  add('shared', { key: 'shared', shared: true, proxy: sharedProxy, expected: sharedIp || null });
  for (const p of profiles) {
    const n = p.network;
    if (n?.expectedIp && n.proxy) add(n.expectedIp, { key: n.expectedIp, shared: false, proxy: n.proxy, proxyCaFile: n.proxyCaFile, expected: n.expectedIp }).accounts.push(p.label || p.id);
    else exits.get('shared').accounts.push(p.label || p.id);
  }
  for (const [ip, n] of Object.entries(wired)) add(ip, { key: ip, shared: false, proxy: n.proxy, proxyCaFile: n.proxyCaFile, expected: ip });
  return [...exits.values()];
}

// Three requests in a row through the exit; the first includes connecting the tunnel, the median is what a person feels.
async function probeExit(exit, { request = requestViaProxy, rounds = 3, timeoutMs = 15000, now = () => Date.now() } = {}) {
  const { proxy, proxyCaFile, ...shown } = exit;
  if (!proxy) return { ...shown, state: 'unwired', ms: [] };
  const ms = []; let ip = '', bad = 0;
  for (let i = 0; i < rounds; i++) {
    const started = now();
    try {
      const response = await request(proxy, 'https://api.ipify.org', {}, timeoutMs, proxyCaFile);
      const text = String(await response.text()).trim();
      if (response.status !== 200) { bad++; continue; }
      ms.push(now() - started); ip = ip || text;
    } catch { bad++; }
  }
  const sorted = [...ms].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const state = !ms.length ? 'unreachable' : exit.expected && ip !== exit.expected ? 'mismatch' : 'ok';
  return { ...shown, ip, state, ms, median, failed: bad, checkedAt: new Date().toISOString() };
}

async function checkExits(input, options = {}) {
  return Promise.all(exitList(input).map(e => probeExit(e, options)));
}

module.exports = { exitList, probeExit, checkExits };
