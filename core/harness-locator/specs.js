'use strict';
// 定位中心的声明式表（2026-11-20，HUB-H 第一期 A 线）：每种 CLI 一行。加一种新 CLI 只在这里加一行，不改查找代码。
//
// 字段：
//   commands      命令名（按 PATHEXT 和 .ps1 在各目录里找），排前的优先
//   packages      提供这个命令的 npm 包（没有命令壳时直接在 npm 全局目录的 node_modules 里找；读 package.json 的 bin，不写死目录布局）
//   bin           包里 bin 字段的键，缺省取 commands[0]
//   envOverrides  显式配置：{ name（环境变量）| setting（Hub 设置路径）, kind: 'file' | 'dir' | 'root' | 'command', ifMissing?, hubFallback? }；
//                 按顺序第一个有值的生效、只认它（指向的不在就如实报，不退回别处；细节见 sources.js placesFor）
//   nodeSetting   Hub 设置里给这个 CLI 指定 Node 的路径（DSH 的 nodePath）：有值时试跑和建会话都只用它
//   minVersion    CLI 自身最低版本（低于判「版本太低」）
//   nodeMin       命令是 JS 脚本时最少要的 Node；包的 engines.node 更严时以包为准
//   probeArgs     试跑参数：和启动用同一条命令，只多这几个参数
//   official      官方安装器的默认目录（env → 目录数组）
//   extra         特殊的已知安装形态，由 sources.js 按名字展开：'dsh-desktop'、'codeagent-installs'
//   hub           Hub 一键安装的组件 id（core/cli-tools/registry.js），排在最后兜底
//   hook          启动形态的特殊处理（launch.js）：'codex'（npm 包里换成自带的原生程序）、'dsh'（检查终端界面包）
//   versionParser 读版本的特殊解析（verdict.js）：'codeagent'
//   npmFirst      %APPDATA%\npm 排在 PATH 前面（Codex 一直是这个顺序，保持不变）
//   prefer        'newest'：能用的有好几份时取版本最高的（CodeAgent 原来的多版本规则）
const path = require('node:path');

const envGet = (env, name) => { const k = Object.keys(env || {}).find(x => x.toLowerCase() === name.toLowerCase()); return k ? String(env[k] || '').trim() : ''; };
const join = (base, ...rest) => base ? path.join(base, ...rest) : '';
const home = env => envGet(env, 'USERPROFILE') || envGet(env, 'HOME');
// Antigravity 原来认的主目录（core/antigravity-config.js 的 home()）：没有 LOCALAPPDATA 时 agy 在 <它>\AppData\Local\agy\bin。
const agyHome = env => envGet(env, 'AI_HUB_ANTIGRAVITY_HOME') || envGet(env, 'CLAUDE_HUB_HOME_DIR') || home(env);

