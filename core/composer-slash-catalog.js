'use strict';
// 输入框「/」选择框的清单（2026-11-20）：按会话所用的 AI 列出它真正会加载的命令和技能。
// CodeAgent 另有读屏探测的老路径（composer-codeagent-skills.js + codeagent:skills），这里不管。
// 只读本会话会加载的目录（所用账号 / 隔离目录 + 当前项目），不把别的账号、别的 AI 的技能混进来。
// 各家目录的出处：Claude Code 账号目录 skills/commands/plugins；Codex CODEX_HOME + ~/.agents；
// DSH（@deepseek-ai/dsh-skill-filesystem 0.2.x）项目 .dsh/.agents + 隔离 home 的 .dsh/.agents；
// pi（@earendil-works/pi-coding-agent 1.5 docs/configuration.md、skills.md）~/.pi/agent + 项目 .pi + .agents。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { skillEntries } = require('./capability-catalog');

const NAME = /^[\p{L}\p{N}_.:-]+$/u;
const cmd = (name, description, extra = {}) => ({ name, description, ...extra });
const T = { terminal: true };

// 内置命令：读不到运行中的菜单，按各家文档维护；只列在 Hub 里用得上的（会话、账号由 Hub 菜单管理的不列）。
const CLAUDE_COMMANDS = [
  cmd('compact', '压缩上下文，保留摘要继续对话', { argumentHint: '[保留要点]' }), cmd('clear', '清空对话历史，开始新话题'),
  cmd('context', '查看上下文占用'), cmd('cost', '查看本会话花费与用时'), cmd('usage', '查看套餐用量', T),
  cmd('model', '切换模型', T), cmd('review', '审查当前分支改动', { argumentHint: '[要求]' }), cmd('security-review', '安全审查当前改动'),
  cmd('init', '为项目生成 CLAUDE.md'), cmd('memory', '编辑记忆文件', T), cmd('agents', '管理子代理', T),
  cmd('mcp', '查看和管理 MCP 服务器', T), cmd('hooks', '查看钩子配置', T), cmd('permissions', '查看和修改权限规则', T),
  cmd('plugin', '管理插件', T), cmd('config', '打开设置', T), cmd('status', '版本、账号、模型状态', T),
  cmd('rewind', '回退到之前的检查点', T), cmd('export', '导出当前对话'), cmd('add-dir', '添加额外工作目录', { argumentHint: '<路径>' }),
  cmd('todos', '查看待办列表'), cmd('doctor', '检查安装与配置'), cmd('help', '查看帮助'),
];
// Hub 原生 Codex 支持的命令（与 codex-native-commands.js 的 HELP 对齐）。
const CODEX_NATIVE_COMMANDS = [
  cmd('model', '查看或切换模型', { argumentHint: '[模型]' }), cmd('plan', '先出计划再执行', { argumentHint: '[任务] | off' }),
  cmd('goal', '设置或查看长期目标', { argumentHint: '[目标] | pause | resume | clear' }), cmd('review', '审查当前改动', { argumentHint: '[要求]' }),
  cmd('compact', '压缩上下文'), cmd('status', '会话、模型与额度状态'), cmd('context', '查看上下文占用'), cmd('usage', '查看额度用量'),
  cmd('diff', '查看工作区改动'), cmd('mcp', '列出 MCP 服务器'), cmd('skills', '列出已安装技能'), cmd('hooks', '查看钩子'),
  cmd('plugins', '查看插件'), cmd('rename', '重命名会话', { argumentHint: '<名称>' }), cmd('ps', '查看后台进程'),
  cmd('init', '生成 AGENTS.md'), cmd('help', '查看 Hub 支持的命令'),
];
// Codex 终端界面（TUI）的命令。
const CODEX_TUI_COMMANDS = [
  cmd('model', '切换模型与推理强度', T), cmd('permissions', '调整审批与沙箱', T), cmd('review', '审查当前改动', T),
  cmd('compact', '压缩上下文'), cmd('diff', '查看工作区改动'), cmd('status', '会话、模型与额度状态'), cmd('init', '生成 AGENTS.md'),
  cmd('mcp', '列出 MCP 工具'), cmd('skills', '浏览已安装技能', T), cmd('mention', '引用文件', T), cmd('plan', '先出计划再执行'),
  cmd('goal', '设置或查看长期目标', { argumentHint: '[目标]' }), cmd('rename', '重命名会话'), cmd('ps', '查看后台进程'),
];
// DSH 终端界面（dsh-tui guide/interaction.md「Slash Commands」）。
const DSH_TUI_COMMANDS = [
  cmd('compact', '压缩上下文'), cmd('clear', '清空对话'), cmd('context', '查看上下文占用'), cmd('status', '会话与模型状态'),
  cmd('cost', '查看花费'), cmd('model', '切换模型', T), cmd('effort', '调整推理强度', T), cmd('init', '生成项目说明'),
  cmd('plan', '先出计划再执行'), cmd('goal', '设置或查看长期目标'), cmd('btw', '不打断主线的侧问'), cmd('recap', '最近活动摘要'),
  cmd('rewind', '时间回溯', T), cmd('export', '导出会话'), cmd('skills', '浏览已发现的技能', T), cmd('agents', '管理子代理', T),
  cmd('mcp', '管理 MCP 服务器', T), cmd('hooks', '查看钩子', T), cmd('jobs', '后台任务面板', T), cmd('trace', '轨迹视图', T),
  cmd('settings', '插件设置', T), cmd('rename', '重命名会话'), cmd('doctor', '检查运行环境'), cmd('help', '查看帮助'),
];
// DSH 原生（ACP）模式下 Hub 自己处理的命令（acp-session.js）。
const DSH_HUB_COMMANDS = [cmd('model', '查看或切换套餐模型', { argumentHint: '[模型]' }), cmd('quota', '查看套餐额度与兜底状态'),
  cmd('status', '会话与模型状态'), cmd('help', '列出原生命令')];
