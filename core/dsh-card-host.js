'use strict';
// DSH 卡片试点的共享进程：同一线路、模型和账号的几个会话共用一个 DSH ACP 进程。
// 实测 3 个会话约 350 MB，3 个真实终端约 1060 MB。反代按 Key 粘号，所以一个进程最多放 4 个会话，
// 再多就开下一个进程、用下一个 Key，账号负载不会全压在一个号上。
const { EventEmitter } = require('node:events');
const { AcpClient } = require('../main/acp-client');

const CAPACITY = 4;
const IDLE_CLOSE_MS = 60_000;
const CLOSE_TIMEOUT_MS = 8_000;
const START_TIMEOUT_MS = 150_000;

// 一个会话看到的连接：接口和 AcpClient 一样，消息按 sessionId 分流，关闭时只释放自己的会话。
class HostedAcpClient extends EventEmitter {
  constructor(host) {
    super();
    this.host = host;
    this.sessionId = null;
    this.closed = false;
  }
  get proc() { return this.host.client?.proc || null; }
  get incoming() { return this.host.client?.incoming || new Set(); }
  async start() {
    if (this.closed) throw new Error('ACP 连接已关闭');
    return this.host.ensure();
  }
  bind(sessionId) {
    this.sessionId = sessionId;
    this.host.bind(sessionId, this);
  }
  request(method, params, timeoutMs) {
    if (this.closed) return Promise.reject(Object.assign(new Error('ACP 连接已关闭'), { notSent: true }));
    const client = this.host.client;
    if (!client) return Promise.reject(Object.assign(new Error('DSH 共享进程未就绪'), { notSent: true }));
    if (method === 'session/new') {
      return client.request(method, params, timeoutMs).then(result => { this.bind(result.sessionId); return result; });
    }
    if (method === 'session/resume' || method === 'session/load') {
      this.bind(params.sessionId);
      // 同一会话刚释放时，等写入锁放开再恢复。
      return this.host.settled(params.sessionId).then(() => client.request(method, params, timeoutMs));
    }
    return client.request(method, params, timeoutMs);
  }
  notify(method, params) {
    if (!this.host.client) return Promise.reject(new Error('DSH 共享进程未就绪'));
    return this.host.client.notify(method, params);
  }
  respond(id, result, error, beforeWrite) {
    if (!this.host.client) return Promise.reject(new Error('DSH 共享进程未就绪'));
    return this.host.client.respond(id, result, error, beforeWrite);
  }
  // 释放这个会话的写入锁，之后真实终端才能接管。
  release() {
    if (this.released) return this.released;
    const sessionId = this.sessionId;
    this.released = sessionId ? this.host.closeSession(sessionId, this) : Promise.resolve();
    return this.released;
  }
  disconnected(error) {
    if (this.closed) return;
    this.closed = true;
    this.emit('disconnect', error);
  }
  fail(error) {
    if (this.closed) return;
    this.release().catch(() => {});
    this.disconnected(Object.assign(new Error(error?.message || 'ACP 连接已断开'), { uncertain: true }));
  }
  close() { this.fail(new Error('ACP 连接已关闭')); }
}

