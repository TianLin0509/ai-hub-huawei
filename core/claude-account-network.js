'use strict';

const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const path = require('node:path');
const fs = require('node:fs');
const NOT_SENT = /ERR_(PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|CONNECTION_REFUSED)\b/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

function policy(profile) {
  if (!profile?.network) {
    if (['third', 'fourth'].includes(profile?.id)) throw new Error('Claude 3/4 的专用出口配置缺失，已停止请求；不会使用公共代理');
    return null;
  }
  const p = profile.network;
  if (p.mode !== 'strict' || !/^https:\/\/127\.0\.0\.1:\d{1,5}$/.test(p.proxy || '')
    || !net.isIP(p.expectedIp || '') || Number(new URL(p.proxy).port) > 65535
    || typeof p.proxyCaFile !== 'string' || !path.isAbsolute(p.proxyCaFile) || !fs.existsSync(p.proxyCaFile)
    || typeof p.browserCommand !== 'string' || !path.isAbsolute(p.browserCommand)) {
    throw new Error('Claude 专用出口配置不完整，已停止请求；不会使用公共代理');
  }
  return p;
}

function environment(profile) {
  const p = policy(profile);
  if (!p) return null;
  return { ...Object.fromEntries(PROXY_KEYS.map(k => [k, p.proxy])), NO_PROXY: '', no_proxy: '', BROWSER: p.browserCommand,
    NODE_EXTRA_CA_CERTS: p.proxyCaFile, NODE_TLS_REJECT_UNAUTHORIZED: '1' };
}

// The dedicated egress is for Claude's own traffic. Claude Code sources
// CLAUDE_ENV_FILE before every Bash tool command, so shell tools (git, gh,
// curl, pip, local servers) get the normal route back, while a nested
// `claude` still runs pinned to the account's dedicated egress.
function childShellScript(strictEnv, normalEnv = {}) {
  const q = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
  const lines = ['# AI Hub: the dedicated account egress is for Claude itself; shell tools use the normal route.'];
  for (const key of [...PROXY_KEYS, 'NO_PROXY', 'no_proxy']) {
    lines.push(typeof normalEnv[key] === 'string' ? `export ${key}=${q(normalEnv[key])}` : `unset ${key}`);
  }
  lines.push('unset NODE_EXTRA_CA_CERTS BROWSER');
  lines.push(`claude() { env ${Object.entries(strictEnv).map(([k, v]) => `${k}=${q(v)}`).join(' ')} claude "$@"; }`);
  return lines.join('\n') + '\n';
}

