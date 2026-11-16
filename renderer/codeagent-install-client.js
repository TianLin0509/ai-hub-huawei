'use strict';
// 页面侧的 CodeAgent 一键安装 / 升级（2026-11-16，主进程 main/ipc/codeagent-install-handlers.js）。
// 安装说明框、版本过旧提醒、报错卡都用它：点一下开始，进度和失败原因用人话写回调用方给的位置；
// 需要用户自己下载时（没装、本机也没有安装包）把「打开官方下载页」按钮交给调用方显示。
const ACTIVE = new Set(['upgrading', 'verifying', 'installing', 'rediscovering', 'downloading', 'waiting-download']);

function createCodeAgentInstallClient({ ipcRenderer }) {
  const listeners = new Set();
  let last = null;
  const onState = (_event, state) => { last = state; for (const fn of listeners) { try { fn(state); } catch { /* 单个界面出错不影响别的 */ } } };
  ipcRenderer.on?.('codeagent-install:state', onState);
  return {
    get last() { return last; },
    active: state => !!state && ACTIVE.has(state.phase),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // 返回最终状态（done / error / need-download / waiting-download）。
    async start(options = {}) {
      try { const r = await ipcRenderer.invoke('codeagent-install:start', options); last = r || last; return r; }
      catch (error) { return { phase: 'error', message: '一键安装没能启动：' + error.message }; }
    },
    async openOfficial() {
      try { return await ipcRenderer.invoke('codeagent-install:open-official'); }
      catch (error) { return { ok: false, error: error.message }; }
    },
  };
}

// 一次「一键安装」从点下去到终态（2026-11-16 r25b）：要先去官方页下载时也一直订阅，
// 下载后的核签名、安装、管理员确认取消等结果都能回到调用方；到 done / error 才结束。返回 stop() 供页面关闭时退订。
function runOneClick(client, { onMessage = () => {}, onWaiting = () => {}, onSettled = () => {} } = {}) {
  let settled = false, waiting = false, off = () => {};
  const settle = s => { if (settled) return; settled = true; off(); onSettled(s || { phase: 'error', message: '已结束' }); };
  off = client.subscribe(s => {
    if (settled) return;
    if (s?.message) onMessage(s.message, s);
    if (waiting && (s?.phase === 'done' || s?.phase === 'error')) settle(s);
  });
  void (async () => {
    const r = await client.start();
    if (settled) return;
    if (r?.phase === 'need-download' && r.downloadPage) {
      const o = await client.openOfficial();
      if (settled) return;
      if (o?.ok) { waiting = true; onWaiting('已打开官方下载页：点页面里的下载，下完 Hub 自动核对并安装'); return; }
      settle({ phase: 'error', code: 'CA_OFFICIAL_PAGE', message: '官方下载页没能打开：' + (o?.error || '未知原因') });
      return;
    }
    settle(r);
  })().catch(error => settle({ phase: 'error', message: '一键安装没能完成：' + error.message }));
  return { stop() { settled = true; off(); }, get waiting() { return waiting; } };
}

let shared = null;
function sharedClient(ipcRenderer) { if (!shared) shared = createCodeAgentInstallClient({ ipcRenderer }); return shared; }

module.exports = { createCodeAgentInstallClient, sharedClient, runOneClick, ACTIVE };
