'use strict';
// 「放行下载服务器」（2026-11-07 用户：新的高速服务器作首选，提供放行按钮，并提醒新用户先放行再下载；两台服务器不要让用户放行两次）。
// 公司代理按主机放行：自家有两台下载主机（高速镜像 + 旧阿里云），各要过一次放行页。这里把两台合成一个动作：
// 点一次按钮，逐台在看不见的窗口里打开放行页、点放行（core/net-unblock.js），再逐台核对是否已经能访问。
// 「能访问」的判据：GET 放行小页面，拿到的是自家页面（标题「AI HUB 服务」），而不是代理的拦截页。
// 状态只记在内存和数据目录下的 net-pass.json（每台最近一次能访问的时间），不记网址以外的东西。
const fs = require('node:fs');
const path = require('node:path');

const OWN_TITLE = 'AI HUB 服务';
const FILE = 'net-pass.json';
const PROBE_TIMEOUT_MS = 12000;

function readState(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' && j.hosts ? j : { hosts: {} }; }
  catch { return { hosts: {} }; }
}

function createNetPass({ hosts = [], dataDir, fetchImpl, openGate, now = () => Date.now(), logger = console, onChange = () => {} } = {}) {
  const file = dataDir ? path.join(dataDir, FILE) : null;
  const saved = file ? readState(file) : { hosts: {} };
  // 每台：state = unknown（还没查）/ checking / ok / blocked（拿到拦截页）/ error（连不上，不是放行能解决的）
  const live = new Map(hosts.map(h => [h.host, { state: 'unknown', reason: null, checkedAt: null }]));
  let running = null;

  const save = () => {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(saved, null, 1)); } catch (_) {}
  };
  const set = (host, patch) => {
    live.set(host, { ...live.get(host), ...patch });
    if (patch.state === 'ok') { saved.hosts[host] = { okAt: new Date(now()).toISOString() }; save(); }
    try { onChange(status()); } catch (_) {}
  };

  function status() {
    const list = hosts.map(h => {
      const l = live.get(h.host) || {};
      return { host: h.host, name: h.name, page: h.page, mirror: !!h.mirror, state: l.state, reason: l.reason, checkedAt: l.checkedAt,
        okAt: saved.hosts[h.host]?.okAt || null };
    });
    // 需要提醒：有主机拿到的是拦截页；或者这台电脑从没确认过能访问、这次也还没查出结果。连不上（error）不是放行能解决的，不催。
    const needed = list.some(h => h.state === 'blocked' || (!h.okAt && h.state === 'unknown'));
    return { available: hosts.length > 0, running: !!running, needed, hosts: list };
  }

  async function probe(h) {
    set(h.host, { state: 'checking' });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetchImpl(h.page, { signal: ac.signal, cache: 'no-store', redirect: 'follow' });
      const text = String(await res.text()).slice(0, 200000);
      if (text.includes(`<title>${OWN_TITLE}</title>`)) { set(h.host, { state: 'ok', reason: null, checkedAt: now() }); return 'ok'; }
      if (/<html|<!doctype/i.test(text)) { set(h.host, { state: 'blocked', reason: '被公司网络拦截，需要放行', checkedAt: now() }); return 'blocked'; }
      set(h.host, { state: 'error', reason: `服务器返回 HTTP ${res.status}`, checkedAt: now() }); return 'error';
    } catch (error) {
      set(h.host, { state: 'error', reason: ac.signal.aborted ? '连接超时' : '连不上：' + (error && error.message || error), checkedAt: now() });
      return 'error';
    } finally { clearTimeout(timer); }
  }

  // 只查一遍（打开面板、启动后）：已经确认能访问的这次会话里不重复查。
  async function refresh({ force = false } = {}) {
    if (running) return running;
    running = (async () => {
      for (const h of hosts) {
        const l = live.get(h.host);
        if (!force && l && l.state === 'ok') continue;
        await probe(h);
      }
    })().finally(() => { running = null; try { onChange(status()); } catch (_) {} });
    await running;
    return status();
  }

  // 一键放行：逐台查；拦着的在看不见的窗口里点放行，再查一次。返回每台结果；仍不行的给出放行页，界面可让用户用浏览器打开。
  async function passAll() {
    if (running) await running.catch(() => {});
    const results = [];
    running = (async () => {
      for (const h of hosts) {
        let r = await probe(h), clicked = false;
        if (r === 'blocked' && openGate) {
          try { const g = await openGate(h.page); clicked = !!(g && g.clicked); }
          catch (error) { logger.warn?.('[net-pass] 放行窗口出错：', error.message); }
          r = await probe(h);
        }
        results.push({ host: h.host, name: h.name, result: r, clicked, page: h.page });
      }
    })().finally(() => { running = null; });
    await running;
    return { ...status(), results };
  }

  // 其他功能（检查更新、下载）访问某台成功了：直接记成能访问，不用再查。
  function markOk(host) { if (live.has(host) && live.get(host).state !== 'ok') set(host, { state: 'ok', reason: null, checkedAt: now() }); }

  return { status, refresh, passAll, markOk, probe };
}

module.exports = { OWN_TITLE, FILE, createNetPass };
