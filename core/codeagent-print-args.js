'use strict';
// 后台 CodeAgent 单次纯文字问答（-p / --print）的精简参数（2026-11-23 黄区实测 Probe 7B E4）。
// 现状（起名同款参数）一次拉起 36 个子进程、峰值约 2.1 GB，18 秒超时挂死；
// 加 --bare --strict-mcp-config --mcp-config <空配置> --tools "" 后走原账号登录照常回答，子进程 36 → 3、峰值少约 0.75 GB、10.6 秒干净退出。
// 只用于不需要工具、不需要插件、不需要会话记录的问答（起名、进度卡代写、答疑等）；带 --resume 的不用。
// 旧版 CodeAgent 不认 --bare 时，调用方看 isUnknownBareError 去掉 --bare 重试一次（不让旧版用户坏掉）。
const fs = require('fs');
const os = require('os');
const path = require('path');

const EMPTY_MCP = JSON.stringify({ mcpServers: {} }) + '\n';

// 固定一份空 MCP 配置（内容不变不重写）；写不出来返回 ''，调用方就不带 --mcp-config。
function emptyMcpConfigFile(dir = path.join(os.tmpdir(), 'ai-hub-codeagent-print'), fsModule = fs) {
  const file = path.join(dir, 'empty-mcp.json');
  try {
    fsModule.mkdirSync(dir, { recursive: true });
    let same = false; try { same = fsModule.readFileSync(file, 'utf8') === EMPTY_MCP; } catch { /* 还没有 */ }
    if (!same) fsModule.writeFileSync(file, EMPTY_MCP, 'utf8');
    return file;
  } catch { return ''; }
}

// 精简参数。help：--help 的输出（给了就只加里面出现的参数；不给表示调用方自己会做「不认 --bare 就重试」）。
// bare=false 时不加 --bare（重试用）。
function leanPrintArgs({ help = null, bare = true, mcpConfigFile = emptyMcpConfigFile() } = {}) {
  const has = flag => help == null || String(help).includes(flag);
  const out = [];
  if (bare && has('--bare')) out.push('--bare');
  if (has('--strict-mcp-config')) {
    out.push('--strict-mcp-config');
    if (mcpConfigFile && has('--mcp-config')) out.push('--mcp-config', mcpConfigFile);
  }
  if (has('--tools')) out.push('--tools', '');
  return out;
}

// 旧版不认 --bare 的报错（commander 风格：unknown option '--bare'；也兼容 Unknown option: --bare）。
function isUnknownBareError(text) {
  return /unknown option[^\n]{0,8}--bare|unrecognized[^\n]{0,20}--bare/i.test(String(text || ''));
}

// 旧版不认任意精简参数（--bare / --strict-mcp-config / --mcp-config / --tools）时的报错。
function isUnknownLeanOptionError(text) {
  return /(?:unknown option|unrecognized[^\n]{0,20})[^\n]{0,12}--(?:bare|strict-mcp-config|mcp-config|tools)\b/i.test(String(text || ''));
}

module.exports = { emptyMcpConfigFile, leanPrintArgs, isUnknownBareError, isUnknownLeanOptionError, EMPTY_MCP };