// A config dir's settings.json env outranks inherited variables, so any Claude
// started on this account directory without Hub's overlay (nested via Python,
// a manual terminal, a resumed runtime) must find the dedicated route there.
// Otherwise the account token silently leaves through the shared exit.
function pinSettingsEgress(home, strictEnv) {
  const file = path.join(home, 'settings.json');
  let settings = {};
  if (fs.existsSync(file)) {
    settings = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings.json 不是对象');
  }
  const env = { ...(settings.env || {}), ...strictEnv };
  if (JSON.stringify(env) === JSON.stringify(settings.env || {})) return false;
  const temporary = `${file}.${process.pid}.pin.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...settings, env }, null, 2), 'utf8');
  fs.renameSync(temporary, file);
  return true;
}

// Guard: re-pin every dedicated account dir (profile home + its session runtime
// dirs). Anything that rewrote one with the shared proxy is reported via onDrift.
// sharedEnv: the shared accounts' own proxy settings. A shared account dir that
// ever points at a dedicated route is put back, so no account can hop between
// the proxy IPs in either direction.
function pinDedicatedAccountDirs({ profiles, runtimeRoot, sharedEnv = null, onDrift = () => {} }) {
  const owners = new Map(), sharedIds = new Set(), sharedHomes = [];
  for (const profile of profiles) {
    let strictEnv;
    try { strictEnv = environment(profile); } catch (error) { onDrift({ profile: profile.id, error: error.message }); continue; }
    if (!strictEnv) { sharedIds.add(profile.id); if (profile.home) sharedHomes.push([profile.id, profile.home]); continue; }
    owners.set(profile.id, strictEnv);
    if (profile.home && fs.existsSync(profile.home)) pinOne(profile.id, profile.home, strictEnv);
  }
  const dedicatedProxies = new Set([...owners.values()].map(env => env.HTTPS_PROXY));
  const sharedProxyEnv = sharedEnv && Object.fromEntries([...PROXY_KEYS, 'NO_PROXY', 'no_proxy']
    .filter(key => typeof sharedEnv[key] === 'string').map(key => [key, sharedEnv[key]]));
  if (sharedProxyEnv && Object.values(sharedProxyEnv).some(value => dedicatedProxies.has(value))) {
    onDrift({ error: '主账号配置的代理指向了专线，共享账号的出口无法确定，请人工核对' });
  }
  for (const [id, home] of sharedHomes) if (id !== 'default') restoreShared(id, home);
  if ((owners.size || sharedIds.size) && runtimeRoot && fs.existsSync(runtimeRoot)) {
    for (const name of fs.readdirSync(runtimeRoot)) {
      const home = path.join(runtimeRoot, name);
      let marker;
      try { marker = JSON.parse(fs.readFileSync(path.join(home, '.hub-account.json'), 'utf8')); } catch { continue; }
      const id = owners.has(marker.profile) ? marker.profile : owners.has(marker.contextProfile) ? marker.contextProfile : null;
      if (id) pinOne(id, home, owners.get(id));
      else if (sharedIds.has(marker.profile)) restoreShared(marker.profile, home);
    }
  }
  function pinOne(id, home, strictEnv) {
    try { if (pinSettingsEgress(home, strictEnv)) onDrift({ profile: id, home, repinned: true }); }
    catch (error) { onDrift({ profile: id, home, error: error.message }); }
  }
  function restoreShared(id, home) {
    const file = path.join(home, 'settings.json');
    try {
      if (!fs.existsSync(file)) return;
      const settings = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
      const env = settings?.env || {};
      if (!Object.values(env).some(value => dedicatedProxies.has(value))) return;
      if (!sharedProxyEnv || Object.values(sharedProxyEnv).some(value => dedicatedProxies.has(value))) {
        onDrift({ profile: id, home, error: '共享账号指向了专线，但主账号代理不可用，未自动修复' });
        return;
      }
      const next = { ...env, ...sharedProxyEnv };
      for (const key of [...PROXY_KEYS, 'NO_PROXY', 'no_proxy']) if (!(key in sharedProxyEnv)) delete next[key];
      delete next.NODE_EXTRA_CA_CERTS; delete next.BROWSER;
      const temporary = `${file}.${process.pid}.pin.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ ...settings, env: next }, null, 2), 'utf8');
      fs.renameSync(temporary, file);
      onDrift({ profile: id, home, repinned: true });
    } catch (error) { onDrift({ profile: id, home, error: error.message }); }
  }
}

// Ask, through each dedicated route itself, which IP the world sees. The VPS
// closes a route whose IP drifts; this lets Hub tell the user why it stopped.
async function checkDedicatedEgress(profiles, request = requestViaProxy) {
  const results = [];
  for (const profile of profiles) {
    let p;
    try { p = policy(profile); } catch { continue; }
    if (!p) continue;
    try {
      const response = await request(p.proxy, 'https://api.ipify.org', {}, 15000, p.proxyCaFile);
      const ip = String(await response.text()).trim();
      results.push({ id: profile.id, label: profile.label || profile.id, expected: p.expectedIp, ip,
        state: response.status === 200 && ip === p.expectedIp ? 'ok' : response.status === 200 ? 'mismatch' : 'unreachable' });
    } catch { results.push({ id: profile.id, label: profile.label || profile.id, expected: p.expectedIp, state: 'unreachable' }); }
  }
  return results;
}

// Shared accounts have no configured IP; the caller passes the recorded baseline
// (null on first run: any answer becomes 'ok' and is then recorded).
async function checkSharedEgress(proxy, expectedIp, request = requestViaProxy) {
  const base = { id: 'shared', label: '主账号/第二账号', expected: expectedIp || null };
  try {
    const response = await request(proxy, 'https://api.ipify.org', {}, 15000);
    const ip = String(await response.text()).trim();
    if (response.status !== 200 || !net.isIP(ip)) return { ...base, state: 'unreachable' };
    return { ...base, ip, state: !expectedIp || ip === expectedIp ? 'ok' : 'mismatch' };
  } catch { return { ...base, state: 'unreachable' }; }
}

function prepareChildShellEnv({ directory, sessionId, strictEnv, normalEnv }) {
  if (!path.isAbsolute(directory) || !/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId || '')) throw new Error('Invalid child shell env scope');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `child-shell-${sessionId}.sh`);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, childShellScript(strictEnv, normalEnv), 'utf8');
  fs.renameSync(temporary, file);
  return file;
}

function sameRoute(a, b) {
  const pa = policy(a), pb = policy(b);
  if (!pa && !pb) return true;
  return !!pa && !!pb && pa.proxy === pb.proxy && pa.expectedIp === pb.expectedIp && pa.proxyCaFile === pb.proxyCaFile;
}

function assertSameRoute(a, b) {
  if (!sameRoute(a, b)) throw new Error('这两个账号绑定不同网络出口，不能在原进程内热换号；请用目标账号新建会话');
}

