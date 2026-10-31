'use strict';
// 账号页 · Claude 登录环境（2026-10-28，桌面「Claude 启动台」并入 Hub）。
// 规则：每个 Claude 账号一个出口；它的 VPS 登录环境必须走同一个出口 IP，打开、授权、日常使用一致。
// 已绑定的出口不在这里修改（用户：尽量不改）；新建账号时一次选定。
const fs = require('fs');
const path = require('path');
const { getConfig, saveConfig, readConfigJsonForUpdate } = require('../../core/hub-config.js');
const { getHubDataDir } = require('../../core/data-dir');
const vps = require('../../core/vps-login-env');
const profilesTool = require('../../core/claude-subscription-profiles');
const registry = require('../../core/subscription-account-registry');
const { isMailUrl } = require('../../core/claude-mailbox-vault');

function sharedIp(dataDir = getHubDataDir()) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'claude-egress-baseline.json'), 'utf8')).shared || ''; } catch { return ''; }
}
function profiles() { return profilesTool.normalizeProfiles(getConfig().claudeSubscriptionProfiles); }

function createVpsLoginService({ dataDir = getHubDataDir(), env = process.env, remote, sendToRenderer = () => {}, clearSessionManagerConfigCache = () => {} } = {}) {
  const service = new vps.VpsLoginEnv({ dataDir, remote, settings: vps.settings(env) });
  const enabled = () => !!remote || service.available();
  let flight = null;
  async function snapshot() {
    const status = await service.status();
    const list = profiles(), names = service.launcherNames(), ip = sharedIp(dataDir);
    const view = vps.describe({ profiles: list, status, sharedIp: ip, names });
    const labels = {};
    for (const e of view.envs) labels[e.id] = e.boundTo ? (list.find(p => p.id === e.boundTo)?.label || e.name) : e.name;
    service.writeNames(labels);
    // The account page needs the exits a new account may use (with 是否接通本机), not describe()'s plain list.
    return { ...view, enabled: true, sharedIp: ip, routes: vps.routeTemplates(list, status, ip) };
  }
  function profileOf(id) {
    const p = profiles().find(x => x.id === id);
    if (!p) throw new Error('Claude 账号不存在，请刷新账号页');
    return p;
  }
  // A new environment or a free existing one, on the route whose IP equals this account's exit.
  async function resolveEnvironment({ runIp, loginEnv, status, onProgress = () => {} }) {
    const route = Object.values(status.routes || {}).find(r => r.ip === runIp);
    if (!route) throw new Error(`VPS 上没有出口 IP 为 ${runIp} 的线路，无法建立一致的登录环境`);
    if (loginEnv === 'new') {
      onProgress('正在 VPS 上新建登录环境并核对出口（约 15–45 秒）');
      return (await service.create(route.id)).id;
    }
    const env = status.accounts?.[loginEnv];
    if (!env) throw new Error('所选登录环境已不存在，请刷新');
    if (env.route !== route.id) throw new Error('所选登录环境的出口与账号出口不一致，不能绑定');
    if (env.managed && !env.provisioned) throw new Error('所选登录环境尚未创建完成');
    if (profiles().some(p => vps.bindingFor(p) === loginEnv)) throw new Error('这个登录环境已被其他账号使用');
    return loginEnv;
  }
  return {
    enabled,
    service,
    async state() {
      if (!enabled()) return { enabled: false };
      if (!flight) flight = snapshot().finally(() => { flight = null; });
      return flight;
    },
    // url: only the account's own webmail (claude-mailbox-vault), so a sign-in link clicked there stays on this exit.
    async open({ profileId, confirmed = false, url = '' }) {
      const p = profileOf(profileId), id = vps.bindingFor(p);
      if (!id) throw new Error('这个账号还没有登录环境，请先绑定');
      if (url && !isMailUrl(url)) throw new Error('只能在登录环境里打开账号邮箱');
      const view = await snapshot();
      const row = view.accounts.find(a => a.profileId === profileId);
      if (!row.consistent) throw new Error(row.problem + '；为保证同一 IP，未打开');
      let result;
      try { result = await service.open(id, { confirmed, url, onProgress: message => sendToRenderer('vps-login-progress', { profileId, message }) }); }
      catch (error) {
        // VPS manager before 1.1.2 refuses webmail pages; the window itself is already up by then.
        if (url && /仅支持打开 Claude 官方页面或出口检测页面/.test(error.message)) throw new Error('登录窗口已打开，但 VPS 端还是旧版，不允许直接打开邮箱：请在登录窗口地址栏输入邮箱网址，或先把 VPS 端更新到 1.1.2');
        throw error;
      }
      if (result.needsConfirmation) {
        const names = view.envs.reduce((m, e) => ({ ...m, [e.id]: e.boundTo ? (profiles().find(x => x.id === e.boundTo)?.label || e.name) : e.name }), {});
        return { needsConfirmation: true, others: result.others.map(o => names[o] || o) };
      }
      return { ...result, message: url ? `已在「${p.label}」的登录窗口打开邮箱，出口 ${result.ip}` : `已打开「${p.label}」的登录窗口，出口 ${result.ip}` };
    },
    async stop({ profileId }) {
      const id = vps.bindingFor(profileOf(profileId));
      if (!id) throw new Error('这个账号还没有登录环境');
      await service.stop(id);
      return { message: '已关闭登录窗口，登录资料保留在 VPS' };
    },
    async bind({ profileId, loginEnv }) {
      const p = profileOf(profileId);
      if (vps.bindingFor(p)) throw new Error('这个账号已经有登录环境；为保持同一 IP，不在这里更换');
      const status = await service.status();
      const runIp = vps.runIpFor(p, sharedIp(dataDir));
      if (!runIp) throw new Error('还没有记录这个账号的运行出口 IP，请稍后再试');
      const id = await resolveEnvironment({ runIp, loginEnv, status, onProgress: message => sendToRenderer('vps-login-progress', { profileId, message }) });
      const raw = readConfigJsonForUpdate();
      saveConfig(registry.bindLoginEnv(raw, profileId, id, { normalized: profiles() }).raw);
      clearSessionManagerConfigCache();
      sendToRenderer('subscription-accounts-changed', { kind: 'claude', profileId });
      return { loginEnv: id, message: `已绑定登录环境，出口 ${runIp}` };
    },
    // For accounts:add-subscription: the exit and login environment a new Claude account is born with.
    async prepareNew({ route, loginEnv }) {
      const status = await service.status(), list = profiles(), ip = sharedIp(dataDir);
      const choice = vps.routeTemplates(list, status, ip).find(r => r.id === route);
      if (!choice) throw new Error('请选择出口');
      if (!choice.runnable) throw new Error('这个出口还没有接到本机，Claude 无法使用它');
      let network;
      if (!choice.shared) {
        const template = list.find(p => p.id === choice.template);
        network = { ...template.network, browserCommand: vps.ensureLoginBrowser(dataDir) };
      }
      const id = await resolveEnvironment({ runIp: choice.ip, loginEnv: loginEnv || 'new', status });
      return { network, loginEnv: id };
    },
  };
}

function registerVpsLoginIpc(ipcMain, deps = {}) {
  const service = createVpsLoginService(deps);
  // Built once, after startup has settled (the first compile takes 1–3 s on the main thread), so a
  if (service.enabled()) setTimeout(() => { try { vps.ensureLoginBrowser(deps.dataDir || getHubDataDir()); } catch (error) { console.warn('[vps-login] 登录转发程序未生成：' + error.message); } }, 20000).unref?.();
  const wrap = fn => async (_e, payload = {}) => {
    try { return { ok: true, data: await fn(payload) }; }
    catch (error) { return { ok: false, error: error.message }; }
  };
  ipcMain.handle('vps-login:state', wrap(() => service.state()));
  ipcMain.handle('vps-login:open', wrap(p => service.open(p)));
  ipcMain.handle('vps-login:stop', wrap(p => service.stop(p)));
  ipcMain.handle('vps-login:bind', wrap(p => service.bind(p)));
  return service;
}

module.exports = { createVpsLoginService, registerVpsLoginIpc, sharedIp };
