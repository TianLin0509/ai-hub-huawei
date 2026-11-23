'use strict';
// AI 市场下载的 MCP：清单与 Hub 自己的开关。
// 2026-11-24 公司真机核对：CodeAgent 从 AI 市场装的 MCP 登记在 <配置目录>/inner-installed.json 的 mcpServers
//   （名字 → { disabled, installedAt, version }，同一文件还记插件与技能）；启动方式写进用户级 .cac.json 的 mcpServers，
//   程序下载到 CodeAgent 安装目录。市场条目上的 disabled 并不阻止 CLI 加载（真机上标 disabled 的照样连接）。
// 开关只存 Hub 数据目录里的一份设置；新建或重启会话时按设置临时注入（--disabled-mcp-servers 与成员 MCP 清单过滤），
// 从不改写用户自己的 CLI 配置文件。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REGISTRY_FILE = 'inner-installed.json';
const SETTINGS_FILE = 'codeagent-market-mcp.json';
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
// CodeAgent 的 --disabled-mcp-servers 收一个逗号分隔的值，名字里不能有逗号或空白。
const validName = name => typeof name === 'string' && /^[\w.@:-]{1,120}$/.test(name);

function readJson(file, fsModule = fs, maxBytes = MAX_REGISTRY_BYTES) {
  const stat = fsModule.statSync(file);
  if (stat.size > maxBytes) throw Error(`文件超过 ${Math.round(maxBytes / 1048576)} MB，未读取`);
  const data = JSON.parse(fsModule.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('JSON 格式无效');
  return data;
}

// 读一个 CodeAgent 配置目录里 AI 市场登记的 MCP。没有登记文件返回空表。
function readMarketMcpRegistry(configDir, { fsModule = fs } = {}) {
  const file = path.join(configDir || '', REGISTRY_FILE);
  if (!configDir) return { file, rows: [] };
  let data;
  try { data = readJson(file, fsModule); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { file, rows: [] };
    return { file, rows: [], error: error instanceof SyntaxError ? 'JSON 格式无效' : error.message };
  }
  const servers = data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers) ? data.mcpServers : {};
  const rows = [];
  for (const [name, item] of Object.entries(servers)) {
    if (!validName(name)) continue;
    const info = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    rows.push({ name, marketDisabled: info.disabled === true,
      version: typeof info.version === 'string' ? info.version.slice(0, 80) : '',
      installedAt: typeof info.installedAt === 'string' ? info.installedAt.slice(0, 40) : '' });
  }
  return { file, rows };
}

const settingsPath = hubDataDir => path.join(hubDataDir, SETTINGS_FILE);
// 设置文件还没有 = 全部开启；读不了（损坏、无权限、超限）时带上 error，调用方要让用户看见，不当成空设置悄悄放行。
function loadSettings(hubDataDir, { fsModule = fs } = {}) {
  if (!hubDataDir) return { disabled: [] };
  const file = settingsPath(hubDataDir);
  try {
    const data = readJson(file, fsModule, 256 * 1024);
    if ('disabled' in data && !Array.isArray(data.disabled)) throw Error('disabled 不是列表');
    return { disabled: [...new Set((data.disabled || []).filter(validName))].sort() };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { disabled: [] };
    const why = error instanceof SyntaxError ? 'JSON 格式损坏' : ['EACCES', 'EPERM'].includes(error.code) ? '没有读取权限' : error.message;
    return { disabled: [], error: `AI 市场 MCP 开关设置读不了（${why}）：${file}` };
  }
}
function setMarketMcpEnabled(hubDataDir, name, enabled, { fsModule = fs } = {}) {
  if (!hubDataDir) throw Error('Hub 数据目录不可用');
  if (!validName(name)) throw Error('MCP 名称无效，请刷新后重试');
  if (typeof enabled !== 'boolean') throw Error('请选择开启或关闭');
  const loaded = loadSettings(hubDataDir, { fsModule });
  // 读不了的设置不覆盖：用户修好或删掉这个文件之前，开关不写。
  if (loaded.error) throw Error(loaded.error + '；修好或删掉这个文件后再开关');
  const current = new Set(loaded.disabled);
  if (enabled) current.delete(name); else current.add(name);
  const disabled = [...current].sort();
  const file = settingsPath(hubDataDir), tmp = file + '.' + process.pid + '-' + crypto.randomUUID() + '.tmp';
  fsModule.mkdirSync(hubDataDir, { recursive: true });
  try {
    fsModule.writeFileSync(tmp, JSON.stringify({ disabled, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
    fsModule.renameSync(tmp, file);
  } finally { try { fsModule.unlinkSync(tmp); } catch { /* 已改名 */ } }
  return { name, enabled, disabled };
}
// 当前 CodeAgent 认不认 --disabled-mcp-servers：按本机 --help 缓存判断（true / false / null=还没读到）。
// 旧版不认时开关无效：资源页置灰，会话里提示已关的仍会加载。
function disableFlagSupport(command) {
  const caps = require('./codeagent-capabilities');
  const help = command ? caps.readHelp(command) : '';
  return help ? caps.flagListed(help, '--disabled-mcp-servers') : null;
}
// 会话启动时的一行提示（没问题返回空串）。
function launchNotice({ error, hubOff = [], flagSupported = true } = {}) {
  if (error) return error + '；这次按全部开启启动。';
  if (hubOff.length && flagSupported === false) return `当前 CodeAgent 版本不支持在 Hub 里关闭 MCP，已关的 ${hubOff.join('、')} 仍会加载；升级 CodeAgent 后可用。`;
  return '';
}

// 把多处要禁用的名字合成一个 --disabled-mcp-servers（CLI 只认一个逗号分隔的值）。
function mergeDisabledArg(args, names) {
  const list = [...new Set(names.filter(validName))];
  if (!list.length) return args;
  args.push('--disabled-mcp-servers', list.join(','));
  return args;
}

// 资源页：给目录行标上 Hub 开关状态（只看来自 AI 市场的 MCP）。
// toggle：{ supported, reason }，旧版 CodeAgent 或设置读不了时开关置灰并写明原因。
function decorateCatalogRows(rows, hubDataDir, { flagSupported = null, ...options } = {}) {
  const loaded = loadSettings(hubDataDir, options), off = new Set(loaded.disabled);
  const reason = loaded.error || (flagSupported === false ? '当前 CodeAgent 版本不支持在 Hub 里关闭，升级后可用' : '');
  return (rows || []).map(row => {
    if (row.type !== 'mcp' || !row.sources?.some(s => s.market === 'aimarket')) return row;
    return { ...row, market: 'aimarket', hubEnabled: !off.has(row.name), hubToggle: { supported: !reason, reason } };
  });
}

module.exports = { REGISTRY_FILE, SETTINGS_FILE, validName, readMarketMcpRegistry, loadSettings, setMarketMcpEnabled,
  disableFlagSupport, launchNotice, mergeDisabledArg, decorateCatalogRows };
