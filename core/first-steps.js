'use strict';
// 新同事首次引导（2026-11-19 维护人勾选体验 8）：第一次打开 Hub 时，首页「连接你的 AI」变成三步——
//   ① 检测已装工具 → ② 选一个能用的模型 → ③ 发第一句话；每步没过就在这一步里给修复按钮。
// 这里只管「要不要显示」「每一步算不算过」，不碰界面、不读密钥；界面见 renderer/first-steps.js。
// 只给新用户：第一次判断时本机已有会话、或首次准备做过超过一天，就当老用户，直接记完成、永不显示。
const fs = require('node:fs');
const path = require('node:path');

const STATE_FILE = 'first-steps.json';
const EXISTING_PREP_AGE_MS = 24 * 3600 * 1000;
// 第三步预填的第一句话（不替用户发送，用户按回车才发）。
const FIRST_PROMPT = '你好，用三句话介绍一下你能帮我做什么。';

function readState(dataDir) {
  try { const s = JSON.parse(fs.readFileSync(path.join(dataDir, STATE_FILE), 'utf8')); return s && typeof s === 'object' ? s : null; }
  catch { return null; }
}
function writeState(dataDir, state) {
  try { require('./atomic-write').writeFileAtomic(fs, path.join(dataDir, STATE_FILE), JSON.stringify(state, null, 2)); return true; }
  catch { return false; }
}

// 返回 { show, reason, state, write }：write 非空时调用方把它存下（第一次判断的结论要稳定，下次不再重判）。
function decide({ state, sessionsCount = 0, prepState = null, now = Date.now(), isolated = false, forced = false }) {
  if (isolated && !forced) return { show: false, reason: 'isolated', state, write: null };
  if (state?.completedAt) return { show: false, reason: 'completed', state, write: null };
  if (state?.dismissedAt) return { show: false, reason: 'dismissed', state, write: null };
  if (state?.startedAt) {
    // 上次已发过第一句话：这次打开就算完成，不再出现。
    if (state.firstPromptAt && state.firstPromptAt < now - 60000) {
      const next = { ...state, completedAt: now, completedBy: 'first-prompt' };
      return { show: false, reason: 'completed', state: next, write: next };
    }
    return { show: true, reason: 'new-user', state, write: null };
  }
  const prepAt = Number(prepState?.at) || 0;
  if (sessionsCount > 0 || (prepAt && prepAt < now - EXISTING_PREP_AGE_MS)) {
    const next = { completedAt: now, completedBy: 'existing-user' };
    return { show: false, reason: 'existing-user', state: next, write: next };
  }
  const next = { startedAt: now };
  return { show: true, reason: 'new-user', state: next, write: next };
}

const USABLE_TOOLS = Object.freeze(['codeagent', 'claude', 'codex']);
const GATEWAY_TOOLS = Object.freeze(['claude', 'codex']);
const KIND_LABEL = Object.freeze({ codeagent: 'CodeAgent', claude: 'Claude Code', codex: 'Codex' });

const modelId = option => (typeof option === 'string' ? option : option?.id) || '';
const modelLabel = option => (typeof option === 'string' ? option : option?.label || option?.id) || '';