// pi（docs/slash-commands.md）。
const PI_COMMANDS = [
  cmd('model', '切换模型', { argumentHint: '[provider/model]' }), cmd('thinking', '设置思考强度', { argumentHint: '[等级]' }),
  cmd('compact', '压缩上下文', { argumentHint: '[指令]' }), cmd('session', '会话信息与统计'), cmd('name', '设置会话名称', { argumentHint: '[名称]' }),
  cmd('tree', '浏览会话分支树', T), cmd('fork', '从之前的消息分叉', T), cmd('clone', '复制当前会话'), cmd('copy', '复制最后一条回答'),
  cmd('export', '导出会话为 HTML 或 JSONL', { argumentHint: '[路径]' }), cmd('settings', '打开设置', T), cmd('mcp', '管理 MCP 服务器', T),
  cmd('reload', '重新加载技能、模板和扩展'), cmd('hotkeys', '查看快捷键'), cmd('changelog', '查看更新记录'),
];

const family = require('./composer-slash-family').slashFamily;

function createReader(fsModule = fs) {
  const warnings = [];
  const entries = dir => {
    try { return fsModule.readdirSync(dir, { withFileTypes: true }).filter(e => !e.name.startsWith('.')); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) warnings.push(`${dir}：${error.message}`); return []; }
  };
  const text = file => {
    try {
      if (fsModule.statSync(file).size > 2 * 1024 * 1024) { warnings.push(`${file}：超过 2 MB，未读取`); return null; }
      return fsModule.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) warnings.push(`${file}：${error.message}`); return null; }
  };
  const exists = file => { try { return fsModule.existsSync(file); } catch { return false; } };
  const json = file => { const raw = text(file); if (raw === null) return {}; try { const d = JSON.parse(raw); return d && typeof d === 'object' ? d : {}; } catch { warnings.push(`${file}：JSON 格式无效`); return {}; } };
  // <root>/<技能>/SKILL.md，以及多套一层的 <root>/<分组>/<技能>/SKILL.md。
  const skills = root => {
    const found = skillEntries(root, { entries, text, warning: m => warnings.push(m) });
    for (const entry of entries(root)) {
      const dir = path.join(root, entry.name);
      if ((entry.isDirectory() || entry.isSymbolicLink()) && !exists(path.join(dir, 'SKILL.md'))) found.push(...skillEntries(dir, { entries, text, warning: m => warnings.push(m) }));
    }
    return found;
  };
  // <root>/**/*.md 命令或提示词模板；子目录名作为命名空间（Claude Code 的写法 dir:name）。
  const markdown = (root, depth = 1, prefix = '') => {
    const out = [];
    for (const entry of entries(root)) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory() && depth > 0) out.push(...markdown(file, depth - 1, prefix + entry.name + ':'));
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        const raw = text(file); if (raw === null) continue;
        const front = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
        const field = name => front?.[1].match(new RegExp('^' + name + ':\\s*(.+)$', 'm'))?.[1].trim().replace(/^(['"])(.*)\1$/, '$2') || '';
        const body = front ? raw.slice(front[0].length) : raw;
        const firstLine = body.split(/\r?\n/).map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
        out.push({ name: prefix + entry.name.replace(/\.md$/i, ''), description: field('description') || firstLine.slice(0, 160), argumentHint: field('argument-hint') });
      }
    }
    return out;
  };
  return { warnings, entries, text, json, exists, skills, markdown };
}

