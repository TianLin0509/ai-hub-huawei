'use strict';
// Claude Code、DSH 的卡片运行方式（2026-11-22 第二个试点）：
//   pty  —— 现有方式，一直开着真实终端，出厂默认；
// 只开放给公司版经本机反代的两条线路（CodeAgent 账号、API 网关）；其他线路继续用真实终端。
// 组队、群聊、助理和其他自动会话一律走 PTY。
const { createHash } = require('node:crypto');
const { EXCLUDED_PURPOSES } = require('./codeagent-run-mode');

const PTY = 'pty';
const CARD = 'card';
const KINDS = ['claude', 'deepseek-acp'];
const baseKind = kind => String(kind || '').replace(/-resume$/, '');
const normalizeCardMode = value => (value === CARD ? CARD : PTY);
const supportsCardKind = kind => KINDS.includes(baseKind(kind));

function routeAllowed(kind, config = {}, opts = {}) {
  if (!config.companyCli || opts.cliApiProfileId) return false;
  const base = baseKind(kind);
  if (base === 'claude') return config.claudeBackend === 'proxy';
  if (base === 'deepseek-acp') return config.dshBackend === 'proxy';
  return false;
}

// 这个会话是否属于卡片试点（不论此刻在卡片还是在终端）。
function isCardSession(kind, opts = {}, config = {}) {
  if (!supportsCardKind(kind) || normalizeCardMode(opts.cardRunMode) !== CARD) return false;
  if (opts.resumePicker || opts.useContinue || opts.meetingId || opts.teamId || opts.teamRole) return false;
  if (EXCLUDED_PURPOSES.has(opts.purpose)) return false;
  if (String(kind).endsWith('-resume') && !opts.resumeCCSessionId && !opts.acpSid) return false;
  return routeAllowed(kind, config, opts);
}

const usesCardDriver = (kind, opts = {}, config = {}) => isCardSession(kind, opts, config) && opts.cardTerminal !== true;

// DSH 的共享进程和真实终端要读同一份会话记录，所以按「线路 + 模型 + 固定的号」分目录，一个会话终身不变。
function dshCardScope(config = {}, opts = {}) {
  const parts = [config.dshBackend || '', config.dshUpstream || '', opts.model || config.dshApiModel || '', opts.companyProxyAccount || ''];
  // 权限模式是共享进程的启动参数（DSH_PERMISSION_MODE），不同档不能共用一个进程；完全放开不进 parts，老会话的目录不变。
  const permission = require('./permission-modes').normalize('deepseek-acp', opts.permissionMode);
  if (permission && permission !== 'bypassPermissions') parts.push('permission:' + permission);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

function claudeCardLaunch(env, locator = require('./harness-locator')) {
  const launch = locator.launchSpec('claude', { env });
  if (!launch?.command || launch.shell || launch.pending) throw new Error('没有找到能直接启动的 Claude Code，请在启动中心改回「终端」方式或修复安装');
  return { executable: launch.command, commandArgs: launch.args || [] };
}

function withCardModeInJson(raw, kind, mode) {
  const runtime = raw && typeof raw.runtime === 'object' && !Array.isArray(raw.runtime) ? raw.runtime : {};
  const current = runtime.cardRunModes && typeof runtime.cardRunModes === 'object' ? runtime.cardRunModes : {};
  return { ...raw, runtime: { ...runtime, cardRunModes: { ...current, [baseKind(kind)]: normalizeCardMode(mode) } } };
}

function cardModesFrom(value) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(KINDS.map(kind => [kind, normalizeCardMode(source[kind])]));
}

module.exports = { PTY, CARD, KINDS, baseKind, normalizeCardMode, supportsCardKind, routeAllowed, isCardSession, usesCardDriver,
  dshCardScope, claudeCardLaunch, withCardModeInJson, cardModesFrom };
