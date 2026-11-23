'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runSkillCommand, shortReason, validSkillId } = require('./codeagent-skill-install');
const TYPES = { skill: 'skill', skills: 'skill', plugin: 'plugin', plugins: 'plugin', mcp: 'mcp', mcps: 'mcp' };
const MAX_MARKET_BYTES = 8 * 1024 * 1024;
const MAX_MARKET_ITEMS = 5000;
const text = (value, limit = 2000) => typeof value === 'string' ? value.slice(0, limit) : '';

function parseMarketplace(data) {
  if (typeof data === 'string') {
    try { data = JSON.parse(data.replace(/^\uFEFF/, '')); }
    catch { throw Object.assign(Error('本机 AI 市场清单格式无效，请在 CodeAgent 中更新市场后重试'), { code: 'MARKET_JSON_INVALID' }); }
  }
  const rows = new Map();
  // 条目没写作者时用市场顶层 owner（真机清单只在顶层写 owner）。
  const owner = data && typeof data === 'object' && !Array.isArray(data) ? (text(data.owner, 160) || text(data.owner?.name, 160)) : '';
  let count = 0;
  function add(item, fallback) {
    if (++count > MAX_MARKET_ITEMS) throw Error('本机 AI 市场清单超过 5000 条，未展示不完整列表；请在 CodeAgent 中更新或缩小市场副本后刷新');
    if (!item || typeof item !== 'object') return;
    const kind = item.type ?? item.kind ?? fallback;
    if (typeof kind !== 'string' || !Object.hasOwn(TYPES, kind)) return;
    const type = TYPES[kind];
    const name = text(item.name, 250) || text(item.id, 250);
    // 安装标识不能截断后执行，过长时直接忽略无效条目。
    const installId = typeof item.id === 'string' && item.id ? item.id : item.name;
    if (typeof installId !== 'string' || installId.length > 250) return;
    if (!type || !validSkillId(installId) || !name) return;
    const id = type + ':' + installId;
    const author = text(item.author, 160) || text(item.author?.name, 160) || owner;
    rows.set(id, { id, installId, name, type, version: text(item.version, 80),
      description: text(item.description) || text(item.summary), author });
  }
  if (Array.isArray(data)) data.forEach(item => add(item));
  else if (data && typeof data === 'object') {
    for (const [key, fallback] of Object.entries(TYPES)) if (Array.isArray(data[key])) data[key].forEach(item => add(item, fallback));
    if (Array.isArray(data.items)) data.items.forEach(item => add(item));
    if (Array.isArray(data.entries)) data.entries.forEach(item => add(item));
  } else throw Error('本机 AI 市场清单格式无效，请在 CodeAgent 中更新市场后重试');
  return [...rows.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, 'zh-CN'));
}

async function readMarketplace(configDir, { fsModule = fs } = {}) {
  const root = path.join(configDir, 'plugins', 'marketplaces', 'aimarket');
  let invalidJson;
  for (const relative of ['.cac-plugin/marketplace.json', 'marketplace.json', '.claude-plugin/marketplace.json']) {
    try {
      const file = path.join(root, relative), stat = await fsModule.stat(file);
      if (stat.size > MAX_MARKET_BYTES) throw Error('本机 AI 市场清单超过 8 MB，未读取；请在 CodeAgent 中更新或缩小市场副本后刷新');
      return parseMarketplace(await fsModule.readFile(file, 'utf8'));
    }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
      if (error.code === 'MARKET_JSON_INVALID') { invalidJson = error; continue; }
      if (error.code === 'EACCES' || error.code === 'EPERM') throw Error('无法读取本机 AI 市场副本，请检查 CodeAgent 目录的读取权限');
      throw error;
    }
  }
  if (invalidJson) throw invalidJson;
  throw Error('本机还没有 AI 市场副本，先在 CodeAgent 里运行一次 /plugin 或更新 CodeAgent，再点刷新');
}

