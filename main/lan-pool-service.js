'use strict';
const pool = require('../core/lan-pool');
const { LanPoolGateway } = require('./lan-pool-gateway');
const WATCH_MS = 30000;
class LanPoolService {
  constructor({ dataDir, proxyService, onChanged = () => {}, onNotice = () => {} }) {
    Object.assign(this, { dataDir, proxyService, onChanged, onNotice });
    this.quotaReader = async () => ({ rows: [] }); this.cached = null; this.pending = null; this.error = ''; this.fetchedAt = 0; this.revision = 0;
    // Host health is what the host user sees: sharing must never stop silently.
    this.hostError = ''; this.hostErrorAt = 0; this.addressChanged = null; this.syncing = null; this.noticeShown = ''; this.timer = null;
    this.gateway = new LanPoolGateway({ dataDir, getEndpoint: () => require('../core/company-model-proxy').readEndpoint(dataDir),
      getReady: () => proxyService.state === 'running', getSnapshot: async () => pool.quotaSnapshot(await this.quotaReader(), proxyService.lastStatus?.router) });
  }
  hostHealth() {
    const host = pool.read(this.dataDir).host || {};
    if (!host.enabled) return { phase: 'off' };
    const running = !!this.gateway.server?.listening;
    const phase = !running ? (this.syncing ? 'starting' : 'error') : this.proxyService.state === 'running' ? 'serving' : 'waiting-model';
    return { phase, error: phase === 'serving' ? '' : this.hostError || (phase === 'waiting-model' ? '本机模型服务准备中，同事请求会暂时失败' : ''),
      errorAt: this.hostErrorAt || null, addressChanged: this.addressChanged, retrySeconds: WATCH_MS / 1000 };
  }
  settings() {
    return { ok: true, ...pool.publicSettings(this.dataDir), gateway: { ...this.gateway.status(), modelReady: this.proxyService.state === 'running' },
      health: this.hostHealth(), error: this.error, clientState: this.clientState() };
  }
  client() { return pool.read(this.dataDir).client; }
  clientState() {
    const client = this.client(); if (!client?.enabled) return null;
    return { connection: this.cached?.connection || 'connecting', error: this.error, fetchedAt: this.fetchedAt || null,
      member: this.cached?.member || null, myUsage: this.cached?.myUsage || null };
  }
  clientProxyStatus() {
    const client = this.client(); if (!client?.enabled) return null;
    return { state: this.cached?.ready ? 'running' : 'not-ready', shared: true, message: this.cached?.ready
      ? '已连接共享主机，新建会话使用主机号池；账号登录和区域由主机管理。' : this.error || '正在连接共享主机…',
      code: this.cached?.ready ? null : 'SHARED_HOST_UNAVAILABLE',
      accounts: (this.cached?.rows || []).map(r => ({ id: r.id, kind: 'pool', paused: r.state !== 'ready' || !!r.avoid,
        models: r.models, modelsAuthoritative: r.modelsAuthoritative, coolingUntil: r.avoid?.until || null })),
      port: Number(new URL(client.address).port) || 80 };
  }
  async snapshot({ force = false } = {}) {
    const client = this.client(); if (!client?.enabled) return null;
    if (this.pending) return this.pending;
    if (!force && Date.now() - this.fetchedAt < 15000 && this.cached) return this.cached;
    const revision = this.revision;
    const task = pool.fetchSnapshot(client).then(snapshot => {
      if (revision !== this.revision) return this.cached;
      const recovered = this.cached?.connection && this.cached.connection !== 'online';
      this.error = ''; this.cached = { ...snapshot, connection: 'online', revoked: false };
      if (recovered) this.onNotice({ text: '共享主机已恢复连接，新建会话可以继续使用共享号池。', persistent: false });
      this.onChanged(); return this.cached;
    }).catch(error => {
      if (revision !== this.revision) return this.cached;
      const revoked = error.code === 'REVOKED', wasOnline = !this.cached || this.cached.connection === 'online';
      this.error = error.message;
      // Offline keeps each account's last known state; only the connection is marked, so the
      // colleague does not read "host offline" as "account needs login".
      this.cached = { ...(this.cached || { rows: [], models: [], checkedAt: null }), ok: true, shared: true, serveEnabled: true,
        connection: revoked ? 'revoked' : 'offline', revoked, ready: false,
        message: this.error + (this.cached?.rows?.length ? '；保留上次额度读数' : ''),
        rows: (this.cached?.rows || []).map(r => ({ ...r, refresh: { status: 'failed' } })) };
      if (wasOnline) this.onNotice({ text: revoked ? '共享口令已被主机撤销，新建会话无法使用共享号池；请联系主机管理员，或在设置里断开共享。'
        : '共享主机连不上（' + this.error + '）。Hub 每 30 秒自动重连，恢复后会提示。', persistent: revoked });
      this.onChanged(); return this.cached;
    }).finally(() => { if (this.pending === task) { this.fetchedAt = Date.now(); this.pending = null; } });
    this.pending = task; return task;
  }
  async connect(request, { previous } = {}) {
    if (pool.read(this.dataDir).host?.enabled) throw new Error('请先关闭本机共享，再连接其他主机');
    const parsed = pool.parseInvite(request.address, request.key);
    const key = parsed.key; if (!/^[a-f0-9]{48}$/.test(key)) throw new Error('共享口令应为主机生成的 48 位口令');
    const client = { address: pool.address(parsed.address), key, enabled: true };
    const snapshot = await pool.fetchSnapshot(client); if (!snapshot.ready) throw new Error('主机已在线，但它的模型服务还没就绪；请稍等 1 分钟再连接，本机配置未改动');
    // previous is written together with the client so a crash can never leave a connection without its restore point.
    const current = pool.read(this.dataDir); pool.write(this.dataDir, { ...current, client: { ...client, previous: current.client?.previous || previous || null } });
    this.revision++; this.pending = null;
    this.cached = { ...snapshot, connection: 'online', revoked: false }; this.fetchedAt = Date.now(); this.error = ''; this.onChanged();
    return this.settings();
  }
  async disconnect() {
    const current = pool.read(this.dataDir); pool.write(this.dataDir, { ...current, client: null });
    this.revision++; this.pending = null;
    this.cached = null; this.error = ''; this.onChanged(); return this.settings();
  }
  async configureHost(request) {
    const current = pool.read(this.dataDir);
    // Turning sharing off must always work, even after unplugging a NIC or changing networks.
    if (request.enabled === false) {
      pool.write(this.dataDir, { ...current, host: { ...current.host, enabled: false } });
      this.hostError = ''; this.addressChanged = null; this.noticeShown = '';
      await this.gateway.stop(); this.onChanged(); void this.proxyService.syncWithConfig(); return this.settings();
    }
    if (request.enabled && current.client?.enabled) throw new Error('请先断开其他主机，再开启本机共享');
    const nextPort = pool.port(request.port ?? current.host?.port ?? pool.DEFAULT_PORT);
    const bindAddress = pool.bindAddress(request.bindAddress || pool.publicSettings(this.dataDir).host.bindAddress);
    if (this.gateway.server && this.gateway.status().port !== nextPort) throw new Error('请先关闭共享，再修改端口');
    if (this.gateway.server && this.gateway.host !== bindAddress) throw new Error('请先关闭共享，再更换网卡');
    pool.write(this.dataDir, { ...current, host: { ...current.host, port: nextPort, bindAddress, enabled: !!request.enabled } });
    this.addressChanged = null;
    try { await this.sync(); }
    catch (error) { pool.write(this.dataDir, current); await this.gateway.stop(); this.hostError = ''; throw error; }
    this.onChanged(); return this.settings();
  }
  // One sync at a time: startup, the watchdog, resume and the settings switch can all ask at once.
  sync() {
    if (!this.syncing) this.syncing = this.syncOnce().finally(() => { this.syncing = null; });
    return this.syncing;
  }
  async syncOnce() {
    const host = pool.read(this.dataDir).host;
    if (!host?.enabled) { await this.gateway.stop(); return; }
    try {
      const status = await this.proxyService.ensureRunning();
      if (status.state === 'failed' || (status.state === 'not-ready' && status.code !== 'INITIALIZING')) throw new Error(status.message || '本机模型服务尚未就绪');
      let wanted = host.bindAddress || pool.publicSettings(this.dataDir).host.bindAddress;
      const available = pool.localAddresses();
      if (wanted !== '127.0.0.1' && !available.includes(wanted)) {
        // DHCP renewals and Wi-Fi/wired switches change the address. Follow the current office NIC
        // and tell the host user, instead of leaving every colleague on a dead address.
        if (!available.length) throw Object.assign(new Error('本机当前没有内网 IPv4 网卡，共享暂停；连上公司网络后自动恢复'), { code: 'NO_LAN' });
        const next = available[0];
        this.addressChanged = { from: wanted, to: next, at: Date.now() };
        pool.write(this.dataDir, { ...pool.read(this.dataDir), host: { ...host, bindAddress: next } });
        this.onNotice({ text: `本机内网地址从 ${wanted} 变成了 ${next}，共享已换到新地址。请把新地址发给同事（账号页 → 内网共享可复制）。`, persistent: true });
        wanted = next;
      }
      if (this.gateway.server && this.gateway.host !== wanted) await this.gateway.stop();
      this.gateway.host = wanted;
      await this.gateway.start(host.port);
      const hadError = !!this.hostError;
      this.hostError = ''; this.hostErrorAt = 0; this.noticeShown = '';
      if (hadError) { this.onNotice({ text: '号池内网共享已自动恢复。', persistent: false }); this.onChanged(); }
    } catch (error) {
      this.hostError = error.code === 'EADDRINUSE' ? '共享端口已被其他程序占用；关闭共享后换一个端口'
        : error.code === 'EADDRNOTAVAIL' ? '共享网卡暂不可用，正在等待网络恢复' : error.message;
      this.hostErrorAt = Date.now();
      if (this.noticeShown !== this.hostError) {
        this.noticeShown = this.hostError;
        this.onNotice({ text: '号池内网共享暂停：' + this.hostError + `。Hub 每 ${WATCH_MS / 1000} 秒自动重试，同事暂时连不上。`, persistent: true });
      }
      this.onChanged(); throw new Error(this.hostError);
    }
  }
  // Recover without user action: failed host start, network change, sleep/resume, or a host coming back online.
  startWatchdog() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), WATCH_MS); this.timer.unref?.();
  }
  async tick() {
    try {
      const settings = pool.read(this.dataDir);
      if (settings.host?.enabled) {
        const bound = this.gateway.server?.listening ? this.gateway.host : '';
        const lost = bound && bound !== '127.0.0.1' && !pool.localAddresses().includes(bound);
        if (!bound || lost || this.hostError) await this.sync().catch(() => {});
      }
      if (settings.client?.enabled && this.cached?.connection !== 'revoked') {
        const stale = Date.now() - this.fetchedAt > (this.cached?.connection === 'online' ? 55000 : 25000);
        if (stale) await this.snapshot({ force: true });
      }
    } catch (error) { console.warn('[lan-pool] watchdog: ' + error.message); }
  }
  async resume() {
    const settings = pool.read(this.dataDir);
    if (settings.host?.enabled) await this.sync().catch(() => {});
    if (settings.client?.enabled) await this.snapshot({ force: true });
  }
  add(request) { const result = pool.addMember(this.dataDir, request); this.onChanged(); return { ok: true, ...result, invite: this.invite(result.secret) }; }
  invite(secret) {
    const address = pool.publicSettings(this.dataDir).host.addresses[0] || '';
    return address ? pool.formatInvite(address, secret) : '';
  }
  revoke(id) { pool.revoke(this.dataDir, id); this.gateway.kick(id); this.onChanged(); return this.settings(); }
  async stop() { if (this.timer) clearInterval(this.timer); this.timer = null; await this.gateway.stop(); }
}
module.exports = { LanPoolService };
