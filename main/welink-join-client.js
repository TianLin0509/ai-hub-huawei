'use strict';
// 一键入群·发送端（r47，2026-11-18）：底栏「用户群」弹层里点「一键入群」→ 经公司内网把 { account, group } 投给维护人
// 黄区电脑上的反馈收件机（POST /join/v1/request，见 main/feedback-receiver.js、core/welink-join.js），由它用 WeLink 管理员身份拉人。
// 账号开箱即用：本机已登录的 WeLink 身份（core/welink-account.js）→ 上次在弹层里填过的；都没有才让用户就地填一次。
// 收件地址复用一键反馈的 createReceiverAddress（内源发布）；收件机不在线时直接告诉用户先复制群号搜索，不排队。
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../core/atomic-write');
const { localWelinkAccount } = require('../core/welink-account');
const { normalizeAccount } = require('../core/welink-account-format');
const { listGroups } = require('../core/welink-user-groups');

const JOIN_PATH = '/join/v1/request';
// 收件机那边最多要查两次群成员再拉一次人，每次 welink-cli 最长 30 秒。
const REQUEST_TIMEOUT_MS = 100000;
const OFFLINE_HINT = '维护人电脑暂时不在线，可先复制群号在 WeLink 搜索';

function createWelinkJoinClient({ dataDir, receiverAddress, fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = REQUEST_TIMEOUT_MS, logger = console } = {}) {
  const savedFile = path.join(dataDir, 'welink-join.json');

  function savedAccount() {
    try { return normalizeAccount(JSON.parse(fs.readFileSync(savedFile, 'utf8')).account); } catch { return ''; }
  }
  function account() { return normalizeAccount(localWelinkAccount(dataDir)) || savedAccount(); }
  function saveAccount(value) {
    try { fs.mkdirSync(dataDir, { recursive: true }); writeFileAtomic(fs, savedFile, JSON.stringify({ account: value }) + '\n'); } catch { /* 存不下下次再填 */ }
  }

  function state() {
    const a = account();
    return { ok: true, account: a, needAccount: !a, groups: listGroups().map(g => ({ id: g.id, name: g.name, full: g.full })) };
  }

  async function post(url, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url + JOIN_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal, redirect: 'error' });
      let json = null; try { json = JSON.parse(await res.text()); } catch { /* 不是 JSON */ }
      // 旧版收件机没有这个地址：当作不在线，提示先复制群号。
      if (res.status === 404) return { ok: false, offline: true, reason: '维护人电脑上的 Hub 还不支持一键入群' };
      if (json && typeof json === 'object') return { ...json, ok: res.ok && json.ok === true, status: res.status };
      return { ok: false, offline: false, status: res.status, error: `收件机返回 ${res.status}` };
    } catch (error) {
      if (ctl.signal.aborted) return { ok: false, offline: false, error: `${Math.round(timeoutMs / 1000)} 秒内维护人电脑没有回复，请稍后看看 WeLink 里是否已入群` };
      return { ok: false, offline: true, reason: `连不上维护人电脑（${(error.cause && error.cause.code) || error.message}）` };
    } finally { clearTimeout(timer); }
  }

  // 返回给界面的结果：{ ok, result:'joined'|'already', group, redirectedFrom?, message } 或 { ok:false, offline?, needAccount?, message }。
  async function join({ group, account: typed } = {}) {
    const groups = listGroups();
    const target = groups.find(g => g.id === String(group || ''));
    if (group && !target) return { ok: false, message: '只能加入 AI HUB-H 用户群' };
    let who = account();
    if (typed != null && String(typed).trim()) {
      who = normalizeAccount(typed);
      if (!who) return { ok: false, needAccount: true, invalid: true, message: '账号格式不对：应是拼音首字母加工号，例如 a00123456' };
      saveAccount(who);
    }
    if (!who) return { ok: false, needAccount: true, message: '没找到本机登录的 WeLink 账号，请填一下你的账号' };
    let addr = { urls: [] };
    try { if (receiverAddress) addr = await receiverAddress.resolve(); } catch { /* 当作没地址 */ }
    if (!addr || !Array.isArray(addr.urls) || !addr.urls.length) return { ok: false, offline: true, message: OFFLINE_HINT };
    let last = null;
    for (const url of addr.urls) {
      last = await post(url, { account: who, ...(target ? { group: target.id } : {}) });
      if (!last.offline) break;
    }
    if (last.offline) { logger.warn?.('[welink-join] 收件机不在线：', last.reason); return { ok: false, offline: true, message: OFFLINE_HINT }; }
    if (!last.ok) return { ok: false, message: last.error || '入群失败', code: last.code };
    const name = last.group && last.group.name || (target && target.name) || '用户群';
    const message = last.result === 'already' ? `你已在 ${name}里`
      : last.redirectedFrom ? `${last.redirectedFrom.name || '这个群'}已满，已为你加入 ${name}`
        : `已加入 ${name}，到 WeLink 里就能看到`;
    return { ok: true, result: last.result, group: last.group, redirectedFrom: last.redirectedFrom, account: who, message };
  }

  return { state, join, account };
}

function registerWelinkJoinIpc(ipcMain, client) {
  ipcMain.handle('welink-join:state', () => client.state());
  ipcMain.handle('welink-join:request', async (_e, payload = {}) => {
    try { return await client.join(payload || {}); } catch (e) { return { ok: false, message: e.message }; }
  });
}

module.exports = { createWelinkJoinClient, registerWelinkJoinIpc, JOIN_PATH, OFFLINE_HINT };
