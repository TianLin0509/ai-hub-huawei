'use strict';
// 分层查找的「去哪找」（定位中心）：按顺序给出要看的位置，每个位置带来源和一句人话标签，诊断轨迹照这个顺序列。
// 只拼路径、列目录，不起进程；注册表里最新的 PATH、CodeAgent 的安装记录这类要起进程才能读的，由调用方先读好放进 ctx（见 locator.js）。
//
// 位置有三种：
//   file  一个具体文件（手动指定、环境变量覆盖）
//   dir   放命令的目录：在里面按命令名 + PATHEXT（和 .ps1）找
//   root  npm 一类的全局目录：在它的 node_modules 里按包名找，读包的 bin（没有命令壳时也认得出）
const path = require('node:path');
const { envGet } = require('./specs');

const SOURCE_LABELS = Object.freeze({
  manual: '你手动指定的位置',
  'env-override': '环境变量指定的位置',
  setting: 'Hub 设置里指定的位置',
  path: 'Hub 进程的 PATH',
  'registry-path': '注册表里最新的 PATH（装完没重启 Hub 也认得）',
  'dsh-desktop': 'DSH 桌面版自带命令',
  'npm-prefix': 'npm 全局目录',
  'npmrc-prefix': 'npm 全局目录（.npmrc 里的 prefix）',
  pnpm: 'pnpm 全局目录',
  volta: 'volta 管理的命令',
  nvm: 'nvm 管理的 Node 目录',
  fnm: 'fnm 管理的 Node 目录',
  official: '官方安装器的默认位置',
  'hub-managed': 'Hub 一键安装的',
  'app-paths': '注册表 App Paths',
  'uninstall-key': '注册表卸载项（安装记录）',
  'known-dir': '常见安装目录',
});