function isMarketInstalled(item, rows, configDir) {
  const aliases = new Set([item.name, item.installId, item.installId.replace(/@[^@]+$/, '')]);
  if (item.type === 'plugin') {
    aliases.add(item.installId + '@aimarket');
    aliases.add(item.installId.replace(/@[^@]+$/, '') + '@aimarket');
  }
  return rows.some(row => row.type === item.type && aliases.has(row.name) && row.sources?.some(source => {
    if (source.agent !== 'codeagent' || source.scope !== 'user' || source.missing || !source.path) return false;
    // 单独的启用开关可能是卸载后残留，插件要读到落地目录才显示已安装。
    if (item.type === 'plugin' && path.basename(source.path) === 'settings.json') return false;
    const rel = path.relative(configDir, source.path);
    const inside = rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
    const siblingState = path.basename(configDir).toLowerCase() === '.cac' && path.resolve(source.path) === path.join(path.dirname(path.resolve(configDir)), '.cac.json');
    return inside || siblingState;
  }));
}

function installArgs(item) {
  if (!validSkillId(item.installId)) throw Error('市场条目的安装标识无效，请刷新市场');
  if (item.type === 'skill') return ['skills', 'add', item.installId, '--scope', 'global'];
  if (item.type === 'plugin') return ['plugin', 'install', item.installId + '@aimarket', '--scope', 'user'];
  if (item.type === 'mcp') return ['mcp', 'add', item.installId, '--scope', 'user'];
  throw Error('这个市场条目暂不支持安装');
}

function installByIdArgs(type, id) {
  if (!validSkillId(id) || id.length > 250) throw Error('ID 只允许字母、数字和 . _ - @，可填写 ID@版本，最长 250 字符');
  if (type === 'skill') return ['skills', 'add', id, '--scope', 'global'];
  if (type === 'mcp') return ['mcp', 'add', id, '--scope', 'user'];
  if (type === 'plugin') return ['plugin', 'add', id];
  if (type === 'agent') return ['agents', 'add', id];
  if (type === 'command') return ['command', 'add', id];
  throw Error('请选择技能、MCP、插件、Agent 或命令');
}

