'use strict';
// 界面侧访问定位中心（2026-11-20，HUB-H 第一期 A 线）：体检、启动中心、CodeAgent 安装说明、一键反馈共用这一个入口。
// 调用返回 missing，调用方按原来的方式显示，不报错。
const clients = new WeakMap();
const isMissing = error => /No handler registered/i.test(String((error && error.message) || error || ''));

function createHarnessClient(ipcRenderer) {
  if (clients.has(ipcRenderer)) return clients.get(ipcRenderer);
  let missing = false;
  async function call(channel, payload) {
    let value;
    try { value = await ipcRenderer.invoke(channel, payload); missing = false; }
    catch (error) { if (isMissing(error)) { missing = true; return { missing: true }; } throw error; }
    // 主进程出错时回 { ok: false, error }（main/ipc/harness-locator-handlers.js 的 wrap），按失败抛给调用方显示。
    if (value && value.ok === false && !value.verdict) throw new Error(value.error || '定位中心没响应');
    return { value };
  }
  const listeners = new Set();
  ipcRenderer.on('harness:changed', (_event, payload) => {
    if (!payload || !payload.id) return;
    for (const fn of listeners) { try { fn(payload.id, payload.result); } catch (error) { console.warn('[harness] 刷新界面失败：', error.message); } }
  });
  const api = {
    get missing() { return missing; },
    peekAll: () => call('harness:peek-all'),
    locateAll: ({ fresh = false } = {}) => call('harness:locate-all', { fresh }),
    locate: (id, { fresh = false } = {}) => call('harness:locate', { id, fresh }),
    // 取消选择返回 { value: null }。
    pickPath: id => call('harness:pick-path', { id }),
    // 不弹框、按给定路径试跑（版本选择器从列表里选一份时用）；ok 才保存。
    setPath: (id, file) => call('harness:set-path', { id, path: file }),
    clearPath: id => call('harness:clear-path', { id }),
    applyFix: (id, act, payload = {}) => call('harness:apply-fix', { ...payload, id, act }),
    async diagnosisText(ids) {
      const r = await call('harness:diagnosis', ids && ids.length ? { ids } : {});
      return r.missing ? '' : String((r.value && r.value.text) || '');
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  clients.set(ipcRenderer, api);
  return api;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { require('electron').clipboard.writeText(text); }
}

module.exports = { createHarnessClient, copyText, isMissing };
