'use strict';
// 「问问 Hub」主进程侧（2026-11-19）：底栏按钮打开的答疑面板经这里问答。引擎与说明书在 core/help-ask/engine.js。
// - 同时只答一个问题（再点会提示上一个还在答），Hub 退出时结束进行中的问答进程；
// - 「打开说明书」把随包分发的说明书复制到数据目录 help-ask\ 下（安装目录里的文件可能在只读的程序包里），由界面在预览里打开；
// - 每次问答记一行到本机 help-ask\history.jsonl（问题、用的引擎、耗时、成没成，不含回答原文），最多留 500 行，只在本机。
const fs = require('node:fs');
const path = require('node:path');

const HISTORY_MAX = 500;
const MANUAL_NAME = 'AI-HUB-H-使用说明书.md';

function editionOf(distribution) {
  if (distribution && distribution.target === 'company') return distribution.featureEnabled('memberUpgrade') ? 'public' : 'member';
  return 'public';
}

function createHelpAskService({ getHubDataDir, distribution = require('../core/distribution'),
  getConfig = () => { try { return require('../core/hub-config').getConfig() || {}; } catch { return {}; } },
  createEngine = options => require('../core/help-ask/engine').createHelpAskEngine(options), env = process.env, logger = console } = {}) {
  const dataDir = getHubDataDir();
  const edition = editionOf(distribution);
  const engine = createEngine({ dataDir, edition, env, getConfig, getPreferred: () => getConfig()?.helpAsk?.engine || '' });
  const dir = path.join(dataDir, 'help-ask');
  let running = null;

  function record(entry) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'history.jsonl');
      let lines = [];
      try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { /* 第一次 */ }
      lines.push(JSON.stringify(entry));
      fs.writeFileSync(file, lines.slice(-HISTORY_MAX).join('\n') + '\n', 'utf8');
    } catch (error) { logger.warn?.('[help-ask] 记录失败：', error.message); }
  }

  async function ask({ question, history } = {}) {
    if (running) return { ok: false, busy: true, error: '上一个问题还在回答，稍等一下' };
    const controller = new AbortController();
    running = controller;
    try {
      // 报错卡带进来的文字可能含令牌、本机路径、工号、Cookie：交给模型和写记录前统一脱敏（复审补点）
      const { redact } = require('../core/hub-feedback');
      question = redact(String(question || ''));
      const result = await engine.ask({ question, history, signal: controller.signal });
      record({ at: new Date().toISOString(), q: String(question || '').slice(0, 300), ok: !!result.ok, engine: result.engine || '',
        model: result.model || '', ms: result.ms || 0, timedOut: !!result.timedOut, cancelled: !!result.cancelled, error: result.ok ? '' : String(result.error || '').slice(0, 300) });
      return result;
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    } finally { if (running === controller) running = null; }
  }

  // 取消：立即结束进行中的问答进程树，并马上放开名额，下一题不用等旧进程收尾。
  function cancel() {
    if (!running) return false;
    running.abort(); running = null;
    return true;
  }

  function openManual() {
    const st = engine.state();
    if (!st.manualPath) return { ok: false, error: '安装包里缺少使用说明书，请升级到最新版本' };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, MANUAL_NAME);
      fs.writeFileSync(target, fs.readFileSync(st.manualPath, 'utf8'), 'utf8');
      return { ok: true, path: target };
    } catch (error) { return { ok: false, error: '说明书复制失败：' + error.message }; }
  }

  return { state: () => ({ ...engine.state(), busy: !!running }), ask, openManual, cancel, dispose: () => running?.abort() };
}

function registerHelpAskIpc(ipcMain, service) {
  ipcMain.handle('help-ask:state', () => service.state());
  ipcMain.handle('help-ask:ask', (_event, payload = {}) => service.ask({ question: payload.question, history: payload.history }));
  ipcMain.handle('help-ask:cancel', () => { service.cancel(); return { ok: true }; });
  ipcMain.handle('help-ask:open-manual', () => service.openManual());
}

module.exports = { createHelpAskService, registerHelpAskIpc, editionOf, MANUAL_NAME };