function launchMarketCommand(command, args, options, { platform = process.platform, spawnImpl = spawn } = {}) {
  // Windows 的 CodeAgent 是 bat/cmd 包装器，参数必须先按允许的命令逐项核验。
  const kinds = { skills: 'skill', plugin: 'plugin', mcp: 'mcp', agents: 'agent', command: 'command' };
  const type = typeof args[0] === 'string' && Object.hasOwn(kinds, args[0]) ? kinds[args[0]] : null;
  if (!type) throw Error('不允许的市场安装参数');
  const allowed = [installByIdArgs(type, args[2])];
  if (type === 'plugin' && args[1] === 'install') allowed.push(installArgs({ type, installId: args[2]?.replace(/@aimarket$/, '') }));
  if (!allowed.some(value => JSON.stringify(args) === JSON.stringify(value))) throw Error('不允许的市场安装参数');
  if (typeof command !== 'string' || !command || /[\r\n"`$;&|<>%!?^]/.test(command)) throw Error('CodeAgent 命令路径无效');
  if (platform !== 'win32') return spawnImpl(command, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const head = /^[A-Za-z0-9_.-]+$/.test(command) ? command : '"' + path.normalize(command) + '"';
  return spawnImpl('cmd.exe', ['/d', '/s', '/c', '"call ' + head + ' ' + args.join(' ') + '"'], {
    ...options, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function installFailure(error) {
  if (error.timedOut) return '安装超时，已请求停止后台安装；请检查公司网络后重试';
  if (error.code === 'ENOENT') return '找不到 CodeAgent，请安装或更新 CodeAgent 后刷新';
  const reason = shortReason(error.message);
  if (/auth|login|unauthorized|401|403|登录|鉴权/i.test(reason)) return 'CodeAgent 市场需要登录或授权，请先在 CodeAgent 完成登录后重试';
  if (/ENOTFOUND|ECONN|network|proxy|网络/i.test(reason)) return '公司内网连接失败，请接入公司网络后重试';
  return '安装失败：' + (reason || 'CodeAgent 未返回原因，请更新 CodeAgent 后重试');
}

class CodeAgentMarket {
  constructor({ config, available, catalog, invalidate, env = process.env, run = runSkillCommand }) {
    Object.assign(this, { config, available, catalog, invalidate, env, run });
    this.busy = false;
  }
  status() {
    try { return { available: this.available() === true }; }
    catch { return { available: false }; }
  }
  async list() {
    if (!this.status().available) return { available: false, rows: [], reason: '此环境未安装 CodeAgent，或当前发行版不支持公司 AI 市场' };
    try {
      const config = this.config(), items = await readMarketplace(config.configDir), catalog = await this.catalog();
      return { available: true, rows: items.map(item => ({ ...item, installed: isMarketInstalled(item, catalog.rows, config.configDir) })),
        reason: '' };
    } catch (error) { return { available: true, rows: [], reason: error.message }; }
  }
  async install(id) {
    if (typeof id !== 'string') throw Error('请选择市场条目');
    return this.installItem(async config => {
      const items = await readMarketplace(config.configDir), item = items.find(row => row.id === id);
      if (!item) throw Error('市场条目已变化，请刷新后重试');
      return item;
    }, installArgs);
  }
  async installById({ type, id } = {}) {
    const args = installByIdArgs(type, id);
    return this.installItem(async () => ({ type, id: type + ':' + id, name: id.split('@')[0], installId: id, versionRequested: id.includes('@') }), () => args);
  }
  // 清单安装和按 ID 安装共用同一个安装锁及执行闭环。
  async installItem(findItem, makeArgs) {
    if (!this.available()) throw Error('当前环境无法使用公司 AI 市场，请先安装 CodeAgent');
    if (this.busy) throw Error('另一个条目正在安装，请等它结束后重试');
    this.busy = true;
    try {
      const config = this.config(), item = await findItem(config);
      const catalog = await this.catalog();
      // 显式指定版本时必须交给 CLI 处理，不能因为已有同名条目而跳过。
      if (!item.versionRequested && isMarketInstalled(item, catalog.rows, config.configDir)) return { installed: true, alreadyInstalled: true };
      const env = { ...this.env, [config.configDirEnv]: config.configDir };
      // 不继承父会话的 hook 回调，避免安装过程误报当前会话状态。
      for (const key of Object.keys(env)) if (/^CLAUDE_HUB_(?:SESSION_ID|PORT|TOKEN)$|^CODEAGENT_HUB_/.test(key)) delete env[key];
      require('./codeagent-launch-env').applyAccountEnv(env, config);
      // 尚未生成本机市场副本时也能安装；只准备 CLI 自己的配置目录。
      await fs.mkdir(config.configDir, { recursive: true });
      try { await this.run(config.command, makeArgs(item), { cwd: config.configDir, env, windowsHide: true }, { launch: launchMarketCommand }); }
      catch (error) { throw Error(installFailure(error)); }
      this.invalidate();
      const updated = await this.catalog();
      const installed = isMarketInstalled(item, updated.rows, config.configDir);
      return { installed, message: installed ? '已安装，新开 CodeAgent 会话即可使用' : 'CodeAgent 已完成安装，暂未读到安装记录；请刷新，或在 CodeAgent 中核对安装位置' };
    } finally { this.busy = false; }
  }
}
module.exports = { MAX_MARKET_BYTES, MAX_MARKET_ITEMS, parseMarketplace, readMarketplace, isMarketInstalled, installArgs, installByIdArgs, launchMarketCommand, installFailure, CodeAgentMarket };
