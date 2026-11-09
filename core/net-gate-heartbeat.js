'use strict';
// 放行心跳（2026-11-08 用户：成员版默认自动放行，不用再手动一直点）。
// 所以每分钟轻量探一次自家主机上那张 197 字节的「AI HUB 服务」小页：
//   - 拿到它 → 正常，什么都不做；
//   - 被跳转 / 拿到别的网页 → 被放行页拦了，马上在看不见的窗口里点放行，隔几秒再探，没通就再点（额度见 net-unblock 的 ClickBudget）；
//   - 连不上（断网、超时）→ 不是放行问题，不点。
const OK_MARK = 'AI HUB 服务';

// 探一次：先 GET 自家小页（应拿到「AI HUB 服务」），再 POST 一个不存在的接口（应拿到 JSON 的 not_found）。
async function probeOnce(fetchFn, url, init, isOk, timeoutMs) {
  let response;
  try {
    response = await fetchFn(url, { ...init, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const msg = String(error && error.message || error);
    if (/redirect/i.test(msg)) return { state: 'gate', detail: '请求被跳转' };
    return { state: 'offline', detail: msg.slice(0, 120) };
  }
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) return { state: 'gate', detail: `HTTP ${response.status} 跳转` };
  let text = '';
  try { text = await response.text(); } catch {}
  if (isOk(response, text)) return { state: 'ok', detail: `HTTP ${response.status}` };
  // 自家服务自己挂了（5xx、网关错误）不是放行问题：没有网页内容时按连不上处理。
  if (response.status >= 500 && !/<html/i.test(text)) return { state: 'offline', detail: `HTTP ${response.status}` };
  return { state: 'gate', detail: `HTTP ${response.status} 返回了别的网页` };
}
async function probeOwnPage(fetchFn, url, { timeoutMs = 15000, post = true } = {}) {
  const g = await probeOnce(fetchFn, url, { method: 'GET' }, (res, text) => res.ok && text.includes(OK_MARK), timeoutMs);
  if (g.state !== 'ok' || !post) return { ...g, method: 'GET' };
  const isJson = (_res, text) => { try { const o = JSON.parse(text); return !!o && typeof o === 'object'; } catch { return false; } };
  const p = await probeOnce(fetchFn, url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, isJson, timeoutMs);
  return { ...p, method: 'POST' };
}

class GateHeartbeat {
  // probe() → probeOwnPage 的结果；passer：GatePasser（共享点击额度）；url：放行窗口打开的地址（自家小页）。
  // enabled()：每次心跳现读（公司联动里「网络放行」改成手动就停）。onPassed()：从被拦恢复时调用。
  constructor({ probe, passer, url, enabled = () => true, onPassed = () => {}, onState = () => {}, intervalMs = 60000, settleMs = 4000, burstMs = 60000,
    now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), logger = console }) {
    Object.assign(this, { probe, passer, url, enabled, onPassed, onState, intervalMs, settleMs, burstMs, now, sleep, logger });
    this.gated = false; this.timer = null; this.busy = null; this.lastProbe = null; this.stopped = true; this.halted = false;
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false; this.halted = false;
    const loop = () => { if (this.stopped) return; this.timer = setTimeout(() => { this.tick().catch(() => {}).finally(loop); }, this.intervalMs); this.timer.unref?.(); };
    // 启动后先等 15 秒再探第一次，不和启动抢网络。
    this.timer = setTimeout(() => { this.tick().catch(() => {}).finally(loop); }, Math.min(15000, this.intervalMs)); this.timer.unref?.();
  }
  stop() { this.stopped = true; this.halted = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  status() { return { running: !this.stopped, gated: this.gated, lastProbe: this.lastProbe, passer: this.passer.status() }; }
  async check() {
    let r;
    try { r = await this.probe(); } catch (error) { r = { state: 'offline', detail: String(error && error.message || error) }; }
    this.lastProbe = { at: this.now(), ...r };
    try { this.onState(this.lastProbe); } catch {}
    return r;
  }
  recovered() {
    const was = this.gated;
    this.gated = false;
    if (was || this.passer.tries) { this.passer.passed(); try { this.onPassed(); } catch (e) { this.logger.warn?.('[gate-heartbeat] onPassed', e.message); } }
  }
  // 一次心跳：探 → 被拦就连点（每点一次隔 settleMs 再探），通了或额度用完 / 找不到按钮就停，下一分钟再看。
  tick() {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      if (!this.enabled()) return;
      let r = await this.check();
      if (r.state === 'ok') { this.recovered(); return; }
      if (r.state !== 'gate') return;
      this.gated = true;
      const end = this.now() + this.burstMs;
      while (this.now() < end && !this.halted && this.enabled()) {
        const clicked = await this.passer.attempt(this.url, { method: r.method || 'GET' });
        if (!clicked) break;
        await this.sleep(this.settleMs);
        r = await this.check();
        if (r.state === 'ok') { this.recovered(); return; }
        if (r.state !== 'gate') return;
      }
    })().finally(() => { this.busy = null; });
    return this.busy;
  }
}

module.exports = { GateHeartbeat, probeOwnPage, OK_MARK };