class DshCardHost extends EventEmitter {
  constructor({ scope, index, tag, createClient, idleCloseMs = IDLE_CLOSE_MS, onStopped }) {
    super();
    this.setMaxListeners(0);
    Object.assign(this, { scope, index, tag, createClient, idleCloseMs, onStopped });
    this.refs = 0;
    this.launch = null;
    this.client = null;
    this.ready = null;
    this.members = new Map();
    this.orphans = new Map();
    this.closing = new Map();
    this.stopped = false;
  }
  get pid() { return this.client?.proc?.pid || null; }
  setLaunch(launch) { this.launch ||= launch; }
  retain() {
    this.refs += 1;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
  release() {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs || this.stopped) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.refs) this.stop(); }, this.idleCloseMs);
    this.idleTimer.unref?.();
  }
  ensure() {
    if (this.stopped) return Promise.reject(new Error('DSH 共享进程已结束'));
    if (this.ready) return this.ready;
    if (!this.launch) return Promise.reject(new Error('DSH 共享进程缺少启动参数'));
    // 和 DSH 真实终端用同一个启动等待时间：电脑很忙时冷启动可能超过 30 秒。
    const timeoutMs = Number(process.env.AI_HUB_DSH_START_TIMEOUT_MS) > 0 ? Number(process.env.AI_HUB_DSH_START_TIMEOUT_MS) : START_TIMEOUT_MS;
    const client = (this.createClient || (options => new AcpClient(options)))({ ...this.launch, timeoutMs, capabilities: { elicitation: { form: {} } } });
    this.client = client;
    client.on('notification', message => this.route(client, 'notification', message));
    client.on('request', message => this.route(client, 'request', message));
    client.on('diagnostic', text => { for (const member of new Set(this.members.values())) member.emit('diagnostic', text); });
    client.on('disconnect', error => this.lost(client, error));
    this.ready = client.start().catch(error => {
      if (this.client === client) { this.client = null; this.ready = null; }
      throw error;
    });
    return this.ready;
  }
  route(client, event, message) {
    if (client !== this.client) return;
    const sessionId = message.params?.sessionId;
    const member = this.members.get(sessionId);
    if (member) { member.emit(event, message); return; }
    if (!sessionId || event !== 'notification') {
      if (event === 'request') client.respond(message.id, null, { code: -32602, message: 'Unknown session' }).catch(() => {});
      return;
    }
    // session/new 的结果到达前，这个会话的通知先记下来。
    const queue = this.orphans.get(sessionId) || [];
    if (queue.length < 200) queue.push(message);
    this.orphans.set(sessionId, queue);
  }
  bind(sessionId, member) {
    this.members.set(sessionId, member);
    const queue = this.orphans.get(sessionId);
    this.orphans.delete(sessionId);
    for (const message of queue || []) member.emit('notification', message);
  }
  settled(sessionId) { return this.closing.get(sessionId) || Promise.resolve(); }
  closeSession(sessionId, member) {
    if (this.members.get(sessionId) === member) this.members.delete(sessionId);
    const client = this.client;
    if (!client || client.closed) return Promise.resolve();
    // 写入锁没放开时 DSH 会拒绝第二个写入者（已实测），这里重试一次并留下日志，不把其他会话的进程杀掉。
    const close = () => Promise.resolve(client.request('session/close', { sessionId }, CLOSE_TIMEOUT_MS));
    const done = close().catch(() => (client.closed ? undefined : close()))
      .catch(error => console.warn('[dsh-card] 释放会话失败：', error?.message || error))
      .finally(() => { if (this.closing.get(sessionId) === done) this.closing.delete(sessionId); });
    this.closing.set(sessionId, done);
    return done;
  }
  lost(client, error) {
    if (client !== this.client) return;
    this.client = null;
    this.ready = null;
    this.closing.clear();
    this.orphans.clear();
    const members = [...new Set(this.members.values())];
    this.members.clear();
    for (const member of members) member.disconnected(error);
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.idleTimer);
    this.onStopped?.(this);
    const client = this.client;
    this.client = null;
    this.ready = null;
    client?.close();
  }
}

const pools = new Map();

function acquireDshCardHost(scope, { tagFor, capacity = CAPACITY, createClient, idleCloseMs } = {}) {
  const pool = pools.get(scope) || [];
  pools.set(scope, pool);
  let host = pool.find(item => !item.stopped && item.refs < capacity);
  if (!host) {
    let index = 0;
    while (pool.some(item => item.index === index)) index += 1;
    host = new DshCardHost({ scope, index, tag: tagFor ? tagFor(index) : `dshcard-${scope}-${index}`, createClient, idleCloseMs,
      onStopped: stopped => {
        const list = pools.get(scope) || [];
        const at = list.indexOf(stopped);
        if (at >= 0) list.splice(at, 1);
        if (!list.length) pools.delete(scope);
      } });
    pool.push(host);
  }
  host.retain();
  return host;
}

function shutdownDshCardHosts() {
  const hosts = [...pools.values()].flat();
  for (const host of hosts) host.stop();
  pools.clear();
  return hosts.length;
}

module.exports = { DshCardHost, HostedAcpClient, acquireDshCardHost, shutdownDshCardHosts, CAPACITY, IDLE_CLOSE_MS };