// 输入都是现有接口的返回值：
//   providers  community:setup 的 providers（id / name / installed）
//   personal   codeagent-pool:list 的 personal（state / modelOptions / models）；没装 CodeAgent 时为 null
//   gateway    api-gateway:get 的 gateway（keySet / models / choices / model）
//   isCompany  公司版；社区版第二步按「CLI 自己的登录」算
//   pick       用户在第二步点选的 { kind, model }
//   firstPromptAt 第一句话发出的时间
//   hubDefault Hub 里「设为默认」的 CodeAgent 模型（get-hub-config 的 defaultModels.codeagent）：排第一，和启动中心预选一致
function computeSteps({ providers = [], personal = null, gateway = null, isCompany = true, pick = null, firstPromptAt = null, checking = false, hubDefault = '' }) {
  const installed = new Set(providers.filter(p => p && p.installed).map(p => p.id));
  const known = new Set(providers.map(p => p && p.id));
  const tools = USABLE_TOOLS.filter(id => installed.has(id));
  const fix = (label, act, extra = {}) => ({ label, act, ...extra });

  // ① 检测已装工具
  let tool;
  if (checking) tool = { status: 'run', detail: '正在检查这台电脑装了哪些 AI 工具…', fixes: [] };
  else if (tools.length) tool = { status: 'ok', detail: `已装 ${tools.map(id => KIND_LABEL[id]).join('、')}`, fixes: [fix('完整体检', 'env-check')] };
  else {
    const fixes = [];
    if (known.has('codeagent')) fixes.push(fix('安装 CodeAgent', 'install', { tool: 'codeagent' }));
    else if (known.has('claude')) fixes.push(fix('一键安装 Claude Code', 'install', { tool: 'claude' }));
    fixes.push(fix('重新检测', 'recheck'));
    tool = { status: 'bad', detail: isCompany
      ? '还没装能用的 AI 工具。有 CodeAgent 账号就装 CodeAgent；只有部门 API key 就点下面 Claude Code 旁的「安装」。装好点「重新检测」。'
      : '还没装能用的 AI 工具。装一个 Claude Code 或 Codex 就能开始，装好点「重新检测」。', fixes };
  }

  // ② 选一个能用的模型：列出现在就能用的来源和模型，默认选第一个，用户可以改。
  const options = [];
  let codeagentEmpty = false;
  if (installed.has('codeagent') && personal && personal.state === 'ready') {
    // modelOptions 已按权限、避让筛过（暂不可用的带 unavailable）：读到了就只认它，读到空也不退回没筛过的 models。
    const read = Array.isArray(personal.modelOptions) ? personal.modelOptions : null;
    const list = (read || personal.models || []).filter(o => modelId(o) && !o?.disabled && !o?.unavailable);
    const want = String(hubDefault || '').toLowerCase();
    const ordered = want ? [...list].sort((a, b) => (modelId(b).toLowerCase() === want) - (modelId(a).toLowerCase() === want)) : list;
    if (ordered.length) for (const o of ordered.slice(0, 6)) options.push({ kind: 'codeagent', model: modelId(o), label: modelLabel(o), via: 'CodeAgent 账号' });
    else if (read && read.length) codeagentEmpty = true; // 读到了清单，但一个都用不了
    else options.push({ kind: 'codeagent', model: '', label: 'CodeAgent 默认模型', via: 'CodeAgent 账号' });
  }
  const gatewayTool = GATEWAY_TOOLS.find(id => installed.has(id));
  if (gateway?.keySet && gatewayTool) {
    const list = (gateway.choices && gateway.choices.length ? gateway.choices : (gateway.models || []).map(id => ({ id }))).filter(c => modelId(c));
    const ordered = [...list].sort((a, b) => (modelId(b) === gateway.model) - (modelId(a) === gateway.model));
    for (const c of ordered.slice(0, 6)) options.push({ kind: gatewayTool, model: modelId(c), label: modelId(c), via: `API key · ${KIND_LABEL[gatewayTool]}` });
  }
  if (!isCompany) for (const id of ['claude', 'codex']) if (installed.has(id)) options.push({ kind: id, model: '', label: `${KIND_LABEL[id]} 默认模型`, via: `${KIND_LABEL[id]} 自己的登录` });

  let model;
  const chosen = options.find(o => pick && o.kind === pick.kind && o.model === pick.model) || options[0] || null;
  if (checking) model = { status: 'wait', detail: '等第一步查完', fixes: [], options: [], chosen: null };
  else if (chosen) model = { status: 'ok', detail: `第一个会话用 ${chosen.via} · ${chosen.label}${options.length > 1 ? `（另有 ${options.length - 1} 个可选，点这一步可换）` : ''}`, fixes: [], options, chosen };
  else {
    const fixes = [];
    let detail;
    if (codeagentEmpty) {
      detail = 'CodeAgent 已登录，但账号里的模型现在都用不了（没权限或在避让）。可以填部门 API key，或稍后点「重新读取模型」。';
    } else if (installed.has('codeagent') && personal && personal.state !== 'ready') {
      detail = personal.state === 'expired' ? 'CodeAgent 登录已过期，重新登录一下就能用公司模型。' : 'CodeAgent 还没登录：登录后就能用公司模型。';
      fixes.push(fix('一键登录 CodeAgent', 'codeagent-login'));
    } else if (gateway?.keySet && !gatewayTool) {
      detail = 'API key 已保存，还差一个能用它的工具：装好 Claude Code 就行。';
      if (known.has('claude')) fixes.push(fix('一键安装 Claude Code', 'install', { tool: 'claude' }));
    } else if (!tools.length) {
      detail = isCompany ? '先完成第一步。也可以先填部门发的 API key，再装 Claude Code。' : '先完成第一步。';
    } else {
      detail = isCompany ? '还没有能用的模型：有 CodeAgent 账号就登录；有部门 API key 就填 key。' : '还没有能用的模型：在 CLI 里登录你的账号后点「重新检测」。';
    }
    if (isCompany && !gateway?.keySet) fixes.push(fix('用部门 API key', 'api-key'));
    if (installed.has('codeagent') && personal && personal.state === 'ready') fixes.push(fix('重新读取模型', 'recheck'));
    if (tools.length && !fixes.some(f => f.act === 'recheck')) fixes.push(fix('重新检测', 'recheck'));
    model = { status: tools.length ? 'bad' : 'wait', detail, fixes, options: [], chosen: null };
  }

  // ③ 发第一句话
  let prompt;
  if (firstPromptAt) prompt = { status: 'ok', detail: '第一句话已发出，之后在会话里接着聊就行。', fixes: [] };
  else if (model.status === 'ok') prompt = { status: 'todo', detail: `点「开始第一个会话」，选个工作文件夹后启动；输入框里已填好一句「${FIRST_PROMPT}」，按回车就发出。`, fixes: [fix('开始第一个会话', 'start')] };
  else prompt = { status: 'wait', detail: '等前两步好了再来这一步。', fixes: [] };

  const steps = [{ id: 'tool', title: '检测已装工具', ...tool }, { id: 'model', title: '选一个能用的模型', ...model }, { id: 'prompt', title: '发第一句话', ...prompt }];
  const current = steps.find(s => s.status !== 'ok')?.id || null;
  return { steps, current, done: !current };
}

// 主进程在任何一句话真正提交成功后调用（main/ipc/prompt-submit-handlers.js）；只在引导进行中、且还没记过时写一次。
let notedInProcess = false;
function notePromptSent(dataDir, now = Date.now()) {
  if (notedInProcess) return false;
  const state = readState(dataDir);
  if (!state || !state.startedAt || state.completedAt || state.dismissedAt || state.firstPromptAt) { notedInProcess = true; return false; }
  notedInProcess = writeState(dataDir, { ...state, firstPromptAt: now });
  return notedInProcess;
}
function resetForTests() { notedInProcess = false; }

module.exports = { STATE_FILE, FIRST_PROMPT, EXISTING_PREP_AGE_MS, readState, writeState, decide, computeSteps, notePromptSent, resetForTests };
