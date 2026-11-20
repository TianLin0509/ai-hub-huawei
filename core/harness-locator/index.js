'use strict';
// 定位中心的模块 API（接口合同 v1 第 1 节，只在 main 进程用）。主进程启动时 configure({ dataDir }) 建共享实例并 start()；
// 没 configure 时（脚本、测试、旧函数被单独调用）按需建一个不落盘的实例，行为一样，只是不记手动路径和上次结论。
const { HarnessLocator } = require('./locator');
const { IDS, SPECS } = require('./specs');
const { sanitizeText } = require('./sanitize');

let instance = null;
function configure(options = {}) {
  if (instance) instance.stop();
  instance = new HarnessLocator(options);
  return instance;
}
function get() { return instance || (instance = new HarnessLocator({})); }
function reset() { if (instance) instance.stop(); instance = null; }
// 一键安装器（core/cli-tools/installer.js）比定位中心晚建好，建好后登记进来，「一键补齐」经它装。
let installer = null;
function setInstaller(fn) { installer = fn; }
async function installTool(request) {
  if (!installer) return { ok: false, error: '这个版本暂不支持一键安装' };
  return installer(request);
}
// 一键安装器的进度：某个 CLI 装完（phase 变成 done）就立即重查它。
const INSTALL_IDS = new Set(['claude', 'codex', 'dsh', 'pi', 'node']);
const lastPhase = new Map();
function noteInstallState(state) {
  for (const [id, t] of Object.entries((state && state.tools) || {})) {
    const phase = t && t.phase;
    if (phase === 'done' && lastPhase.get(id) !== 'done' && INSTALL_IDS.has(id) && instance) void instance.refresh(id, 'install').catch(() => {});
    lastPhase.set(id, phase);
  }
}

module.exports = {
  IDS, SPECS, HarnessLocator, configure, get, reset, sanitizeText, setInstaller, installTool, noteInstallState,
  peek: id => get().peek(id),
  peekAll: () => get().peekAll(),
  locate: (id, opts = {}) => get().locate(id, opts),
  locateAll: (opts = {}) => get().locateAll(opts),
  launchSpec: (id, opts) => get().launchSpec(id, opts),
  setManualPath: (id, file) => get().setManualPath(id, file),
  clearManualPath: id => get().clearManualPath(id),
  setNodePin: (id, node) => get().setNodePin(id, node),
  diagnosisText: (ids, opts) => get().diagnosisText(ids, opts),
  onChange: listener => get().onChange(listener),
  quick: (id, opts) => get().quick(id, opts),
  quickAll: (id, opts) => get().quickAll(id, opts),
};
