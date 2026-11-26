'use strict';
const W = require('./welink');
const CHECK_MS = 5 * 60000, RETRY_MS = 10 * 60000, SCAN_LIMIT = 2;
// 已提示扫码后仍每 30 分钟悄悄试一次（2026-11-06）：夜里 WeLink 桌面端没开、早上开了，Hub 自己就续上，不用等人点。
// 一出二维码就立刻停，不打扰；提示只发一次。
const SLOW_RETRY_MS = 30 * 60000;
// 认不出登录状态时（Q-1106-07：1.0.20 自动刷新令牌那一瞬间可能只输出进度行，如「Token refresh complete」）：
// 隔 1.5 秒再查一次；仍认不出、而 10 分钟内确认过在线，就先按在线继续取数，1 分钟后再核对——不因一句没见过的输出停掉整轮取数。
const UNKNOWN_RETRY_MS = 1500, ONLINE_GRACE_MS = 10 * 60000;
// 和 welink.js 共用一张「要重新登录」的说法表（含 1.0.20 的 Not logged in / Token expired and refresh token invalid）。
const authFailure = text => W.AUTH_FAILURE.test(String(text || ''));
// 只保留失败诊断，不把状态输出中的凭据带到 auth.json 或界面。
const safeDiagnostic = text => String(text || '').replace(/((?:token|ticket|secret|password|authorization)\w*["']?\s*[:=]\s*)[^\r\n]+/gi, '$1***')
  .replace(/\bBearer\s+\S+/gi, 'Bearer ***').trim().slice(0, 300);
// Same recognition as the manual login panel (welink.loginNeedsScan): block-character QR art, data URI,
// image path, URL, plus the fixed prompt lines of welink-cli 1.0.14 (Q-1021-14).
const needsScan = text => W.loginNeedsScan(text);
// 自动续期没成功时说清卡在哪（2026-11-21）：1.0.20 续期要先向本机 WeLink 桌面端取签名，桌面端没开或登录在另一台电脑，
// 续期就转成要扫码。以前只说「自动续期没成功，点这里扫码」，同事以为令牌坏了；其实把桌面端开起来，Hub 半小时内自己续上。
const PC_CAUSES = new Set(['pc', 'pc-busy', 'pc-version', 'other-device']);
function renewHint(cause) {
  if (!cause) return null;
  const text = PC_CAUSES.has(cause.id)
    ? `${cause.title}。打开并登录这台电脑上的 WeLink 桌面端后，Hub 会在半小时内自动续上，不用扫码；急用可以现在扫码登录。`
    : `${cause.title}。${cause.next}`;
  return { id: cause.id, title: cause.title, text, line: cause.line };
}

class AuthKeeper {
  constructor(a) {
    this.a = a; this.pending = null; this.controller = null; this.closed = false;
    this.current = { state: 'unknown', lastCheckAt: 0, lastAttemptAt: 0, lastRenewAt: 0, scanAttempts: 0, notified: false, login: null, error: '',
      ...a.read('auth.json', {}) };
    // The CLI account may have changed while Hub was stopped. Persisted login
    // is diagnostic history, not proof of identity in this process. Keep retry
    // counters/renewal history, but require a fresh read-only auth status check.
    if (['online', 'renewing'].includes(this.current.state)) this.current.state = 'unknown';
    this.current.login = null;
    this.current.lastCheckAt = 0;
    this.current.lastOkUid = null; // 重启后不拿旧的在线记录兜底
  }
  sharedState() {
    const auth = this.a.blackboard?.read().auth;
    if (auth?.state === 'signed_out') {
      this.controller?.abort();
      this.current = { ...this.current, state: 'signed-out', login: { ok: false, reason: 'expired', checkedAt: auth.updatedAt }, error: '', renewCause: null, lastOkUid: null };
    }
    return auth;
  }
  status() { this.sharedState(); return { ...this.current }; }
  set(patch, { manual = false } = {}) {
    if (this.closed) return;
    if (!manual && this.sharedState()?.state === 'signed_out' && patch.state !== 'signed-out') return;
    this.current = { ...this.current, ...patch };
    const saved = this.a.blackboard?.setAuth(this.current, { manual });
    if (saved === false && !manual) this.sharedState();
    this.a.write('auth.json', this.current); this.a.changed();
  }
  online(login, renewed = false, manual = false) {
    this.set({ state: 'online', login, error: '', renewCause: null, lastCheckAt: this.a.now(), scanAttempts: 0, notified: false, noticeId: '', lastOkAt: this.a.now(), lastOkUid: login?.uid || this.current.lastOkUid || null,
      ...(renewed ? { lastRenewAt: this.a.now(), renewedVia: 'cli' } : {}) }, { manual });
  }
  manualSucceeded(login) { if (!this.wrongAccount(login, this.a.now(), { manual: true })) this.online(login, false, true); }
  // 换过工号（R32）：令牌有效但和 WeLink 桌面端当前账号不是同一个人，查询会被网关拒成「proxy failed」。
  // 这时不续期（续的还是旧账号），停下来请本人清除旧登录后扫码；同一对账号只提醒一次。
  wrongAccount(login, now, { manual = false } = {}) {
    let wrong = null;
    try { wrong = login?.ok ? this.a.accountMismatch?.(login.uid) : null; } catch { wrong = null; }
    if (!wrong) return false;
    const cause = { id: 'account-mismatch', title: wrong.text, text: `${wrong.text}。${wrong.next}`, client: wrong.client, cli: wrong.cli };
    const same = this.current.state === 'account-mismatch' && this.current.renewCause?.client === wrong.client && this.current.renewCause?.cli === wrong.cli;
    this.set({ state: 'account-mismatch', login: { ok: false, reason: 'account-mismatch', uid: login.uid, clientAccount: wrong.client, checkedAt: now }, error: '', renewCause: cause, lastCheckAt: now, lastOkUid: null,
      ...(same ? {} : { notified: false, noticeId: '' }) }, { manual });
    if (!this.current.notified) {
      const id = this.current.noticeId || 'welink-account-' + now;
      this.set({ noticeId: id });
      if (this.a.publish({ id, kind: 'welink-login', title: 'WeLink 命令行还登着旧账号', text: cause.text, at: now })) this.set({ notified: true });
    }
    return true;
  }
  // 本人在设置里点了「退出 WeLink 登录」（2026-11-19）：停掉自动续期，不发「续期没成功」提醒，等本人再扫码（manualSucceeded 会恢复）。
  signedOut() {
    this.controller?.abort();
    this.set({ state: 'signed-out', login: { ok: false, reason: 'expired', checkedAt: this.a.now() }, error: '', renewCause: null, scanAttempts: 0, notified: false, noticeId: '', lastOkUid: null, lastCheckAt: this.a.now() });
  }
  notifyScan() {
    if (this.closed || this.current.state !== 'needs-scan' || this.current.notified) return;
    const id = this.current.noticeId || 'welink-login-' + this.a.now();
    this.set({ noticeId: id });
    if (this.a.publish({ id, kind: 'welink-login', title: 'WeLink 自动续期没成功', text: this.current.renewCause?.text || '自动续期连续两次没完成；点助理左栏的 WeLink 一行扫码登录即可继续。', at: this.a.now() })) this.set({ notified: true });
  }
  close() { this.closed = true; this.controller?.abort(); }
  // 员工助手代办 welink-cli 免密登录（2026-11-27，公司真机 probe 31/32）：GET 本机 3008 /v1/welinkcli/login，约 1 秒，
  // 用员工助手自己的身份跑 agent_login，不出二维码（仍要本机 WeLink 桌面端开着）。只在员工助手在线且已登录时试，30 分钟最多一次；
  // 之后用 auth status 复核，确认在线才算续上。返回 true 表示已续上。
  weclaw() { return this.a.weclaw || null; }
  async renewViaWeclaw(refresh) {
    const wf = this.weclaw();
    if (!wf) return false;
    try {
      if (!(await wf.usable('welink-login'))) return false;
      if (this.closed || this.a.loginFlow?.state === 'waiting' || (this.sharedState(), this.current.state === 'signed-out')) return false;
      const r = await wf.welinkLogin({ canProceed: () => !this.closed && this.a.loginFlow?.state !== 'waiting' && (this.sharedState(), this.current.state !== 'signed-out') });
      if (this.closed || (this.sharedState(), this.current.state === 'signed-out')) return false;
      if (!r.ok) { if (r.status !== 'throttled' && r.status !== 'cancelled') { wf.fail('welink-login', r.status); console.warn('[company-assistant] 员工助手代办 WeLink 登录没成功：' + r.status); } return false; }
      const after = await this.a.rawWelink(['auth', 'status']);
      if (this.closed || (this.sharedState(), this.current.state === 'signed-out')) return false;
      const confirmed = { ...W.loginState(after.stdout + '\n' + after.stderr), checkedAt: this.a.now() };
      if (after.code !== 0 || !confirmed.ok) { wf.fail('welink-login', 'not-confirmed'); return false; }
      if (this.wrongAccount(confirmed, this.a.now())) return true;
      wf.succeed('welink-login');
      console.log('[company-assistant] WeLink 登录已由员工助手代办续上');
      this.online(confirmed, true);
      this.set({ renewedVia: 'weclaw' });
      if (refresh) queueMicrotask(() => { if (!this.closed) void this.a.refresh({ force: true }).catch(e => console.warn('[company-assistant] renew refresh', e.message)); });
      return true;
    } catch { return false; }
  }
  check({ force = false, known = null, refresh = true } = {}) {
    this.sharedState();
    if (this.closed || this.a.loginFlow?.state === 'waiting') return Promise.resolve(this.status());
    if (this.pending) return this.pending;
    if (!force && this.current.lastCheckAt && this.a.now() - this.current.lastCheckAt < CHECK_MS) return Promise.resolve(this.status());
    this.pending = this.perform(known, refresh).finally(() => { this.pending = null; });
    return this.pending;
  }
  async perform(known, refresh) {
    const now = this.a.now();
    let login;
    try {
      let result = known || await this.a.rawWelink(['auth', 'status']);
      if (this.sharedState()?.state === 'signed_out') return this.status();
      if (this.closed) return this.status();
      let text = result.stdout + '\n' + result.stderr;
      login = { ...W.loginState(text), checkedAt: now, exitCode: result.code };
      if (login.reason === 'unknown' && result.code === 0) {
        await new Promise(r => setTimeout(r, this.a.unknownRetryMs ?? UNKNOWN_RETRY_MS));
        if (this.closed) return this.status();
        result = await this.a.rawWelink(['auth', 'status']);
        if (this.sharedState()?.state === 'signed_out') return this.status();
        text = result.stdout + '\n' + result.stderr;
        login = { ...W.loginState(text), checkedAt: this.a.now(), exitCode: result.code };
      }
      if (login.reason === 'unknown' && result.code === 0 && this.current.lastOkUid && now - (this.current.lastOkAt || 0) < ONLINE_GRACE_MS) {
        this.set({ state: 'online', login: { ok: true, uid: this.current.lastOkUid, checkedAt: now, unverified: true }, error: '', lastCheckAt: now - CHECK_MS + 60000 });
        return this.status();
      }
      if (result.code !== 0 && login.reason !== 'expired') login = { ...login, ok: false, reason: 'error',
        error: `登录状态查询失败（退出码 ${result.code}）${safeDiagnostic(result.stderr || result.stdout) ? '：' + safeDiagnostic(result.stderr || result.stdout) : ''}` };
      else if (login.reason === 'unknown') login.error = '无法识别 WeLink 登录状态输出，稍后自动重查';
      // 换过工号（R32）：账号和桌面端对不上就停在这里，见 wrongAccount。
      if (login.ok && this.wrongAccount(login, now)) return this.status();
      // A still-valid token renewed early must never turn into a scan request.
      const early = !!login.ok;
      if (login.ok) {
        this.online(login);
        const remaining = /expires in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i.exec(text);
        const ms = remaining ? (Number(remaining[1] || 0) * 3600 + Number(remaining[2] || 0) * 60 + Number(remaining[3] || 0)) * 1000 : Infinity;
        if (ms > CHECK_MS) return this.status();
      }
      this.set({ login, lastCheckAt: now, ...(!login.ok && this.current.state === 'online' ? { state: 'unknown', error: '等待自动续期' } : {}) });
      // 本人主动退出过：只记录状态，不自动去跑 auth login。
      if (!login.ok && this.current.state === 'signed-out') { this.set({ login, lastCheckAt: now }); return this.status(); }
      // A network/parse failure is not proof of expiry and must not launch login.
      if (!login.ok && login.reason !== 'expired') { this.set({ state: 'unknown', error: login.error || '暂时无法确认 WeLink 登录，稍后自动重查' }); return this.status(); }
      if (!login.ok && this.current.scanAttempts >= SCAN_LIMIT) this.set({ state: 'needs-scan', error: '' });
      const since = this.current.lastAttemptAt ? now - this.current.lastAttemptAt : Infinity;
      if (this.current.scanAttempts >= SCAN_LIMIT ? since < SLOW_RETRY_MS : since < RETRY_MS) { this.notifyScan(); return this.status(); }
      // 员工助手在线时先请它代办免密登录（不出二维码）；没装、没开、没登录或没成功就照原样往下走。
      if (!early && await this.renewViaWeclaw(refresh)) return this.status();
      // 等员工助手的这一两秒里本人可能点了退出、或 Hub 在关：照原来的规矩不再自动登录。
      if (this.closed || this.current.state === 'signed-out') return this.status();
      // 已在提示扫码时的悄悄重试不改界面状态，「扫码登录」一行照常显示。
      this.set({ state: this.current.state === 'needs-scan' ? 'needs-scan' : 'renewing', lastAttemptAt: now, error: '' });
      this.controller = new AbortController();
      let scan = false, timedOut = false, seen = '';
      let resultLogin;
      try {
        resultLogin = await this.a.rawWelink(['auth', 'login'], { authAutomatic: true, allowSetup: true, timeoutMs: 90000, signal: this.controller.signal, onData: text => {
          seen = text;
          if (needsScan(text)) { scan = true; this.controller.abort(); }
        } });
        seen = resultLogin.stdout + '\n' + resultLogin.stderr;
        scan = scan || needsScan(resultLogin.stdout + resultLogin.stderr);
      } catch (error) {
        this.sharedState();
        if (this.closed || this.current.state === 'signed-out') return this.status();
        timedOut = !scan && error.code === 'WELINK_TIMEOUT';
        if (!scan && !timedOut) {
          const hint = renewHint(W.loginDiagnosis(seen));
          this.set({ state: early ? 'online' : 'unknown', renewCause: early ? null : hint, error: early ? '' : '自动续期没能完成：' + (hint ? hint.text : error.message) });
          return this.status();
        }
      } finally { this.controller = null; }
      if (this.closed || this.current.state === 'signed-out') return this.status();
      // Early renewal that asked for a QR code or timed out: the login process is already ended;
      // keep the valid login and let the normal flow handle it once the token has really expired.
      if (early && (scan || timedOut)) { this.set({ state: 'online', error: '' }); return this.status(); }
      if (!scan && resultLogin?.code === 0) {
        const after = await this.a.rawWelink(['auth', 'status']);
        if (this.closed || this.current.state === 'signed-out') return this.status();
        const confirmed = { ...W.loginState(after.stdout + '\n' + after.stderr), checkedAt: this.a.now() };
        if (after.code === 0 && confirmed.ok) {
          this.online(confirmed, true);
          // Defer collection until the current auth/collection promise can settle.
          if (refresh) queueMicrotask(() => { if (!this.closed) void this.a.refresh({ force: true }).catch(e => console.warn('[company-assistant] renew refresh', e.message)); });
          return this.status();
        }
      }
      const hint = renewHint(W.loginDiagnosis(seen));
      if (!scan && !timedOut) {
        this.set({ state: early ? 'online' : 'unknown', renewCause: early ? null : hint, error: early ? '' : hint ? '自动续期没成功：' + hint.text : '自动续期未成功，十分钟后再试；也可手动登录' });
        return this.status();
      }
      // A QR request or a timeout both count; two in a row stop auto login and ask for a scan.
      const attempts = this.current.scanAttempts + 1;
      if (attempts < SCAN_LIMIT) {
        this.set({ state: 'unknown', scanAttempts: attempts, renewCause: hint, error: hint ? '自动续期没成功：' + hint.text : '自动续期没成功，十分钟后再试；也可点「扫码登录」' });
        return this.status();
      }
      this.set({ state: 'needs-scan', scanAttempts: attempts, renewCause: hint, error: '' });
      this.notifyScan();
    } catch (error) {
      if (!this.closed) this.set({ state: this.current.state === 'signed-out' ? 'signed-out' : 'unknown', lastCheckAt: now, error: error.message, login: { ok: false, reason: error.code === 'WELINK_MISSING' ? 'missing' : 'error', checkedAt: now } });
    }
    return this.status();
  }
}
module.exports = { renewHint, AuthKeeper, CHECK_MS, RETRY_MS, SCAN_LIMIT, SLOW_RETRY_MS, authFailure, needsScan };
