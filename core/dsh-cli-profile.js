'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The runtime is installed separately; Hub's shared node_modules stays intact.
const RUNTIME_FILES = ['@deepseek-ai/dsh/lib/bin.js', '@deepseek-harness-tui/dsh-tui/package.json'];
const TUI_PACKAGES = ['@deepseek-ai/dsh-tui', '@deepseek-harness-tui/dsh-tui'];
const DSH_REPAIR_HINT = '请点击「一键修复 DSH」：默认由 Hub 装一份自管的运行环境，按界面包要求配套 @deepseek-ai/dsh 和 @deepseek-harness-tui/dsh-tui 及同代插件，不改你的全局 npm。';
function tuiPackageAt(modules) { return TUI_PACKAGES.find(name => fs.existsSync(path.join(modules, name, 'package.json'))); }
function isRuntimeRoot(root) {
  return fs.existsSync(path.join(root, 'node_modules', RUNTIME_FILES[0])) && !!tuiPackageAt(path.join(root, 'node_modules'));
}

// 用户自己全局安装 DSH 可能落在的根目录（根目录下有 node_modules）。只读文件，不运行 npm。
function npmrcPrefix(file) {
  try {
    const m = /^\s*prefix\s*=\s*(.+?)\s*$/m.exec(fs.readFileSync(file, 'utf8'));
    return m ? m[1].replace(/^["']|["']$/g, '').replace(/\$\{([^}]+)\}/g, (_, k) => process.env[k] || '') : '';
  } catch { return ''; }
}
function userInstalledRoots(env = process.env) {
  const get = name => { const k = Object.keys(env).find(x => x.toLowerCase() === name.toLowerCase()); return k ? String(env[k] || '') : ''; };
  const roots = [];
  const home = get('USERPROFILE');
  roots.push(get('NPM_CONFIG_PREFIX'));
  if (home) roots.push(npmrcPrefix(path.join(home, '.npmrc')));
  // npm 在 Windows 上把 dsh.cmd 放在全局目录本身，模块在它下面的 node_modules。
  for (const dir of get('PATH').split(path.delimiter).map(d => d.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    if (['dsh.cmd', 'dsh.ps1', 'dsh'].some(name => fs.existsSync(path.join(dir, name)))) roots.push(dir, path.dirname(dir));
  }
  // Node 安装目录（含 nvm 各版本、CodeAgent 自带）：默认全局目录有时就是它；它自带的 npmrc 也可能写了 prefix。
  try {
    for (const dir of require('./local-node').candidateDirs(env)) {
      if (!fs.existsSync(path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node'))) continue;
      roots.push(dir, npmrcPrefix(path.join(dir, 'node_modules', 'npm', 'npmrc')));
    }
  } catch (_) {}
  const local = get('LOCALAPPDATA');
  if (local) roots.push(path.join(local, 'pnpm', 'global', '5'));
  const seen = new Set();
  return roots.filter(r => r && path.isAbsolute(r)).filter(r => { const k = path.resolve(r).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------- 分情况识别（2026-11-17）----------
// 同事反馈「装了 DSH 却显示没装」：以前只认「同一个目录里同时有核心和界面包」，只装了核心、只装了桌面版、
// 核心和界面包装在两个目录的都被判成没装，提示也不说缺什么。这里把能找到的都列出来，再给出结论：
//   ready        同一目录核心 + 界面包，同代插件齐（或 Hub 一键安装的那份）
//   split        核心在 A、界面包在 B，界面包那边同代插件齐、和核心版本配套 → Hub 在自己目录里把两边接起来
//   incomplete   核心和界面包都有，但界面包要的同代插件缺几个（启动时会报 Cannot find package）
//   mismatch     核心和界面包版本不配套（界面包声明的版本范围不含这个核心）
//   core-no-tui  只装了核心（npm i -g @deepseek-ai/dsh），缺终端界面包
//   tui-no-core  只装了界面包，缺核心
//   desktop-only 只装了 DSH 桌面版：桌面版把核心封在自己的 app.asar 里、由桌面程序自带的 Electron 运行，
//                也不带终端界面包（官方仓库 apps/desktop 的打包清单只有 dsh 与 desktop-host），Hub 借用不了
//   none         什么都没找到
// 只读文件、不起进程；体检和新建会话随时可以调。
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }
function sameDir(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
function coreAt(root) {
  const modules = path.join(root, 'node_modules');
  if (!fs.existsSync(path.join(modules, RUNTIME_FILES[0]))) return null;
  return { root, modules, entryPath: path.join(modules, RUNTIME_FILES[0]), version: readJson(path.join(modules, '@deepseek-ai/dsh/package.json'))?.version || '' };
}
function tuiAt(root) {
  const modules = path.join(root, 'node_modules');
  const name = tuiPackageAt(modules);
  if (!name) return null;
  const dir = path.join(modules, name);
  const pkg = readJson(path.join(dir, 'package.json')) || {};
  return { root, modules, name, dir, version: pkg.version || '', peers: pkg.peerDependencies || {} };
}
// Node 解析包的规矩：从包自己的真实目录往上，每层的 node_modules 里找。界面包要的同代插件必须这样能找到。
function resolveFrom(dir, name) {
  let cur = dir;
  try { cur = fs.realpathSync(dir); } catch (_) {}
  for (;;) {
    const file = path.join(cur, 'node_modules', name, 'package.json');
    if (fs.existsSync(file)) return { version: readJson(file)?.version || '' };
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}
// r23 配套规则：界面包 peerDependencies 里的 @deepseek-ai/dsh 与 @deepseek-ai/dsh-* 要和核心同代。
function peerCheck(tui, core) {
  let semver = null;
  try { semver = require('semver'); } catch (_) {}
  const fits = (v, range) => !semver || !v || !semver.valid(v) || semver.satisfies(v, String(range), { includePrerelease: true });
  const missing = [], wrong = [];
  let coreFits = true;
  for (const [name, range] of Object.entries(tui.peers || {})) {
    if (!(name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))) continue;
    if (core && core.version && !fits(core.version, range)) coreFits = false;
    if (name === '@deepseek-ai/dsh') continue;
    const hit = resolveFrom(tui.dir, name);
    if (!hit) missing.push(name);
    else if (!fits(hit.version, range)) wrong.push(`${name}@${hit.version}`);
  }
  return { missing, wrong, coreFits, ok: coreFits && !missing.length && !wrong.length };
}

// DSH 桌面版（官方 apps/desktop：productName「DeepSeek Harness」，NSIS 按用户安装、不能改目录 → %LOCALAPPDATA%\Programs\DeepSeek Harness）。
// 另两条线索：桌面版「管理 dsh 命令」注册到 PATH 的 resources\runtime\cli 下的 dsh.cmd；桌面版独占的 ~/.dsh/profiles/desktop。
function findDshDesktop(env = process.env) {
  const get = name => { const k = Object.keys(env).find(x => x.toLowerCase() === name.toLowerCase()); return k ? String(env[k] || '') : ''; };
  // 只列 resources 目录，不碰 app.asar 本身：Hub 跑在 Electron 里，它会把 .asar 当压缩包去解析。
  const isApp = dir => { try { return fs.readdirSync(path.join(dir, 'resources')).some(n => /^app\.asar$/i.test(n)); } catch { return false; } };
  const local = get('LOCALAPPDATA');
  if (local) {
    const programs = path.join(local, 'Programs');
    let names = [];
    try { names = fs.readdirSync(programs); } catch (_) {}
    const hit = names.filter(n => /deepseek|^dsh/i.test(n)).map(n => path.join(programs, n)).find(isApp);
    if (hit) return { dir: hit, via: 'programs' };
  }
  for (const dir of get('PATH').split(path.delimiter).map(d => d.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    const m = /^(.*?)[\\/]resources[\\/]runtime[\\/]cli(?:[\\/]bin)?[\\/]?$/i.exec(dir);
    if (m && ['dsh.cmd', 'dsh'].some(n => fs.existsSync(path.join(dir, n)))) return { dir: m[1], via: 'path' };
  }
  const home = get('USERPROFILE') || get('HOME');
  const dshHome = get('DSH_HOME') || (home ? path.join(home, '.dsh') : '');
  if (dshHome && fs.existsSync(path.join(dshHome, 'profiles', 'desktop', 'package.json'))) return { dir: null, via: 'profile' };
  return null;
}

// %LOCALAPPDATA%\Programs 下带 node_modules 的目录（有人把 Node 或便携 npm 装在这里）也当候选。
function programsRoots(env) {
  const k = Object.keys(env).find(x => x.toLowerCase() === 'localappdata');
  if (!k || !env[k]) return [];
  const programs = path.join(String(env[k]), 'Programs');
  let names = [];
  try { names = fs.readdirSync(programs); } catch (_) {}
  return names.map(n => path.join(programs, n)).filter(d => fs.existsSync(path.join(d, 'node_modules')));
}

function candidateRoots(env) {
  const list = [];
  const push = (root, source) => { if (root && path.isAbsolute(root) && !list.some(c => sameDir(c.root, root))) list.push({ root, source }); };
  try {
    const file = path.join(os.homedir(), '.dsh', 'hub-cli-runtime.json');
    if (fs.existsSync(file)) push(readJson(file)?.root, 'recorded');
  } catch (_) {}
  if (env.APPDATA) push(path.join(env.APPDATA, 'npm'), 'npm-global');
  for (const r of userInstalledRoots(env)) push(r, 'user');
  for (const r of programsRoots(env)) push(r, 'programs');
  return list;
}

// 一句话讲清「在哪找到了什么、缺什么」，体检、报错卡、会话错误都用它。
function describeRuntimeIssue(d) {
  const at = x => (x && x.root) || '';
  const ver = x => (x && x.version ? ' v' + x.version : '');
  const list = names => names.slice(0, 4).join('、') + (names.length > 4 ? ` 等 ${names.length} 个` : '');
  switch (d.state) {
    case 'ready': return `DSH 核心${ver(d.core)} + 终端界面包${ver(d.tui)}（${at(d.core)}）`;
    case 'split': return `DSH 核心${ver(d.core)} 在 ${at(d.core)}，终端界面包${ver(d.tui)} 在 ${at(d.tui)}，版本配套，Hub 会把两边接起来用`;
    case 'core-no-tui': return `找到了 DSH 核心${ver(d.core)}（${at(d.core)}），但缺终端界面包（TUI，@deepseek-harness-tui/dsh-tui）`;
    case 'tui-no-core': return `找到了终端界面包（TUI）${ver(d.tui)}（${at(d.tui)}），但缺 DSH 核心（@deepseek-ai/dsh）`;
    case 'desktop-only': return `找到了 DSH 桌面版${d.desktop && d.desktop.dir ? `（${d.desktop.dir}）` : ''}，但桌面版不是终端版：它的核心封在桌面程序里、也不带终端界面包（TUI），Hub 借用不了`;
    case 'mismatch': return `DSH 核心${ver(d.core)}（${at(d.core)}）和终端界面包${ver(d.tui)}（${at(d.tui)}）版本不配套${d.wrong && d.wrong.length ? `（${list(d.wrong)}）` : ''}`;
    case 'incomplete': return `DSH 核心${ver(d.core)} 和终端界面包${ver(d.tui)} 都在（${at(d.tui)}），但界面包要的同代插件缺 ${d.missing.length} 个：${list(d.missing)}`;
    case 'configured-incomplete': return d.message;
    default: return '这台电脑上没找到 DSH（npm 全局目录、PATH 上的 dsh、nvm/pnpm、%LOCALAPPDATA%\\Programs 和 Hub 一键安装的位置都看过）';
  }
}

function diagnoseDshRuntime(entry = {}, env = process.env) {
  const explicit = entry.cliRoot || env.AI_HUB_DSH_CLI_ROOT;
  const desktop = findDshDesktop(env);
  let userOwn = null;
  const result = (state, core, tui, extra = {}) => ({ state, core: core || null, tui: tui || null, desktop, missing: [], wrong: [], userRoot: userOwn ? userOwn.root : null, ...extra });
  const runtimeOf = (core, tui) => ({ root: core.root, modules: core.modules, entryPath: core.entryPath, tuiPackage: tui.name });
  let managed = null;
  try {
    const dir = require('./cli-tools/registry').managedDshRoot(env);
    const core = dir && coreAt(dir), tui = dir && tuiAt(dir);
    if (core && tui) managed = { core: { ...core, source: 'hub' }, tui: { ...tui, source: 'hub' } };
  } catch (_) {}
  if (explicit) {
    const core = path.isAbsolute(explicit) ? coreAt(explicit) : null, tui = path.isAbsolute(explicit) ? tuiAt(explicit) : null;
    if (core && tui) return result('ready', core, tui, { source: 'configured', runtime: runtimeOf(core, tui) });
    const message = `DSH CLI 终端运行环境不完整（设置里指定的目录 ${explicit} ${core ? '缺终端界面包（TUI）' : tui ? '缺 DSH 核心' : '里没有 DSH'}）`;
    // 指定目录不完整、Hub 自管的已装好：改用自管的。默认「一键补齐」只装 Hub 自管目录，装好要能立即生效（r26a 审查）。
    if (managed) return result('ready', managed.core, managed.tui, { source: 'hub', runtime: runtimeOf(managed.core, managed.tui),
      configured: explicit, configuredIssue: message });
    return result('configured-incomplete', core, tui, { source: 'configured', configured: explicit, message });
  }
  const cores = [], tuis = [];
  for (const c of candidateRoots(env)) {
    const core = coreAt(c.root), tui = tuiAt(c.root);
    if (core) cores.push({ ...core, source: c.source });
    if (tui) tuis.push({ ...tui, source: c.source });
  }
  // 用户自己装的那份（哪怕 Hub 装的排在前面）：「装到我的全局 npm」要补的就是它。
  userOwn = (cores.find(c => tuis.some(t => sameDir(t.root, c.root))) || cores[0] || tuis[0] || null);
  // 1. 用户自己装的、同一目录、齐全配套 → 直接用（用户的优先）。
  const same = cores.map(core => ({ core, tui: tuis.find(t => sameDir(t.root, core.root)) })).filter(p => p.tui);
  for (const p of same) if (peerCheck(p.tui, p.core).ok) return result('ready', p.core, p.tui, { source: p.core.source, runtime: runtimeOf(p.core, p.tui) });
  // 2. Hub 一键安装的（签名整合包）排在用户「半成品」前面：点「一键补齐」后马上能用，不被缺插件的那份挡住。
  if (managed) return result('ready', managed.core, managed.tui, { source: 'hub', runtime: runtimeOf(managed.core, managed.tui) });
  // 3. 核心在 A、界面包在 B：界面包那边同代插件齐、和 A 的核心配套，就由 Hub 接起来（见 pairedModules）。
  for (const core of cores) for (const tui of tuis) {
    if (sameDir(core.root, tui.root) || !peerCheck(tui, core).ok) continue;
    return result('split', core, tui, { source: core.source,
      runtime: { root: tui.root, modules: tui.modules, entryPath: core.entryPath, tuiPackage: tui.name, split: { coreRoot: core.root, tuiRoot: tui.root } } });
  }
  // 4. 同一目录但缺插件或不配套：照旧交给它启动（以前就是这样，有的缺了也能跑），体检和报错卡讲清缺什么、给一键补齐。
  if (same.length) {
    const p = same[0], chk = peerCheck(p.tui, p.core);
    return result(chk.coreFits && !chk.wrong.length ? 'incomplete' : 'mismatch', p.core, p.tui,
      { source: p.core.source, missing: chk.missing, wrong: chk.wrong, runtime: runtimeOf(p.core, p.tui) });
  }
  if (cores.length && tuis.length) {
    const chk = peerCheck(tuis[0], cores[0]);
    return result(chk.coreFits && !chk.wrong.length ? 'incomplete' : 'mismatch', cores[0], tuis[0], { missing: chk.missing, wrong: chk.wrong });
  }
  if (cores.length) return result('core-no-tui', cores[0], null);
  if (tuis.length) return result('tui-no-core', null, tuis[0]);
  if (desktop) return result('desktop-only', null, null);
  return result('none', null, null);
}

function resolveDshCliRuntime(entry = {}, env = process.env) {
  const d = diagnoseDshRuntime(entry, env);
  if (d.runtime) return d.runtime;
  const text = d.state === 'configured-incomplete' ? `${d.message}。${DSH_REPAIR_HINT}`
    : `请先安装 DSH CLI 终端运行环境：${describeRuntimeIssue(d)}。${DSH_REPAIR_HINT}`;
  throw Object.assign(new Error(text), { dshState: d.state });
}

// 核心在 A、界面包在 B 时，DSH 的 profile 只能链接一个 node_modules：在 Hub 自己的目录里建一个，
// 逐个包链接到 A、B 的真实位置（核心本身固定取 A；其余界面包那边优先，其次 A 顶层、A 里核心自带的依赖），不动用户的两个目录。
// 拼接目录只按「核心、界面包各自的路径和版本」取名（r26a3 复审：按整份链接清单取名时，A 或 B 里多装一个无关包就换新目录，
// 原会话 profile 还指着旧目录）。两边其余的包有增删（含 B 删包、A 补位）时，在同名目录上整体原子重建：
// 新目录先在临时名下建好、逐条核对链接，再一次改名就位。会话 profile 链接的是这个固定路径，重建后自动跟上。
// 不按时间自动清旧目录：目录很小（只有链接），而 mtime 证明不了没有会话在用（r26a3 复审：清掉后旧会话报 MODULE_NOT_FOUND）。
function pairedPlan(coreRoot, tuiRoot) {
  const plan = new Map();
  const add = (name, target) => { if (!plan.has(name) && fs.existsSync(target)) plan.set(name, target); };
  add('@deepseek-ai/dsh', path.join(coreRoot, 'node_modules', '@deepseek-ai', 'dsh'));
  for (const src of [path.join(tuiRoot, 'node_modules'), path.join(coreRoot, 'node_modules'), path.join(coreRoot, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')]) {
    let names = [];
    try { names = fs.readdirSync(src).sort(); } catch (_) { continue; }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      if (!name.startsWith('@')) { add(name, path.join(src, name)); continue; }
      let subs = [];
      try { subs = fs.readdirSync(path.join(src, name)).sort(); } catch (_) {}
      for (const sub of subs) add(`${name}/${sub}`, path.join(src, name, sub));
    }
  }
  return plan;
}
const lexists = p => { try { fs.lstatSync(p); return true; } catch (_) { return false; } };
// 只摘链接本身，绝不递归进链接指向的用户目录。
function removeLinkTree(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch (_) { return; }
  if (st.isSymbolicLink()) { try { fs.unlinkSync(dir); } catch (_) { try { fs.rmdirSync(dir); } catch (_) {} } return; }
  if (!st.isDirectory()) { try { fs.unlinkSync(dir); } catch (_) {} return; }
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) {}
  for (const name of names) removeLinkTree(path.join(dir, name));
  try { fs.rmdirSync(dir); } catch (_) {}
}
const linkKey = p => path.resolve(String(p).replace(/^\\\\\?\\/, '')).toLowerCase();
function pairedValid(modules, plan) {
  for (const [name, target] of plan) {
    const at = path.join(modules, ...name.split('/'));
    try {
      if (!fs.lstatSync(at).isSymbolicLink() || linkKey(fs.readlinkSync(at)) !== linkKey(target) || !fs.existsSync(at)) return false;
    } catch (_) { return false; }
  }
  return true;
}
function pairedModules(runtime, env = process.env) {
  if (!runtime || !runtime.split) return runtime;
  const { coreRoot, tuiRoot } = runtime.split;
  const crypto = require('node:crypto');
  const hash = (text, n) => crypto.createHash('sha256').update(text).digest('hex').slice(0, n);
  const version = file => { try { return String(JSON.parse(fs.readFileSync(file, 'utf8')).version || ''); } catch (_) { return ''; } };
  const tuiPackage = runtime.tuiPackage || '@deepseek-harness-tui/dsh-tui';
  const pairKey = hash(JSON.stringify([linkKey(coreRoot), version(path.join(coreRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')),
    linkKey(tuiRoot), tuiPackage, version(path.join(tuiRoot, 'node_modules', ...tuiPackage.split('/'), 'package.json'))]), 12);
  const plan = pairedPlan(coreRoot, tuiRoot);
  const parent = path.join(require('./cli-tools/registry').toolsRoot(env), 'dsh');
  const base = path.join(parent, `paired-${pairKey}`);
  const modules = path.join(base, 'node_modules');
  if (!pairedValid(modules, plan)) {
    const tmp = `${base}.tmp-${crypto.randomUUID().slice(0, 8)}`;
    try {
      for (const [name, target] of plan) {
        const at = path.join(tmp, 'node_modules', ...name.split('/'));
        fs.mkdirSync(path.dirname(at), { recursive: true });
        fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
      }
      if (!pairedValid(path.join(tmp, 'node_modules'), plan)) throw new Error(`DSH 分装拼接目录没有建好（${tmp}）`);
      let aside = null;
      if (lexists(base)) { aside = `${base}.old-${crypto.randomUUID().slice(0, 8)}`; fs.renameSync(base, aside); }
      try { fs.renameSync(tmp, base); }
      catch (error) {
        // 另一个会话同时建好了同一份：直接用它的。
        if (!pairedValid(modules, plan)) { if (aside && !lexists(base)) { try { fs.renameSync(aside, base); aside = null; } catch (_) {} } throw error; }
      }
      if (aside) removeLinkTree(aside);
    } finally { removeLinkTree(tmp); }
  }
  return { ...runtime, root: base, modules, entryPath: path.join(coreRoot, 'node_modules', RUNTIME_FILES[0]) };
}

function buildDshCliOptions(kind, opts, config, dataDir, env) {
  const runtime = pairedModules(resolveDshCliRuntime(config.acp?.providers?.['deepseek-acp'], env), env);
  const acp = config.acp || {};
  return require('./acp-profiles').buildAcpOptions(kind, { ...opts, dshCliRuntime: runtime }, {
    ...config, acp: { ...acp, providers: { ...acp.providers,
      'deepseek-acp': { ...acp.providers?.['deepseek-acp'], entryPath: runtime.entryPath } } },
  }, dataDir, env);
}
module.exports = { resolveDshCliRuntime, diagnoseDshRuntime, describeRuntimeIssue, findDshDesktop, pairedModules, buildDshCliOptions, userInstalledRoots, tuiPackageAt, DSH_REPAIR_HINT };
