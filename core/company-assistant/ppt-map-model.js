'use strict';
// 做法同 answer-bench：先 --help 看支持哪些参数；低档模型按顺序试，第一个调通的留下；全部不通就退回只用规则，并把原因告诉界面。
// 进程全部隐藏窗口（windowsHide）；超时或取消时结束整个进程树。只发页文字的前 600 字，结果只留本机。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { withDeadline, waitForProcess } = require('../help-ask/request-lifecycle');

const DEFAULT_MODELS = ['deepseek-v4.1-flash-1017', 'GLM-5.2-WX-Auto'];
const BATCH_TIMEOUT_MS = 4 * 60000;

// 起一次 codeagent：cmd 的 call 让 .cmd/.bat 包装设好证书与代理（同 codeagent-serve）。返回 { code, stdout, stderr, timedOut, aborted }。
function runOnce({ command, args, input = '', cwd, env, timeoutMs, signal, onActivity = () => {}, spawnImpl = spawn }) {
  let stdout = '', stderr = '';
  return withDeadline(({ signal: requestSignal }) => new Promise(resolve => {
    const head = /^[A-Za-z0-9_.-]+$/.test(command) ? command : `"${path.normalize(String(command).replace(/"/g, ''))}"`;
    const line = [head, ...args.map(a => /^[A-Za-z0-9_.=:,-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '')}"`)].join(' ');
    let child;
    try {
      child = process.platform === 'win32'
        ? spawnImpl('cmd.exe', ['/d', '/s', '/c', `"call ${line}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true })
        : spawnImpl('/bin/sh', ['-c', line], { cwd, env, windowsHide: true });
    } catch (error) { resolve({ code: -1, stdout: '', stderr: error.message }); return; }
    const completion = waitForProcess(child, { signal: requestSignal, onActivity });
    child.stdout?.on('data', d => { stdout += d; });
    child.stderr?.on('data', d => { stderr += d; });
    completion.then(code => resolve({ code, stdout, stderr, timedOut: false, aborted: false }),
      error => resolve({ code: null, stdout, stderr: stderr + error.message, timedOut: !!error.timedOut, aborted: !!signal?.aborted }));
    child.stdin?.on?.('error', () => { /* EPIPE 以退出结果为准 */ });
    try { child.stdin?.end(input); } catch { /* 进程已退出 */ }
  }), { signal, timeoutMs }).catch(error => ({ code: null, stdout, stderr: stderr + error.message, timedOut: !!error.timedOut, aborted: !!signal?.aborted }));
}

// 回复取正文：--output-format json 时是一个 result 事件；不认这个参数的旧版直接是正文。
function replyText(stdout) {
  const text = String(stdout || '').trim();
  for (const line of text.split(/\r?\n/).reverse()) {
    const t = line.trim(); if (!t.startsWith('{')) continue;
    let ev; try { ev = JSON.parse(t); } catch { continue; }
    if (ev?.type !== 'result') continue;
    if (ev.is_error) throw new Error(String(ev.result || '模型返回错误'));
    return String(ev.result || '');
  }
  return text;
}

const short = (s, n = 160) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

function createCodeAgentChannel({ dataDir, choiceDataDir = dataDir, models = [], env = process.env, timeoutMs = BATCH_TIMEOUT_MS, spawnImpl = spawn, findCommand = null, resolveConfig = null } = {}) {
  const wanted = [...new Set([...models.filter(Boolean), ...DEFAULT_MODELS])];
  let selectedFailure = null;
  let help = null, picked = '', tried = new Set(), lastReason = '';
  const cwd = path.join(dataDir, 'ppt-map', 'agent-cwd');
  function launch() {
    const found = (findCommand || (c => require('../community-setup').findCommand(c, env)))('codeagent');
    if (!found) return { ok: false, reason: '这台电脑没找到 CodeAgent 命令行，先只用规则分类' };
    const config = (resolveConfig || (e => require('../codeagent-config').resolveCodeAgentConfig(e)))(env);
    const childEnv = { ...env };
    try { require('../codeagent-launch-env').applyAccountEnv(childEnv, { configDirEnv: config.configDirEnv, configDir: config.configDir }); }
    catch { /* 读不到号池时按 CLI 默认账号 */ }
    // 不让这个临时进程的 hook 冒充 Hub 会话（同 codeagent-serve）
    for (const key of Object.keys(childEnv)) if (/^CLAUDE_HUB_(?:SESSION_ID|PORT|TOKEN)$|^CODEAGENT_HUB_/.test(key)) delete childEnv[key];
    return { ok: true, command: config.command || found, env: childEnv };
  }
  function args(model) {
    const a = ['-p', '--model', model];
    const supports = flag => !help || help.includes(flag);
    if (supports('--output-format')) a.push('--output-format', 'json');
    if (supports('--effort')) a.push('--effort', 'low');
    if (supports('--max-turns')) a.push('--max-turns', '1');
    if (supports('--disable-update')) a.push('--disable-update');
    return a;
  }
  async function probe({ signal } = {}) {
    selectedFailure = null; // 用户再次启动库地图更新时才重新检测，不在每一批里重试坏线路。
    const selected = require('../feature-agent-choice').resolve(choiceDataDir, 'pptMap').selected;
    if (selected) return { available: true, model: selected.model || selected.kind, reason: '' };
    const l = launch();
    if (!l.ok) { lastReason = l.reason; return { available: false, reason: l.reason }; }
    tried.clear(); // 每次更新库地图都重新试候选模型：上次不通、这次可能已开通
    if (help === null) {
      fs.mkdirSync(cwd, { recursive: true });
      const r = await runOnce({ command: l.command, args: ['--help'], cwd, env: l.env, timeoutMs: 60000, signal, spawnImpl });
      if (r.aborted) { help = null; return { available: false, reason: '已取消' }; }
      help = String(r.stdout || '');
      if (r.code !== 0 && !help.includes('-p')) { help = null; lastReason = 'CodeAgent 命令行打不开：' + short(r.stderr || r.stdout || `退出码 ${r.code}`); return { available: false, reason: lastReason }; }
    }
    return { available: true, model: picked || wanted[0], reason: '' };
  }
  async function run(prompt, { signal, onAttempt } = {}) {
    const selected = require('../feature-agent-choice').resolve(choiceDataDir, 'pptMap').selected;
    if (selected) {
      const key = JSON.stringify(selected);
      if (selectedFailure?.key === key) throw Object.assign(new Error(selectedFailure.reason), { channelDown: true });
      onAttempt?.();
      try { return await require('../feature-agent-run').run(selected, prompt, { dataDir, env, signal, timeoutMs }); }
      catch (error) {
        if (signal?.aborted || error.aborted) throw Object.assign(error, { aborted: true });
        lastReason = `所选 ${require('../feature-agent-choice').LABELS[selected.kind] || selected.kind} 失败，本次改用规则分类：${error.message}`;
        selectedFailure = { key, reason: lastReason };
        throw Object.assign(new Error(lastReason), { channelDown: true });
      }
    }
    const l = launch();
    if (!l.ok) throw Object.assign(new Error(l.reason), { channelDown: true });
    fs.mkdirSync(cwd, { recursive: true });
    // 先用调通过的模型；它失败了（不是超时）就接着试其余候选，调通的留下；全部不通 → channelDown，本次改为只用规则。
    // 单批超时只让这一批待重试，不连带把每个候选都等一遍。
    const order = [...(picked ? [picked] : []), ...wanted.filter(m => m !== picked && !tried.has(m))];
    if (!order.length) throw Object.assign(new Error(lastReason || 'CodeAgent 调不通'), { channelDown: true });
    let lastError = '';
    for (const model of order) {
      if (signal?.aborted) throw Object.assign(new Error('已取消'), { aborted: true });
      onAttempt?.();  // 每真起一次模型进程记一次（候选重试也算），额度提示不少报
      const r = await runOnce({ command: l.command, args: args(model), input: prompt, cwd, env: l.env, timeoutMs, signal, spawnImpl });
      if (r.aborted) throw Object.assign(new Error('已取消'), { aborted: true });
      let text = '';
      lastError = '';
      try { text = r.code === 0 ? replyText(r.stdout) : ''; } catch (error) { lastError = error.message; }
      if (r.code === 0 && text) { picked = model; return text; }
      lastError = lastError || (r.timedOut ? `等了 ${Math.round(timeoutMs / 60000)} 分钟没回` : short(r.stderr || r.stdout || `退出码 ${r.code}`));
      if (model === picked && r.timedOut) throw new Error(`模型 ${model}：${lastError}`);
      tried.add(model);
      if (model === picked) picked = null;
    }
    lastReason = `CodeAgent 调不通（试了 ${wanted.join('、')}）：${lastError}`;
    throw Object.assign(new Error(lastReason), { channelDown: true });
  }
  return { probe, run, model: () => {
    const selected = require('../feature-agent-choice').resolve(choiceDataDir, 'pptMap').selected;
    return selected ? selected.model || selected.kind : picked;
  }, reason: () => lastReason };
}

module.exports = { createCodeAgentChannel, runOnce, replyText, DEFAULT_MODELS };
