'use strict';

// Only an explicit login failure requests account-page authorization. Network
// failures and unknown observations must never log a user out or open login windows.
//
// 2026-10-14: every probe is a child process (`claude auth status` ~0.5–0.8 s,
// `codex login status` ~0.2–0.3 s) and starting one on Windows blocks the main
// process for 20–190 ms. Creating a two-member group used to probe four times
// in a row. A launch now reuses the account center's stored observation of the
// same account (id, home, credential) and the same local login files: a login
// seen within the account page's own freshness window (5 min), an inconclusive
// probe within a minute. The stored observation is the only record, so a newer
// "login required" — from a check or from a running CLI via recover() — always
// wins over an older "signed in", and the next successful check clears it.
const SIGNED_IN_REUSE_MS = 5 * 60 * 1000;
const INCONCLUSIVE_REUSE_MS = 60 * 1000;
class LaunchAuth {
  constructor({accounts, getConfig, notify = () => {}, now = Date.now}) {
    Object.assign(this, {accounts, getConfig, notify, now});
    this.flights = new Map();
    this.recoveryAt = new Map();
  }
  connection(kind, opts = {}) {
    const base = String(kind || '').replace(/-resume$/, '');
    const config = this.getConfig();
    if (base === 'codex') {
      if (config.codexBackend === 'api' || require('./chatgpt-web-models').isChatgptWebModel(opts.model)) return null;
      return 'codex-' + (opts.launchProfile || (opts.codexAccountPinned && opts.codexProfile) || config.codexSubscriptionProfile || 'default');
    }
    if (base === 'claude') return config.claudeBackend === 'api' ? null
      : require('./claude-subscription-profiles').connectionId(require('./claude-subscription-profiles').profileForSession(
        {...opts, ...(opts.claudeRuntimeHome ? {claudeConfigDir:undefined} : {}),
          ...(opts.launchProfile ? {claudeProfile:opts.launchProfile} : {})}, config).id);
    if (base === 'gemini') {
      const profiles=require('./antigravity-subscription-profiles');
      const cleanPurpose=require('./session-scenes').isCleanPurpose(opts.purpose);
      return profiles.connectionId(profiles.profileForSession({...opts,
        ...(cleanPurpose ? {transcriptPath:undefined,resumeTranscriptPath:undefined} : {}),
        ...(opts.launchProfile ? {antigravityProfile:opts.launchProfile} : {})},config).id);
    }
    return ({kimi:'kimi'})[base] || null;
  }
  // The account a connection id points at right now: id, home directory and credential.
  identity(id) { try { return this.accounts.checkIdentityOf?.(id) || this.accounts.scopeOf?.(id) || id; } catch { return id; } }
  observation(id) {
    try { return this.accounts.recentObservation?.(id) || null; } catch { return null; }
  }
  reusable(id, seen = this.observation(id)) {
    if (!seen || seen.sameCredential === false || seen.state === 'login_required') return false;
    const age = this.now() - (Number(seen.observedAt) || 0);
    if (age < 0) return false;
    return age < (seen.state === 'signed_in' ? SIGNED_IN_REUSE_MS : INCONCLUSIVE_REUSE_MS);
  }
  // 2026-10-27: an older "signed in" over the very same login files no longer
  // blocks a launch for the 0.7–5 s CLI probe. The session starts at once and the
  // probe runs alongside; a "login required" answer still notifies, and a CLI that
  // fails on a revoked login goes through recover() as before.
  staleButSame(seen) {
    return seen?.state === 'signed_in' && seen.sameCredential === true
      && this.now() - (Number(seen.observedAt) || 0) >= 0;
  }
  // Start the same read-only check while the user chooses launch options.
  // AccountCenter deduplicates pending checks by identity and stores freshness.
  // Login windows remain exclusive to the account page's explicit login action.
  async precheck(kind, opts = {}) {
    const id = this.connection(kind, opts);
    if (!id || this.reusable(id)) return;
    try { await this.accounts.check(id, {quiet:true, resume:false}); } catch {}
  }
  async ensure(kind, opts = {}) {
    const id = this.connection(kind, opts);
    if (!id) return;
    const seen = this.observation(id);
    if (this.reusable(id, seen)) return;
    if (this.staleButSame(seen)) { this.flight(id, {background:true}).catch(() => {}); return; }
    return this.flight(id);
  }
  flight(id, {background = false} = {}) {
    // Only requests for the same account and credential files share a check: a profile
    // re-pointed to another home or freshly logged in while a check runs starts its own.
    const key = this.identity(id);
    if (this.flights.has(key)) return this.flights.get(key);
    const flight = this.checkAndOpen(id, {background}).finally(() => this.flights.delete(key));
    this.flights.set(key, flight);
    return flight;
  }
  async recover(kind, opts, failure) {
    if (!isLoginFailure(failure)) return;
    const id=this.connection(kind,{...opts,launchProfile:opts?.claudeProfile || opts?.codexProfile || opts?.antigravityProfile});
    if (!id) return;
    try { this.accounts.markLoginRequired?.(id); } catch {}
    if (Date.now()-(this.recoveryAt.get(id)||0)<60000) return;
    this.recoveryAt.set(id,Date.now());
    this.notify({id,required:true,message:'此账号需要重新授权，请到账号页点击「授权」；完成后恢复或重启会话，已发送的问题不会自动重发。'});
  }
  async checkAndOpen(id, {background = false} = {}) {
    let proof;
    try { proof = await this.accounts.check(id, {quiet:true, resume:false}); }
    catch { return; } // Preserve the normal launch error when status is unknown.
    if (proof.state !== 'login_required') return;
    const message = background
      ? '此账号授权已失效，刚创建的会话可能无法回答；请在账号页点击「授权」，完成后重启该会话。'
      : '此账号尚未授权或授权已失效，请在账号页点击「授权」；完成后可返回继续创建，启动配置已保留。';
    this.notify({id, message, required:true, source:'launch'});
    throw Object.assign(new Error(message), {code:'auth_required',accountId:id});
  }
}
function isLoginFailure(failure) {
  if (failure?.code==='auth_required') return true;
  const text=typeof failure==='string'?failure:failure?.message || '';
  return /(?:^|\n|:\s)(?:not logged in|please (?:run )?\/login|authentication required|login required|oauth token (?:has )?expired|登录失效|需要登录)/i.test(text)
    || /\b401\b[^\n]{0,60}\bunauthorized\b/i.test(text);
}
module.exports = {LaunchAuth,isLoginFailure,SIGNED_IN_REUSE_MS,INCONCLUSIVE_REUSE_MS};