// 设置路径 'acp.providers.deepseek-acp.cliRoot' → config 里的值（只取字符串）。
function settingValue(config, key) {
  const v = String(key).split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), config || {});
  return typeof v === 'string' ? v : '';
}
// 测试实例（tests/helpers/hub-launcher 起的隔离 Hub：CLAUDE_HUB_E2E_FAKE_HOME=1 或带 CLAUDE_HUB_E2E_WINDOW_MODE）不看真机（2026-11-21）：
// 不读注册表；已知安装目录、Node 管理器这类机器级位置只认落在（假）用户目录和 Hub 工具目录里的。
// 进程 PATH、显式配置、手动路径、Hub 自管照常——它们都由测试自己给。正式启动的 Hub 没有这两个标记，行为不变。
function isTestInstance(env) { return envGet(env, 'CLAUDE_HUB_E2E_FAKE_HOME') === '1' || !!envGet(env, 'CLAUDE_HUB_E2E_WINDOW_MODE'); }
const TEST_OPEN_SOURCES = new Set(['manual', 'env-override', 'setting', 'path', 'hub-managed', 'pinned', 'configured', 'shim']);
function insideTestHome(env, p) {
  if (!p) return false;
  const k = path.resolve(p).toLowerCase();
  return [envGet(env, 'USERPROFILE'), envGet(env, 'CLAUDE_HUB_HOME_DIR'), envGet(env, 'AI_HUB_CLI_TOOLS_DIR')].filter(Boolean)
    .map(r => path.resolve(r).toLowerCase()).some(r => k === r || k.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}
function testInstanceAllows(env, source, p) { return TEST_OPEN_SOURCES.has(source) || insideTestHome(env, p); }
function exists(fsImpl, p) { try { fsImpl.statSync(p); return true; } catch { return false; } }
function unquote(p) { return String(p || '').trim().replace(/^"|"$/g, ''); }
function pathDirs(env) { return envGet(env, 'PATH').split(path.delimiter).map(unquote).filter(Boolean); }
function sameKey(p, platform) { const r = path.resolve(p); return platform === 'win32' ? r.toLowerCase() : r; }

function readText(fsImpl, file) { try { return fsImpl.readFileSync(file, 'utf8'); } catch { return ''; } }
function subdirs(fsImpl, dir) {
  try { return fsImpl.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
}
function isDir(fsImpl, dir) { try { return fsImpl.statSync(dir).isDirectory(); } catch { return false; } }
function mtime(fsImpl, p) { try { return fsImpl.statSync(p).mtimeMs || 0; } catch { return 0; } }
// 版本号大的排前面（v24.12.0 先于 v22.11.0）。
function byVersionDesc(a, b) {
  const v = s => (String(s).match(/\d+/g) || []).map(Number);
  const x = v(a), y = v(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
  return 0;
}

// .npmrc 里的 prefix（展开 ${VAR} 和 %VAR%）。
function npmrcPrefix(fsImpl, file, env) {
  const m = /^\s*prefix\s*=\s*(.+?)\s*$/m.exec(readText(fsImpl, file));
  if (!m) return '';
  return unquote(m[1].replace(/^'|'$/g, '')).replace(/\$\{([^}]+)\}|%([^%]+)%/g, (_, a, b) => envGet(env, a || b));
}

// npm / pnpm / volta / nvm / fnm 的全局目录。返回 [{ path, source, note }]，按优先级。
function nodeManagerPlaces(ctx) {
  const { env, fs: fsImpl } = ctx;
  const out = [];
  const add = (p, source, note = '') => { if (p) out.push({ path: p, source, note }); };
  const appData = envGet(env, 'APPDATA'), local = envGet(env, 'LOCALAPPDATA'), home = envGet(env, 'USERPROFILE') || envGet(env, 'HOME');
  add(envGet(env, 'NPM_CONFIG_PREFIX') || envGet(env, 'npm_config_prefix'), 'npm-prefix', '环境变量 NPM_CONFIG_PREFIX');
  for (const rc of [home && path.join(home, '.npmrc'), appData && path.join(appData, 'npm', 'etc', 'npmrc')]) {
    if (rc) add(npmrcPrefix(fsImpl, rc, env), 'npmrc-prefix', rc);
  }
  add(appData && path.join(appData, 'npm'), 'npm-prefix', 'npm 默认全局目录');
  add(envGet(env, 'PNPM_HOME'), 'pnpm', '环境变量 PNPM_HOME');
  add(local && path.join(local, 'pnpm'), 'pnpm', 'pnpm 默认目录');
  const volta = envGet(env, 'VOLTA_HOME') || (local && path.join(local, 'Volta'));
  add(volta && path.join(volta, 'bin'), 'volta');
  add(envGet(env, 'NVM_SYMLINK'), 'nvm', '环境变量 NVM_SYMLINK（当前启用的版本）');
  const nvmHome = envGet(env, 'NVM_HOME') || (appData && path.join(appData, 'nvm'));
  if (nvmHome) for (const name of subdirs(fsImpl, nvmHome).filter(n => /^v\d/i.test(n)).sort(byVersionDesc)) add(path.join(nvmHome, name), 'nvm');
  const fnmDir = envGet(env, 'FNM_DIR') || (appData && path.join(appData, 'fnm'));
  add(envGet(env, 'FNM_MULTISHELL_PATH'), 'fnm', '环境变量 FNM_MULTISHELL_PATH（当前终端启用的版本）');
  if (fnmDir) {
    const versions = path.join(fnmDir, 'node-versions');
    for (const name of subdirs(fsImpl, versions).filter(n => /^v\d/i.test(n)).sort(byVersionDesc)) add(path.join(versions, name, 'installation'), 'fnm');
    add(path.join(fnmDir, 'aliases', 'default'), 'fnm', 'fnm 默认版本');
  }
  // 去重：同一个目录只留第一次出现的（来源取优先的那个）。
  const seen = new Set();
  return out.filter(p => { const k = sameKey(p.path, ctx.platform); if (seen.has(k)) return false; seen.add(k); return true; });
}

// DSH 桌面版自己生成的命令目录（以 multica 源码 internal/daemon/config.go 为准）：
//   %APPDATA%\DSH Desktop\host-commands\<profile>\generations\<id>\bin\dsh.{exe,cmd,bat}   优先（确认能跑：设好 DSH_HOME、按绝对路径调桌面程序）
//   %APPDATA%\DSH Desktop\cli\<id>\bin\…，以及 cli\bin                                    其次（个别版本的命令壳指向的东西不在，跑出 9009）
// 同一层里各 profile 的各代合在一起按修改时间新的在前。
function dshDesktopDirs(ctx) {
  const { env, fs: fsImpl } = ctx;
  const appData = envGet(env, 'APPDATA') || ((envGet(env, 'USERPROFILE')) && path.join(envGet(env, 'USERPROFILE'), 'AppData', 'Roaming'));
  if (!appData) return [];
  const out = [];
  // 两条血统（公司 CodeAgent 读源码所得，2026-11-20，Q-1120-19）：
  //   anywhere-labs/dsh-desktop（DSH Desktop 2.0.x，根目录 DSH Desktop；DSH NEXT 同结构，根目录 DSH NEXT），命令都是 dsh.cmd、不进 PATH；
  //   上游 apps/desktop 壳（内源 OpenX 0.2.x「DeepSeek Harness」）：安装目录下 resources/runtime/cli/bin/dsh.cmd。
  for (const app of ['DSH Desktop', 'DSH NEXT']) {
  const root = path.join(appData, app);
  const before = out.length;
  const binDirsIn = base => {
    const dirs = [];
    for (const name of subdirs(fsImpl, base)) {
      if (name === 'bin') continue;
      const bin = path.join(base, name, 'bin');
      if (isDir(fsImpl, bin)) dirs.push({ path: bin, name, at: mtime(fsImpl, path.join(base, name)) });
    }
    if (isDir(fsImpl, path.join(base, 'bin'))) dirs.push({ path: path.join(base, 'bin'), name: '', at: 0 });
    return dirs;
  };
  const sort = dirs => dirs.sort((a, b) => (b.at - a.at) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const host = [];
  for (const profile of subdirs(fsImpl, path.join(root, 'host-commands'))) {
    const generations = path.join(root, 'host-commands', profile, 'generations');
    if (isDir(fsImpl, generations)) host.push(...binDirsIn(generations));
  }
  for (const d of sort(host)) out.push({ path: d.path, source: 'dsh-desktop', note: app + ' host-commands' });
  for (const d of sort(binDirsIn(path.join(root, 'cli')))) out.push({ path: d.path, source: 'dsh-desktop', note: app + ' cli 目录' });
  if (out.length === before && app === 'DSH Desktop') out.push({ path: path.join(root, 'host-commands'), source: 'dsh-desktop', note: '桌面版 host-commands', empty: true });
  }
  const local = envGet(env, 'LOCALAPPDATA');
  if (local) {
    const programs = path.join(local, 'Programs');
    for (const name of subdirs(fsImpl, programs).filter(n => /deepseek|^dsh/i.test(n))) {
      const bin = path.join(programs, name, 'resources', 'runtime', 'cli', 'bin');
      if (isDir(fsImpl, bin)) out.push({ path: bin, source: 'dsh-desktop', note: name + ' 安装目录' });
    }
  }
  return out;
}

// CodeAgent 的注册表安装记录、App Paths 和常见安装目录（安装记录由调用方异步读好放进 ctx.codeagentInstalls）。
function codeagentDirs(ctx) {
  const { env, fs: fsImpl } = ctx;
  const out = [];
  for (const rec of ctx.codeagentInstalls || []) {
    const dir = typeof rec === 'string' ? rec : rec.dir;
    if (!dir) continue;
    const source = typeof rec === 'string' ? 'uninstall-key' : rec.source || 'uninstall-key';
    out.push({ path: dir, source }, { path: path.join(dir, 'bin'), source });
  }
  for (const base of [envGet(env, 'LOCALAPPDATA') && path.join(envGet(env, 'LOCALAPPDATA'), 'Programs'), envGet(env, 'LOCALAPPDATA'), envGet(env, 'ProgramFiles'), envGet(env, 'ProgramFiles(x86)')].filter(Boolean)) {
    for (const name of subdirs(fsImpl, base)) if (/code\s*-?agent/i.test(name)) out.push({ path: path.join(base, name), source: 'known-dir' }, { path: path.join(base, name, 'bin'), source: 'known-dir' });
  }
  return out;
}

// 一个 CLI 的全部查找位置，按查找顺序。manual：state.json 里存的手动路径。
function placesFor(spec, ctx) {
  const { env, platform } = ctx;
  const places = [];
  const add = (kind, p, source, extra = {}) => { if (p) places.push({ kind, path: p, source, label: extra.label || SOURCE_LABELS[source] || source, ...extra }); };
  // 1. 手动路径和环境变量覆盖。有它们时只认它们（指定的不能用就如实报，不悄悄换成别的程序）。
  // 手动路径独占：试跑只看它一份，环境变量指定的也不掺进来（否则手选的 A 不行、环境变量的 B 能用，会把 A 当成通过保存下来）。
  if (ctx.manual) { add('file', ctx.manual, 'manual', { exclusive: true }); return places; }
  // 显式配置（环境变量、Hub 设置里的路径，2026-11-21 接回改版前认的那些）：按表里的顺序，第一个有值的生效，只认它。
  // kind：file 一个程序文件；dir 放命令的目录；root npm 一类的全局目录（在它的 node_modules 里按包名找，DSH 的 cliRoot）；
  //       command 命令名或完整路径。ifMissing: 'skip'：指定的完整路径已经不在时当没指定（CodeAgent 原来就是这样，2026-11-07）。
  //       hubFallback：指定的不能用时允许改用 Hub 一键安装的那份（DSH 原来就是这样，「一键补齐」装好要立即生效），结论里写明。
  for (const o of spec.envOverrides || []) {
    const value = unquote(o.setting ? settingValue(ctx.config, o.setting) : envGet(env, o.name));
    if (!value) continue;
    const label = o.label || (o.setting ? `Hub 设置里指定的位置（${o.setting}）` : `环境变量 ${o.name}`);
    const source = o.setting ? 'setting' : 'env-override';
    const extra = { label, exclusive: true, explicit: o.setting || o.name, ...(o.hubFallback ? { hubFallback: true } : {}) };
    if (o.kind === 'command' && !path.isAbsolute(value)) { ctx.commandOverride = value; break; }
    if (o.ifMissing === 'skip' && !exists(ctx.fs, value)) continue;
    add(o.kind === 'dir' || o.kind === 'root' ? o.kind : 'file', value, source, extra);
    break;
  }
  // 2. 进程 PATH，再加注册表里最新的用户 / 系统 PATH（只加进程 PATH 里没有的）。
  const seenDirs = new Set();
  if (spec.npmFirst && envGet(env, 'APPDATA')) add('dir', path.join(envGet(env, 'APPDATA'), 'npm'), 'npm-prefix', { note: 'npm 默认全局目录' });
  for (const dir of pathDirs(env)) { const k = sameKey(dir, platform); if (!seenDirs.has(k)) { seenDirs.add(k); add('dir', dir, 'path', { group: 'path' }); } }
  for (const dir of ctx.registryDirs || []) { const k = sameKey(dir, platform); if (!seenDirs.has(k)) { seenDirs.add(k); add('dir', dir, 'registry-path', { group: 'registry-path' }); } }
  // 3. 已知安装形态。
  if ((spec.extra || []).includes('dsh-desktop')) for (const d of dshDesktopDirs(ctx)) add('dir', d.path, d.source, { note: d.note, empty: d.empty });
  for (const dir of spec.official ? spec.official(env) : []) add('dir', dir, 'official');
  if ((spec.extra || []).includes('codeagent-installs')) for (const d of codeagentDirs(ctx)) add('dir', d.path, d.source);
  if (!spec.isNode) for (const p of nodeManagerPlaces(ctx)) {
    add('dir', p.path, p.source, { note: p.note });
    // pnpm 的包装在 <PNPM_HOME>\global\5 下；npm / nvm / fnm 的包装在目录自己的 node_modules 下。
    if (spec.packages) add('root', p.source === 'pnpm' ? path.join(p.path, 'global', '5') : p.path, p.source, { note: p.note });
  }
  // 4. Hub 自管（<数据目录>/tools/installed.json）。
  if (spec.hub && ctx.hubManaged) {
    const m = ctx.hubManaged(spec.hub);
    if (m) {
      if (m.bin) add('file', m.bin, 'hub-managed', { version: m.version });
      else if (spec.packages) add('root', m.dir, 'hub-managed', { version: m.version });
    } else places.push({ kind: 'none', path: '', source: 'hub-managed', label: SOURCE_LABELS['hub-managed'] });
  }
  if (isTestInstance(env)) for (let i = places.length - 1; i >= 0; i--) if (places[i].kind !== 'none' && !testInstanceAllows(env, places[i].source, places[i].path)) places.splice(i, 1);
  // 有手动 / 显式配置时只看它们（允许 Hub 兜底的，再带上 Hub 一键安装的那份）。
  const exclusive = places.filter(p => p.exclusive);
  if (!exclusive.length) return places;
  return exclusive.some(p => p.hubFallback) ? places.filter(p => p.exclusive || p.source === 'hub-managed') : exclusive;
}

module.exports = { isTestInstance, testInstanceAllows, placesFor, settingValue, nodeManagerPlaces, dshDesktopDirs, codeagentDirs, pathDirs, npmrcPrefix, byVersionDesc, SOURCE_LABELS, unquote };