function projectRoot(cwd, exists) {
  if (!cwd) return '';
  let dir = path.resolve(cwd);
  for (;;) {
    if (exists(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}
// 从 cwd 往上到仓库根（含）的每一层；pi 的项目 .agents/skills 按这个范围找。
function ancestorsToRoot(cwd, root) {
  if (!cwd) return [];
  const out = []; let dir = path.resolve(cwd);
  for (;;) { out.push(dir); if (dir === root) return out; const parent = path.dirname(dir); if (parent === dir) return out; dir = parent; }
}

function catalogFor(session, { homeDir = os.homedir(), dataDir = '', env = process.env, fsModule = fs, acpCommands = null } = {}) {
  const fam = family(session);
  if (!fam) return { ok: false, reason: 'unsupported' };
  const r = createReader(fsModule);
  const cwd = session.cwd || '';
  const items = [], seen = new Set();
  const add = (group, row, insert, source, extra = {}) => {
    if (!row?.name || !NAME.test(row.name) || seen.has(insert.toLowerCase())) return;
    seen.add(insert.toLowerCase());
    items.push({ group, name: row.name, insert, description: String(row.description || '').slice(0, 300),
      ...(row.argumentHint ? { argumentHint: String(row.argumentHint).slice(0, 80) } : {}), source, ...extra });
  };
  const addCommands = list => list.forEach(c => add('command', c, '/' + c.name, '内置', c.terminal ? { terminal: true } : {}));
  // Claude Code 的 user-invocable: false 技能只给模型自动用，用户敲不出来，不列。
  const addSkills = (root, source, insert) => { for (const s of r.skills(root)) if (!(fam === 'claude' && /^false$/i.test(s.userInvocable || ''))) add('skill', s, insert(s.name), source); };
  const native = !!session.runtimeBackend && session.agentRuntime !== 'pty';
  let label, sourceNote;

  if (fam === 'claude') {
    label = 'Claude Code';
    const configDir = session.claudeConfigDir || env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');
    addCommands(CLAUDE_COMMANDS);
    const slash = name => '/' + name;
    addSkills(path.join(configDir, 'skills'), '个人', slash);
    if (cwd) addSkills(path.join(cwd, '.claude', 'skills'), '项目', slash);
    // 已启用插件的技能与命令，调用名带插件前缀（plugin:name）。
    // 插件开关按 Claude Code 的设置优先级合并：用户 → 项目 → 项目本地（后者覆盖前者）。
    const pluginSwitches = file => { const v = r.json(file).enabledPlugins; return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
    const enabled = { ...pluginSwitches(path.join(configDir, 'settings.json')),
      ...(cwd ? pluginSwitches(path.join(cwd, '.claude', 'settings.json')) : {}), ...(cwd ? pluginSwitches(path.join(cwd, '.claude', 'settings.local.json')) : {}) };
    const installed = r.json(path.join(configDir, 'plugins', 'installed_plugins.json')).plugins || {};
    for (const [id, on] of Object.entries(enabled)) {
      if (on !== true) continue;
      const installs = Array.isArray(installed[id]) ? installed[id] : [];
      const rows = installs.filter(s => s && typeof s === 'object');
      const root = (rows.find(s => s.scope === 'user') || rows[0])?.installPath;
      if (typeof root !== 'string' || !r.exists(root)) continue;
      const plugin = id.split('@')[0];
      addSkills(path.join(root, 'skills'), '插件 · ' + plugin, name => '/' + plugin + ':' + name);
      for (const c of r.markdown(path.join(root, 'commands'))) add('other', c, '/' + plugin + ':' + c.name, '插件 · ' + plugin);
    }
    for (const c of r.markdown(path.join(configDir, 'commands'))) add('other', c, '/' + c.name, '个人 · 命令');
    if (cwd) for (const c of r.markdown(path.join(cwd, '.claude', 'commands'))) add('other', c, '/' + c.name, '项目 · 命令');
    sourceNote = '账号目录与项目 .claude';
  } else if (fam === 'codex') {
    label = /^deepseek/.test(session.kind) ? 'DeepSeek · Codex' : 'Codex';
    // 运行目录优先（换号会话的 CLI 实际跑在这里），其次是历史目录所在的 CODEX_HOME。
    const codexHome = session.codexRuntimeHome || (session.codexSessionsRoot ? path.dirname(session.codexSessionsRoot) : env.CODEX_HOME || path.join(homeDir, '.codex'));
    addCommands(native ? CODEX_NATIVE_COMMANDS : CODEX_TUI_COMMANDS);
    // Hub 原生 Codex 把 /技能名 换成技能调用；终端界面里技能用 $技能名 提及。
    const insert = native ? name => '/' + name : name => '$' + name;
    // Codex 从当前目录往上到仓库根，每层的 .agents/skills 都算项目技能。
    for (const dir of ancestorsToRoot(cwd, projectRoot(cwd, r.exists))) addSkills(path.join(dir, '.agents', 'skills'), '项目', insert);
    addSkills(path.join(codexHome, 'skills'), '个人', insert);
    addSkills(path.join(homeDir, '.agents', 'skills'), '个人 · 共享', insert);
    addSkills(path.join(codexHome, 'skills', '.system'), '系统', insert);
    if (!native) for (const c of r.markdown(path.join(codexHome, 'prompts'), 0)) add('other', c, '/prompts:' + c.name, '提示词模板');
    sourceNote = native ? 'Hub 原生 Codex · 技能目录' : 'Codex 终端 · 技能目录';
  } else if (fam === 'dsh') {
    label = 'DSH';
    const slash = name => '/' + name;
    if (session.runtimeBackend === 'acp') {
      addCommands(DSH_HUB_COMMANDS);
      for (const c of Array.isArray(acpCommands) ? acpCommands : []) add('command', { name: c?.name, description: c?.description,
        argumentHint: c?.input?.hint }, '/' + c?.name, '运行时上报');
      sourceNote = acpCommands ? 'DSH 运行时上报' : 'DSH 尚未上报命令';
    } else {
      addCommands(DSH_TUI_COMMANDS);
      sourceNote = 'DSH 终端 · 技能目录';
    }
    // DSH 在 Hub 里跑在隔离 home（acp-profiles.js：<数据目录>/acp/<会话 id 摘要>/home）。
    const root = projectRoot(cwd, r.exists);
    if (root) { addSkills(path.join(root, '.dsh', 'skills'), '项目', slash); addSkills(path.join(root, '.agents', 'skills'), '项目', slash); }
    if (dataDir && session.id) {
      const home = path.join(dataDir, 'acp', createHash('sha256').update(session.id).digest('hex'), 'home');
      addSkills(path.join(home, '.dsh', 'skills'), '个人', slash);
      addSkills(path.join(home, '.agents', 'skills'), '个人', slash);
    }
  } else {
    label = 'pi';
    const agentDir = env.PI_CODING_AGENT_DIR || path.join(homeDir, '.pi', 'agent');
    addCommands(PI_COMMANDS);
    const insert = name => '/skill:' + name;
    if (cwd) addSkills(path.join(cwd, '.pi', 'skills'), '项目', insert);
    const root = projectRoot(cwd, r.exists);
    for (const dir of ancestorsToRoot(cwd, root)) addSkills(path.join(dir, '.agents', 'skills'), '项目', insert);
    addSkills(path.join(agentDir, 'skills'), '个人', insert);
    addSkills(path.join(homeDir, '.agents', 'skills'), '个人 · 共享', insert);
    if (cwd) for (const c of r.markdown(path.join(cwd, '.pi', 'prompts'), 0)) add('other', c, '/' + c.name, '项目 · 模板');
    for (const c of r.markdown(path.join(agentDir, 'prompts'), 0)) add('other', c, '/' + c.name, '提示词模板');
    sourceNote = 'pi 目录与项目 .pi';
  }
  return { ok: true, family: fam, label, sourceNote, items, warnings: [...new Set(r.warnings)].slice(0, 20) };
}

module.exports = { catalogFor, family, CLAUDE_COMMANDS, CODEX_NATIVE_COMMANDS, CODEX_TUI_COMMANDS, DSH_TUI_COMMANDS, DSH_HUB_COMMANDS, PI_COMMANDS };