// An explicit CONNECT tunnel, never a PAC/system proxy/direct fallback. TLS
// remains end-to-end with the destination; proxy failure rejects the request.
function requestViaProxy(proxyUrl, url, options = {}, timeoutMs = 15000, proxyCaFile) {
  return new Promise((resolve, reject) => {
    const target = new URL(url), proxy = new URL(proxyUrl);
    if (target.protocol !== 'https:' || target.username || target.password) return reject(new Error('Claude 账号请求只允许 HTTPS'));
    // A plain-HTTP proxy is accepted only on loopback (the shared Clash listener);
    // remote proxies must be TLS with a pinned CA.
    const loopbackHttp = proxy.protocol === 'http:' && LOOPBACK.has(proxy.hostname);
    if (!loopbackHttp && (proxy.protocol !== 'https:' || !proxyCaFile)) return reject(new Error('Claude 专用代理必须验证证书，未回落到其他出口'));
    const ca = loopbackHttp ? null : fs.readFileSync(proxyCaFile);
    let socket, secure, request, done = false, sent = false;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) { request?.destroy(); secure?.destroy(); socket?.destroy(); reject(Object.assign(new Error('Claude 专用出口连接失败，未回落到其他出口'), { notSent: !sent })); }
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);
    socket = loopbackHttp ? net.connect({ host: proxy.hostname, port: Number(proxy.port) })
      : tls.connect({ host: proxy.hostname, port: Number(proxy.port), ca, rejectUnauthorized: true,
        checkServerIdentity: (_name, cert) => tls.checkServerIdentity(proxy.hostname, cert) });
    socket.on('error', finish);
    socket.once(loopbackHttp ? 'connect' : 'secureConnect', () => {
      const host = `${target.hostname}:${target.port || 443}`;
      socket.write(`CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\n\r\n`);
    });
    let header = Buffer.alloc(0);
    const onData = chunk => {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) { if (header.length > 16384) finish(new Error('proxy header')); return; }
      socket.removeListener('data', onData);
      if (!/^HTTP\/1\.[01] 200\b/.test(header.subarray(0, end).toString('ascii'))) return finish(new Error('proxy refused'));
      if (header.length > end + 4) socket.unshift(header.subarray(end + 4));
      secure = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: true });
      secure.on('error', finish);
      secure.once('secureConnect', () => {
        const agent = new https.Agent({ keepAlive: false });
        agent.createConnection = () => secure;
        request = https.request(target, { method: options.method || 'GET', headers: options.headers || {}, agent }, response => {
          const chunks = []; let size = 0;
          response.on('error', finish);
          response.on('aborted', () => finish(new Error('aborted')));
          response.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) finish(new Error('response too large')); else chunks.push(chunk); });
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            finish(null, { status: response.statusCode, headers: { get: key => response.headers[key.toLowerCase()] || null },
              json: async () => JSON.parse(text), text: async () => text });
            agent.destroy();
          });
        });
        request.on('error', finish);
        sent = true; // From here the server may have received the request.
        request.end(options.body || undefined);
      });
    };
    socket.on('data', onData);
    socket.on('end', () => { if (!secure) finish(new Error('proxy closed')); });
  });
}

// The route a non-dedicated account's own Claude uses (its settings.json proxy),
// when Hub can follow it exactly: a plain-HTTP proxy on loopback.
function sharedRouteProxy(value) {
  try { const u = new URL(String(value || '')); return u.protocol === 'http:' && LOOPBACK.has(u.hostname) ? u.href : null; }
  catch { return null; }
}

function createAccountFetch({ legacyFetch, sharedProxy = () => null }) {
  return async (profile, url, options = {}) => {
    if (!profile?.id) throw new Error('Claude 账号请求缺少身份，已停止');
    const p = policy(profile);
    if (!p) {
      // Same exit as the account's Claude CLI. Without this, Hub followed the
      // Windows system proxy and would go out directly whenever it was off.
      const shared = sharedRouteProxy(sharedProxy());
      if (shared) return requestViaProxy(shared, url, options, 15000);
      try { return await legacyFetch(url, options); }
      catch (error) {
        // Chromium reports these before any byte reaches the destination.
        if (NOT_SENT.test(String(error?.message))) error.notSent = true;
        throw error;
      }
    }
    return requestViaProxy(p.proxy, url, options, 15000, p.proxyCaFile);
  };
}

module.exports = { policy, environment, sameRoute, assertSameRoute, requestViaProxy, createAccountFetch, sharedRouteProxy, childShellScript, prepareChildShellEnv, pinSettingsEgress, pinDedicatedAccountDirs, checkDedicatedEgress, checkSharedEgress, PROXY_KEYS };