// install：没装 / 装坏时给的安装按钮（沿用体检现有的 act）；company 为公司版专用（启动中心的一键安装）。
const SPECS = [
  { id: 'claude', label: 'Claude Code', commands: ['claude'], packages: ['@anthropic-ai/claude-code'],
    envOverrides: [{ name: 'AI_HUB_CLAUDE_PATH', kind: 'file' }], nodeMin: '18.0.0', probeArgs: ['--version'],
    official: env => [join(home(env), '.local', 'bin')], hub: 'claude',
    install: { label: '打开安装说明', act: 'open-url', url: 'https://code.claude.com/docs/en/setup' }, companyInstall: { label: '去一键安装', act: 'open-cli-install' } },
  { id: 'codex', label: 'Codex', commands: ['codex'], packages: ['@openai/codex'],
    envOverrides: [{ name: 'AI_HUB_CODEX_PATH', kind: 'file' }, { name: 'CODEX_INSTALL_DIR', kind: 'dir' }], nodeMin: '16.0.0', probeArgs: ['--version'],
    official: env => [join(envGet(env, 'LOCALAPPDATA'), 'Programs', 'OpenAI', 'Codex', 'bin')], hub: 'codex', hook: 'codex', npmFirst: true,
    install: { label: '打开安装说明', act: 'open-url', url: 'https://developers.openai.com/codex/cli/' }, companyInstall: { label: '去一键安装', act: 'open-cli-install' } },
  { id: 'codeagent', label: 'CodeAgent', commands: ['codeagent', 'cac', 'codeagentcli'],
    envOverrides: [{ name: 'AI_HUB_CODEAGENT_COMMAND', kind: 'command', ifMissing: 'skip' }, { setting: 'providers.codeagent.command', kind: 'command', ifMissing: 'skip', label: 'Hub 设置里指定的 CodeAgent 命令' }], probeArgs: ['--version'],
    extra: ['codeagent-installs'], versionParser: 'codeagent', prefer: 'newest',
    install: { label: '打开 CodeAgent 设置', act: 'open-codeagent' } },
  { id: 'dsh', label: 'DSH', commands: ['dsh'], packages: ['@deepseek-ai/dsh'], bin: 'dsh',
    envOverrides: [{ setting: 'acp.providers.deepseek-acp.cliRoot', kind: 'root', hubFallback: true, label: 'Hub 设置里指定的 DSH 目录（cliRoot）' },
      { name: 'AI_HUB_DSH_CLI_ROOT', kind: 'root', hubFallback: true }, { name: 'AI_HUB_DSH_PATH', kind: 'file' }],
    nodeSetting: 'acp.providers.deepseek-acp.nodePath', nodeMin: '22.0.0', probeArgs: ['--version'],
    extra: ['dsh-desktop'], hub: 'dsh', hook: 'dsh',
    install: { label: '一键安装 DSH 终端版', act: 'dsh-install' }, repair: { label: '一键补齐（Hub 自管）', act: 'harness-repair' } },
  { id: 'pi', label: 'pi', commands: ['pi'], packages: ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'],
    envOverrides: [{ name: 'AI_HUB_PI_PATH', kind: 'file' }], nodeMin: '22.19.0', probeArgs: ['--version'], hub: 'pi', hook: 'pi',
    install: { label: '一键安装 pi', act: 'pi-install' } },
  { id: 'gemini', label: 'Gemini CLI', commands: ['gemini'], packages: ['@google/gemini-cli'],
    envOverrides: [{ name: 'AI_HUB_GEMINI_PATH', kind: 'file' }], nodeMin: '20.0.0', probeArgs: ['--version'],
    install: { label: '打开安装说明', act: 'open-url', url: 'https://github.com/google-gemini/gemini-cli' } },
  { id: 'kimi', label: 'Kimi Code', commands: ['kimi'],
    envOverrides: [{ name: 'AI_HUB_KIMI_PATH', kind: 'file' }], probeArgs: ['--version'],
    official: env => [join(home(env), '.local', 'bin')],
    install: { label: '打开安装说明', act: 'open-url', url: 'https://github.com/MoonshotAI/kimi-cli' } },
  { id: 'antigravity', label: 'Antigravity', commands: ['agy'],
    envOverrides: [{ name: 'AI_HUB_ANTIGRAVITY_COMMAND', kind: 'command' }], probeArgs: ['--version'],
    official: env => [join(envGet(env, 'LOCALAPPDATA') || join(agyHome(env), 'AppData', 'Local'), 'agy', 'bin'), 'D:\\DevTools\\AntigravityCLI\\bin'] },
  { id: 'node', label: 'Node.js', commands: ['node'], probeArgs: ['--version'], isNode: true, hub: 'node',
    install: { label: '打开下载页', act: 'open-url', url: 'https://nodejs.org/zh-cn/download' } },
];

const IDS = SPECS.map(s => s.id);
const byId = new Map(SPECS.map(s => [s.id, s]));
function spec(id) {
  const s = byId.get(String(id || ''));
  if (!s) throw Object.assign(new Error('不认识的 CLI：' + id), { code: 'HARNESS_UNKNOWN' });
  return s;
}

module.exports = { SPECS, IDS, spec, envGet };
