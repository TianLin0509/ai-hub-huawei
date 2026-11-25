'use strict';
// 定位中心（2026-11-20，HUB-H 第一期 A 线）：各 CLI 唯一的查找入口。体检、启动中心徽标、建会话、账号页、模型反代都拿这里的同一份结论和同一条启动命令。
//
// 一次查找 = 分层找候选（sources.js）→ 解析命令壳（shim.js）→ 给 JS 入口挑 Node（node-pick.js）→ 拼启动命令（launch.js）
//          → 用这条命令加 --version 试跑（runner.js）→ 五种结论（verdict.js）→ 选一个（choose）。
// 缓存与刷新：
//   peek          同步只读缓存（重启后读 state.json 里上次的结论），启动 1 秒内给界面；
//   locate        2 分钟内复用缓存，fresh 时重查；同一 CLI 同时只查一次；
//   2 分钟轮询    只 stat 选中的路径、按已知 PATH 看有没有新出现的，不起进程；选中的路径没了就重查（自愈）；
//   10 分钟复查   重新试跑读版本；
//   装完          调用方 locate(id, { fresh: true, reason: 'install' })。
// 结论变了就回调 onChange 的监听者（主进程转发成 harness:changed）。
const fsDefault = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SPECS, IDS, spec: specOf } = require('./specs');
const { placesFor, SOURCE_LABELS, pathDirs, settingValue } = require('./sources');
const { resolveFile, packageEntry } = require('./shim');
const { nodeCandidates, pickNode, requiredNode, parseNodeVersion } = require('./node-pick');
const { buildLaunch, probeEnv, companions, skipsNode } = require('./launch');
const { classify, fixes: fixesFor, RANK, minVersionFor, defaultParse } = require('./verdict');
const runner = require('./runner');
const { sanitizeText } = require('./sanitize');

const CACHE_TTL_MS = 2 * 60 * 1000;
const POLL_MS = 2 * 60 * 1000;
const VERSION_RECHECK_MS = 10 * 60 * 1000;
const MAX_VERIFY = 6;
// 每次查都会变、不影响结论的字段：只有它们变了时定时复查不重写 state.json。
const VOLATILE_KEYS = new Set(['checkedAt', 'durationMs', 'verifyMs', 'verifiedAt', 'reasonTrigger', 'at', 'ms']);
// 定时复查沿用上次试跑结论的最长时间：超过就真跑一次 --version。
const REUSE_VERIFY_MS = 60 * 60 * 1000;
// 低开销模式开着时定时轮询、复查放慢 4 倍（core/optional-features.js slowedMs）；单测和脚本里没登记模式，按原节奏。
const slowed = ms => { try { return require('../optional-features').slowedMs(ms); } catch { return ms; } };

function isFile(fsImpl, f) { try { return fsImpl.statSync(f).isFile(); } catch { return false; } }
function keyOf(p, platform, fsImpl) {
  let r = path.resolve(String(p || ''));
  try { r = (fsImpl.realpathSync.native || fsImpl.realpathSync)(r); } catch { /* 不存在的按字面 */ }
  return platform === 'win32' ? r.toLowerCase() : r;
}
function pathExts(env, platform) {
  if (platform !== 'win32') return [''];
  const key = Object.keys(env).find(k => k.toLowerCase() === 'pathext');
  const list = String((key && env[key]) || '.COM;.EXE;.BAT;.CMD').split(';').map(s => s.trim().toLowerCase()).filter(e => /^\.\w+$/.test(e));
  // .js/.vbs 这类关联扩展名双击能开，但 Hub 不能当程序起；只认能直接运行的那几种，.ps1 放最后（只在没有别的壳时用）。
  return [...new Set(list.filter(e => ['.com', '.exe', '.bat', '.cmd'].includes(e)).concat(['.exe', '.cmd', '.bat']))].concat(['.ps1']);
}

class HarnessLocator {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.platform = options.platform || process.platform;
    this.fs = options.fs || fsDefault;
    this.dataDir = options.dataDir || null;
    this.now = options.now || Date.now;
    this.isCompany = options.isCompany || (() => { try { return require('../company-api-config').isCompany(); } catch { return false; } });
    this.run = options.run || (spec => runner.spawnOnce(spec));
    this.limit = runner.createLimiter(options.concurrency || 4);
    this.sleep = options.sleep;
    // Hub 自带的运行时文件所在目录（core/）；安装版在 app.asar 里，交给系统 Node 前经 unpackedPath 换到 app.asar.unpacked。测试可注入。
    this.runtimeDir = options.runtimeDir || path.join(__dirname, '..');
    // 测试实例（sources.js isTestInstance）不读真机注册表：PATH 和 CodeAgent 安装记录都当没有。
    const testInstance = require('./sources').isTestInstance(this.env);
    this.readRegistryPath = options.readRegistryPath || (testInstance ? async () => [] : () => require('../tool-discovery/npm-global-dirs').registryPathDirs({ env: this.env, platform: this.platform }));
    this.readCodeagentInstalls = options.readCodeagentInstalls || (testInstance ? async () => [] : () => require('../tool-discovery/codeagent-install-dirs').registryInstallDirs({ env: this.env, platform: this.platform }));
    // Hub 设置（config.json）：DSH 的 cliRoot / nodePath、CodeAgent 的 command 这类显式指定的路径（specs.js 的 envOverrides / nodeSetting）。
    this.readConfig = options.readConfig || (() => require('../hub-config').getConfig());
    this.hubManaged = options.hubManaged || (id => { try { return require('../cli-tools/registry').managed(id, this.env); } catch { return null; } });
    this.tmpDir = options.tmpDir || os.tmpdir();
    this.specs = options.specs || SPECS;
    // 只保留部分 AI 的发行版（公司纯净版只留 CodeAgent）：没开放的 CLI 不在后台试跑（显式 locate 仍可查）。
    this.enabled = options.enabled || (() => true);
    this.listeners = new Set();
    this.cache = new Map();
    this.inflight = new Map();
    this.registry = { dirs: null, at: 0 };
    this.codeagent = { dirs: null, at: 0 };
    this.nodeVersions = new Map();
    this.state = { manual: {}, nodePins: {}, results: {} };
    this.timers = [];
    this.loadState();
  }

  // ---------- 持久化：<dataDir>/harness-locator/state.json ----------
  stateFile() { return this.dataDir ? path.join(this.dataDir, 'harness-locator', 'state.json') : null; }
  loadState() {
    const file = this.stateFile();
    if (!file) return;
    try {
      const raw = JSON.parse(this.fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') this.state = { manual: raw.manual || {}, nodePins: raw.nodePins || {}, results: raw.results || {} };
    } catch { /* 第一次用 */ }
    for (const [id, r] of Object.entries(this.state.results)) if (r && IDS.includes(id)) this.cache.set(id, { ...r, fromDisk: true });
  }
  // onlyIfChanged（定时复查用，2026-11-25 R40b）：和上次写盘的相比只差查找时刻、用时这类每次都变的字段时不写，
  // 原来每轮复查每个 CLI 各整份重写一次（一轮 6–9 次）。手动路径、Node 选择等用户操作照常立即写。
  saveState({ onlyIfChanged = false } = {}) {
    const file = this.stateFile();
    if (!file) return;
    const results = {};
    for (const [id, r] of this.cache) { const { fromDisk, ...rest } = r; results[id] = rest; }
    this.state.results = results;
    const stable = JSON.stringify(this.state, (key, value) => (VOLATILE_KEYS.has(key) ? undefined : value));
    if (onlyIfChanged && stable === this.savedStable) return;
    try {
      this.fs.mkdirSync(path.dirname(file), { recursive: true });
      require('../atomic-write').writeFileAtomic(this.fs, file, JSON.stringify(this.state, null, 2));
      this.savedStable = stable;
    } catch (error) { console.warn('[harness-locator] 保存失败：' + error.message); }
  }
  // CodeAgent 原来的手动路径（tool-discovery.json 的 choices.codeagent）迁过来，不丢；原文件不动，旧的版本选择器照常可用。
  migrateCodeAgentManual() {
    if (!this.dataDir || this.state.manual.codeagent) return;
    try {
      const old = JSON.parse(this.fs.readFileSync(path.join(this.dataDir, 'tool-discovery.json'), 'utf8'));
      const file = old && old.choices && old.choices.codeagent;
      if (file && path.isAbsolute(file)) { this.state.manual.codeagent = file; this.state.migrated = { codeagent: file }; this.saveState(); }
    } catch { /* 没有旧记录 */ }
  }

  // ---------- 读注册表（起隐藏的 PowerShell）：结果缓存，轮询不读 ----------
  // 同一时刻只读一次（2026-11-25 R40b）：一轮复查里几个 CLI 同时要注册表，原来各起一个 PowerShell（一轮 6–9 个），
  // 现在搭同一趟；正在读的那趟本身就是刚发起的，force 也直接用它。
  async refreshRegistry({ force = false } = {}) {
    if (this.platform !== 'win32') { this.registry = { dirs: [], at: this.now() }; return []; }
    if (!force && this.registry.dirs && this.now() - this.registry.at < CACHE_TTL_MS) return this.registry.dirs;
    if (this.registryPending) return this.registryPending;
    this.registryPending = (async () => {
      try { this.registry = { dirs: (await this.readRegistryPath()) || [], at: this.now() }; }
      catch { this.registry = { dirs: this.registry.dirs || [], at: this.now() }; }
      return this.registry.dirs;
    })().finally(() => { this.registryPending = null; });
    return this.registryPending;
  }
  async refreshCodeagent({ force = false } = {}) {
    if (this.platform !== 'win32') return [];
    if (!force && this.codeagent.dirs && this.now() - this.codeagent.at < VERSION_RECHECK_MS) return this.codeagent.dirs;
    if (this.codeagentPending) return this.codeagentPending;
    this.codeagentPending = (async () => {
      try { this.codeagent = { dirs: (await this.readCodeagentInstalls()) || [], at: this.now() }; }
      catch { this.codeagent = { dirs: this.codeagent.dirs || [], at: this.now() }; }
      return this.codeagent.dirs;
    })().finally(() => { this.codeagentPending = null; });
    return this.codeagentPending;
  }

  ctx(spec, overrides = {}) {
    const env = overrides.env || this.env;
    let config = {};
    try { config = this.readConfig() || {}; } catch { /* 设置读不出来就当没指定 */ }
    return { env, fs: this.fs, platform: overrides.platform || this.platform,
      registryDirs: overrides.env && overrides.env !== this.env ? [] : (this.registry.dirs || []),
      codeagentInstalls: overrides.env && overrides.env !== this.env ? [] : (this.codeagent.dirs || []),
      hubManaged: overrides.env && overrides.env !== this.env ? (id => { try { return require('../cli-tools/registry').managed(id, env); } catch { return null; } }) : this.hubManaged,
      manual: 'manual' in overrides ? overrides.manual : (this.state.manual[spec.id] || ''),
      nodePin: this.state.nodePins[spec.id] || '', config, nodeExplicit: spec.nodeSetting ? settingValue(config, spec.nodeSetting).trim() : '' };
  }

  // ---------- 找候选（同步，只读文件）----------
  discover(spec, ctx) {
    const places = placesFor(spec, ctx);
    // Node 这一行和「给 DSH / pi 挑 Node」用同一份清单（Program Files、nvm、fnm、volta、scoop、CodeAgent 自带……），体检结论不再和启动打架。
    if (spec.isNode && !places.some(p => p.exclusive)) {
      const SRC = { 'known-dir': 'known-dir', nvm: 'nvm', fnm: 'fnm', volta: 'volta', scoop: 'known-dir', codeagent: 'known-dir' };
      const at = places.findIndex(p => p.source === 'hub-managed');
      const extra = nodeCandidates(ctx).filter(c => SRC[c.source]).map(c => ({ kind: 'file', path: c.file, source: SRC[c.source], label: c.label }));
      places.splice(at < 0 ? places.length : at, 0, ...extra);
    }
    const exts = pathExts(ctx.env, ctx.platform);
    const commands = ctx.commandOverride ? [ctx.commandOverride] : spec.commands;
    const candidates = [], checked = [];
    const seen = new Map();
    const pathGroups = { path: { n: 0, hits: 0 }, 'registry-path': { n: 0, hits: 0 } };
    const addCandidate = (file, place) => {
      const form = resolveFile(file, { fs: this.fs, platform: ctx.platform });
      const target = form.script || form.exe || form.file || file;
      const key = keyOf(target, ctx.platform, this.fs);
      if (seen.has(key)) return { dup: seen.get(key) };
      const cand = { path: file, source: place.source, sourceLabel: place.label, form, order: candidates.length };
      seen.set(key, cand);
      candidates.push(cand);
      return { cand };
    };
    for (const place of places) {
      if (place.kind === 'none') { checked.push({ label: place.label, path: '', result: 'missing', note: '没有一键安装记录' }); continue; }
      if (place.kind === 'file') {
        if (isFile(this.fs, place.path)) { const r = addCandidate(place.path, place); checked.push({ label: place.label, path: place.path, result: 'found', note: r.dup ? '和前面找到的是同一份' : '' }); }
        else checked.push({ label: place.label, path: place.path, result: 'missing', note: '文件不在' });
        continue;
      }
      if (place.kind === 'root') {
        let hit = false;
        for (const pkg of spec.packages || []) {
          const entry = packageEntry(this.fs, place.path, pkg, spec.bin || spec.commands[0]);
          if (!entry) continue;
          hit = true;
          const r = addCandidate(entry, place);
          checked.push({ label: `${place.label}里的包 ${pkg}`, path: entry, result: 'found', note: r.dup ? '和前面找到的命令是同一份' : '' });
        }
        if (!hit && !candidates.length && place.source === 'hub-managed') checked.push({ label: place.label, path: place.path, result: 'missing', note: '记录在，但包不在' });
        else if (!hit && place.exclusive) checked.push({ label: place.label, path: place.path, result: 'missing', note: this.dirExists(place.path) ? `目录在，但里面没有 ${(spec.packages || []).join(' / ')}` : '没有这个目录' });
        continue;
      }
      // dir：命令名 × 扩展名。同一目录里有 .cmd 就不用 .ps1。
      const group = pathGroups[place.group];
      if (group) group.n++;
      let found = false;
      for (const command of commands) {
        for (const ext of exts) {
          if (ext === '.ps1' && found) continue;
          const file = path.join(place.path, command + ext);
          if (!isFile(this.fs, file)) continue;
          found = true;
          const r = addCandidate(file, place);
          checked.push({ label: place.label, path: file, result: 'found', note: r.dup ? '和前面找到的是同一份' : (place.note || '') });
        }
        if (found) break;
      }
      if (found) { if (group) group.hits++; continue; }
      if (!group) checked.push({ label: place.label, path: place.path, result: 'missing', note: place.empty || !this.dirExists(place.path) ? '没有这个目录' : (place.note || '') });
    }
    // PATH 只写一条汇总（目录清单在诊断文本开头统一列一次）。
    const groupChecked = [];
    for (const [name, g] of Object.entries(pathGroups)) {
      if (!g.n) continue;
      if (!g.hits) groupChecked.push({ label: SOURCE_LABELS[name], path: `${g.n} 个目录`, result: 'missing', note: '' });
    }
    const firstNonPath = checked.findIndex(c => c.label !== SOURCE_LABELS.path && c.label !== SOURCE_LABELS['registry-path']);
    checked.splice(firstNonPath < 0 ? checked.length : firstNonPath, 0, ...groupChecked);
    return { candidates, checked };
  }
  // DSH 组装试跑：临时 DSH_HOME/profiles/hub-cli 写和 Hub 一样的 package.json，node_modules 链到核心所在目录的 node_modules（和 Hub 一样），
  // 命令 = 启动命令（Windows 上和 Hub 一样先 --require 链接重试补丁）+ --profile hub-cli --dump-config。结束后只摘链接、再删临时目录。
  async dshBootCheck(launch, bootCheck, ctx) {
    const fs = this.fs;
    const home = path.join(this.tmpDir, `hub-harness-dsh-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    const profileDir = path.join(home, 'profiles', 'hub-cli');
    const link = path.join(profileDir, 'node_modules');
    try {
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'hub-dsh-cli-profile', private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', bootCheck.tuiPackage || '@deepseek-harness-tui/dsh-tui'], patchReload: 'startup' } } }));
      fs.symlinkSync(bootCheck.modules, link, ctx.platform === 'win32' ? 'junction' : 'dir');
      const pre = ctx.platform === 'win32' ? ['--require', unpackedPath(path.join(this.runtimeDir, 'dsh-windows-link-retry.cjs'))] : [];
      const env = { ...(launch.env || ctx.env), DSH_HOME: home };
      const t = await runner.trial({ command: launch.command, args: [...pre, ...launch.args, '--profile', 'hub-cli', '--dump-config'], env, cwd: this.tmpDir, timeoutMs: 20000 },
        { run: this.run, limit: this.limit, sleep: this.sleep });
      const ok = !t.timedOut && t.code === 0 && /dsh-base/.test(t.stdout || '');
      const errLine = String(t.stderr || t.error || '').split(/\r?\n/).map(x => x.trim()).filter(x => x && !/patch: entry .* not found/i.test(x))[0] || '';
      return { ok, timedOut: !!t.timedOut, ms: t.ms, error: ok ? '' : errLine };
    } catch (error) {
      return { ok: false, error: '没能建临时 profile：' + error.message };
    } finally {
      try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* 没建成 */ } }
      try { if (!fs.existsSync(link)) fs.rmSync(home, { recursive: true, force: true }); } catch { /* 临时目录，留着也无害 */ }
    }
  }
  dirExists(dir) { try { return this.fs.statSync(dir).isDirectory(); } catch { return false; } }

  // ---------- Node ----------
  async nodeVersionOf(file) {
    let st; try { st = this.fs.statSync(file); } catch { return ''; }
    const key = `${file}|${st.size}|${st.mtimeMs}`;
    if (this.nodeVersions.has(key)) return this.nodeVersions.get(key);
    const r = await runner.trial({ command: file, args: ['--version'], env: this.env, cwd: this.tmpDir, timeoutMs: 8000 }, { run: this.run, limit: this.limit, sleep: this.sleep });
    const v = parseNodeVersion(r.stdout);
    if (v) this.nodeVersions.set(key, v); // 读不出的不记，下次再试
    return v;
  }
  cachedNodeVersion(file) {
    let st; try { st = this.fs.statSync(file); } catch { return ''; }
    return this.nodeVersions.get(`${file}|${st.size}|${st.mtimeMs}`) || '';
  }
  nodeList(form, ctx) {
    const list = nodeCandidates(ctx);
    // npm 的命令壳优先用它旁边的 node.exe（nvm、fnm、Node 安装目录里的全局包都是这样）：排到最前（你指定的 Node 之后）。
    if (form.shimNode && !ctx.nodeExplicit) {
      const i = list.findIndex(c => c.file.toLowerCase() === form.shimNode.toLowerCase());
      if (i >= 0) list.splice(i, 1);
      list.splice(ctx.nodePin ? 1 : 0, 0, { file: form.shimNode, source: 'shim', label: '命令壳旁边自带的 Node' });
    }
    return list;
  }
  // 按优先级逐个读版本，读到第一份够新的就停（少起进程）。
  async chooseNode(spec, form, ctx) {
    const required = requiredNode(spec.nodeMin, form.pkg && form.pkg.engines);
    const list = this.nodeList(form, ctx);
    const versions = new Map();
    for (const c of list) {
      const v = await this.nodeVersionOf(c.file);
      versions.set(c.file, v);
      if (v && pickNode([c], versions, required).node) break;
    }
    return pickNode(list, versions, required);
  }
  chooseNodeSync(spec, form, ctx) {
    const required = requiredNode(spec.nodeMin, form.pkg && form.pkg.engines);
    const list = this.nodeList(form, ctx);
    const versions = new Map(list.map(c => [c.file, this.cachedNodeVersion(c.file)]));
    const pick = pickNode(list, versions, required);
    if (pick.node || pick.none) return pick;
    // 还没读过版本：先按优先级用第一份（和以前「PATH 上的 node」一致），后台试跑时再纠正。
    const unread = list.find(c => !versions.get(c.file));
    return unread ? { node: unread.file, version: '', source: unread.source, label: unread.label, unverified: true } : pick;
  }

  // ---------- 试跑一个候选 ----------
  // 文件指纹（大小 + 修改时刻）：原地升级会重写入口文件，指纹就变了。
  fileSig(file) { try { const st = this.fs.statSync(file); return `${st.size}|${st.mtimeMs}`; } catch { return ''; } }
  candSig(cand) {
    const form = cand.form || {};
    return [cand.path, form.script || form.exe || form.file || cand.path].map(f => this.fileSig(f)).join(';');
  }
  reusable(cand, prev) {
    if (!prev || !Array.isArray(prev.candidates)) return null;
    const old = prev.candidates.find(c => c && c.path === cand.path && c.verdict === 'ok' && c.fileSig && c.verifiedAt);
    if (!old || this.now() - old.verifiedAt >= REUSE_VERIFY_MS || old.fileSig !== this.candSig(cand)) return null;
    if (old.runtime && old.runtime.node && this.fileSig(old.runtime.node) !== old.nodeSig) return null;
    return { ...old, order: cand.order };
  }
  async verify(spec, cand, ctx, reusePrev = null) {
    const again = this.reusable(cand, reusePrev);
    if (again) return again;
    const t0 = this.now();
    const form = cand.form;
    let node = null;
    if (form.kind === 'node' && !skipsNode(spec, form)) node = await this.chooseNode(spec, form, ctx);
    const launch = (form.kind === 'missing' || form.kind === 'placeholder') ? null : buildLaunch(spec, form, node, ctx.env);
    let trial = null;
    let verdict;
    if (launch && launch.error) verdict = { verdict: 'broken', reasonCode: launch.reasonCode || 'missing-core', reason: `${spec.label} 的安装不完整：${launch.error}` };
    else if (launch && launch.command && !(node && (node.none || node.tooOld))) {
      trial = await runner.trial({ command: launch.command, args: [...launch.args, ...(spec.probeArgs || ['--version'])], env: probeEnv(spec, launch.env || ctx.env), cwd: this.tmpDir,
        shell: launch.shell || '', timeoutMs: spec.probeTimeoutMs || 10000 }, { run: this.run, limit: this.limit, sleep: this.sleep });
      const quick = classify({ spec, form, node, trial });
      const comp = (quick.verdict === 'ok' || quick.verdict === 'too-old') ? companions(spec, form, quick.version, cand.source) : null;
      verdict = comp && !comp.ok ? classify({ spec, form, node, trial, companions: comp }) : quick;
      if (comp && comp.runtime) cand.dshRuntime = comp.runtime;
      if (comp && comp.ok && comp.note) verdict = { ...verdict, reason: `${verdict.reason}（${comp.note}）` };
      // DSH：按 Hub 建会话的方式在隔离的临时 DSH_HOME 里组装 hub-cli profile（bundles = dsh-base + 界面包），跑同一条命令加 --dump-config。
      // 组装成功 = Hub 的会话能起；失败按 DSH 自己的报错说清缺什么。不连模型、不起界面，不碰用户自己的 ~/.dsh。
      if (comp && comp.ok && comp.bootCheck && launch.node && verdict.verdict === 'ok') {
        const boot = await this.dshBootCheck(launch, comp.bootCheck, ctx);
        cand.dshBoot = { ok: boot.ok, ms: boot.ms };
        if (boot.timedOut) verdict = { ...verdict, verdict: 'unavailable', reasonCode: 'timeout', reason: '按 Hub 会话的方式组装 DSH 时 20 秒没有回应（电脑忙时会这样），稍后会再试' };
        else if (!boot.ok) {
          const line = boot.error || '';
          verdict = { ...verdict, verdict: 'broken', reasonCode: /dsh-tui|harness-tui/i.test(line) ? 'missing-tui' : 'missing-core',
            reason: `DSH v${verdict.version || '?'} 能运行，但按 Hub 会话的方式组装失败：${line || '没有输出'}${/htrunk/i.test(verdict.version || '') ? '（公司内部源的改造版少了一些依赖）' : ''}；点「一键补齐」由 Hub 装配套的一份`.slice(0, 280) };
        }
      }
    } else verdict = classify({ spec, form, node, trial: null });
    const out = this.decorate(spec, cand, { ...verdict, node, launch, verifyMs: this.now() - t0 });
    if (out.verdict === 'ok') {
      out.fileSig = this.candSig(cand); out.verifiedAt = this.now();
      if (out.runtime && out.runtime.node) out.nodeSig = this.fileSig(out.runtime.node);
    }
    return out;
  }
  decorate(spec, cand, v) {
    const form = cand.form;
    const nodeInfo = v.node && (v.node.node ? { node: v.node.node, nodeVersion: v.node.version || null, nodeSource: v.node.label }
      : v.node.best ? { node: v.node.best.file, nodeVersion: v.node.best.version || null, nodeSource: v.node.best.label } : { node: null, nodeVersion: null, nodeSource: null });
    return {
      path: cand.path, source: cand.source, sourceLabel: cand.sourceLabel,
      version: v.version || (form.pkg && form.pkg.version) || null, minVersion: minVersionFor(spec) || null,
      runtime: { kind: form.kind === 'node' ? 'node' : 'native', node: null, nodeVersion: null, nodeSource: null, ...(form.kind === 'node' ? nodeInfo : {}), shell: v.launch && v.launch.shell || null },
      entry: form.script || form.exe || form.file || cand.path, launchKind: form.kind, package: form.pkg ? form.pkg.name : null,
      verdict: v.verdict, reasonCode: v.reasonCode || null, reason: v.reason || '', verifyMs: v.verifyMs || 0,
      order: cand.order, ...(cand.dshRuntime ? { dsh: { tuiRoot: cand.dshRuntime.tui.root, tuiPackage: cand.dshRuntime.tui.name, tuiVersion: cand.dshRuntime.tui.version, ...(cand.dshBoot ? { boot: cand.dshBoot } : {}) } } : {}),
    };
  }

  // 选一个：能用的优先（同为能用时按查找顺序；CodeAgent 按版本最高，和原来的多版本选择一致）→ 版本太低 → 暂时不可用（上次能用的那份优先）→ 跑不起来。
  choose(spec, list, prev) {
    if (!list.length) return null;
    const lastOkPath = prev && prev.lastOk && prev.lastOk.path;
    const cmp = require('../tool-discovery/candidates').compareVersions;
    return [...list].sort((a, b) => {
      const r = RANK[a.verdict] - RANK[b.verdict];
      if (r) return r;
      if (a.verdict === 'unavailable' && lastOkPath) { const x = a.path === lastOkPath ? 0 : 1, y = b.path === lastOkPath ? 0 : 1; if (x !== y) return x - y; }
      if (a.verdict === 'ok' && spec.prefer === 'newest') { const c = cmp(b.version, a.version); if (c) return c; }
      return a.order - b.order;
    })[0];
  }

  // ---------- 主流程 ----------
  async locate(id, { fresh = false, reason = 'open', manualOverride } = {}) {
    const spec = specOf(id);
    const cached = this.cache.get(id);
    if (!fresh && manualOverride === undefined && cached && !cached.fromDisk && this.now() - cached.checkedAt < CACHE_TTL_MS) return cached;
    if (manualOverride === undefined && this.inflight.has(id)) return this.inflight.get(id);
    if (manualOverride !== undefined) return this.locateNow(spec, { fresh, reason, manualOverride });
    const job = this.locateNow(spec, { fresh, reason }).then(r => this.commit(id, r));
    this.inflight.set(id, job);
    job.finally(() => this.inflight.delete(id)).catch(() => {});
    return job;
  }
  async locateNow(spec, { fresh, reason, manualOverride }) {
    const t0 = this.now();
    await this.refreshRegistry({ force: fresh && reason !== 'poll' ? true : false });
    if ((spec.extra || []).includes('codeagent-installs')) { this.migrateCodeAgentManual(); await this.refreshCodeagent({ force: fresh }); }
    const ctx = this.ctx(spec, manualOverride !== undefined ? { manual: manualOverride } : {});
    const { candidates, checked } = this.discover(spec, ctx);
    const prev = this.cache.get(spec.id) || null;
    // 定时复查：上次试跑能用、文件和所用 Node 都没动过的候选直接沿用上次结论，不再起 --version（每满 1 小时仍真跑一次）。
    const reuse = reason === 'poll' && manualOverride === undefined ? prev : null;
    const verified = await Promise.all(candidates.slice(0, MAX_VERIFY).map(c => this.verify(spec, c, ctx, reuse)));
    for (const c of candidates.slice(MAX_VERIFY)) verified.push(this.decorate(spec, c, { verdict: 'unavailable', reasonCode: null, reason: `排在第 ${c.order + 1} 位，前面已有 ${MAX_VERIFY} 份，这次没有试跑` }));
    const chosen = this.choose(spec, verified, prev);
    const result = this.compose(spec, { chosen, candidates: verified, checked, prev, reason, t0, ctx });
    return result;
  }
  compose(spec, { chosen, candidates, checked, prev, reason, t0, ctx }) {
    let verdict = chosen ? chosen.verdict : 'not-found';
    let reasonCode = chosen ? chosen.reasonCode : null;
    let text = chosen ? chosen.reason : '';
    if (chosen && chosen.verdict === 'unavailable' && prev && prev.lastOk && prev.lastOk.path === chosen.path && !chosen.version) chosen.version = prev.lastOk.version;
    if (ctx.manual && (!chosen || chosen.verdict === 'broken' || chosen.verdict === 'not-found')) {
      reasonCode = 'manual-path-failed';
      text = chosen ? `你指定的 ${ctx.manual} 跑不起来：${chosen.reason}` : `你指定的 ${ctx.manual} 不在了`;
      if (!chosen) verdict = 'not-found';
    }
    if (!chosen && !ctx.manual) {
      const hint = this.notFoundHint(spec, ctx);
      if (hint) { verdict = hint.verdict; reasonCode = hint.reasonCode; text = hint.reason; }
      else text = `这台电脑上没找到 ${spec.label}：查了 ${checked.length} 处（PATH、注册表里最新的 PATH、npm / pnpm / volta / nvm / fnm 的目录、官方安装位置和 Hub 一键安装的位置）`;
    }
    const at = this.now();
    const lastOk = verdict === 'ok' && chosen ? { version: chosen.version, path: chosen.path, at } : (prev && prev.lastOk) || null;
    const result = { id: spec.id, label: spec.label, verdict, reasonCode, reason: text, chosen: chosen || null, candidates: candidates.sort((a, b) => a.order - b.order),
      checked, fixes: [], lastOk, checkedAt: at, durationMs: at - t0, reasonTrigger: reason };
    result.fixes = fixesFor(spec, result, { isCompany: this.isCompany() });
    return result;
  }
  // 没找到命令时，DSH 再看看是不是只装了界面包（缺核心），讲清缺什么。
  notFoundHint(spec, ctx) {
    if (spec.hook !== 'dsh') return null;
    try {
      const profile = require('../dsh-cli-profile');
      const d = profile.diagnoseDshRuntime({}, ctx.env);
      if (d.state === 'tui-no-core') return { verdict: 'broken', reasonCode: 'missing-core', reason: profile.describeRuntimeIssue(d) };
    } catch { /* 读不到就按没找到 */ }
    return null;
  }
  commit(id, result) {
    const prev = this.cache.get(id);
    this.cache.set(id, result);
    this.saveState({ onlyIfChanged: true });
    const sig = r => r ? JSON.stringify([r.verdict, r.reasonCode, r.chosen && r.chosen.path, r.chosen && r.chosen.version, r.chosen && r.chosen.runtime && r.chosen.runtime.node, (r.candidates || []).length]) : '';
    if (sig(prev) !== sig(result)) for (const fn of this.listeners) { try { fn(id, result); } catch { /* 监听方出错不影响定位 */ } }
    return result;
  }

  peek(id) { specOf(id); return this.cache.get(id) || null; }
  peekAll() { const out = {}; for (const s of this.specs) out[s.id] = this.cache.get(s.id) || null; return out; }
  async locateAll(opts = {}) {
    const ids = opts.ids || this.specs.map(s => s.id).filter(id => this.enabled(id));
    const results = await Promise.all(ids.map(id => this.locate(id, opts).catch(error => ({ id, label: specOf(id).label, verdict: 'unavailable', reasonCode: null, reason: '这次没查成：' + error.message,
      chosen: null, candidates: [], checked: [], fixes: [{ label: '重新检测', act: 'recheck' }], lastOk: null, checkedAt: this.now(), durationMs: 0, reasonTrigger: opts.reason || 'open' }))));
    const out = {};
    ids.forEach((id, i) => { out[id] = results[i]; });
    return out;
  }

  // ---------- 同步入口（旧函数转调用）----------
  // 有缓存且选中的文件还在就用缓存；否则同步找一遍（不试跑），按查找顺序取第一个。env 不是定位中心自己的（测试或会话环境）时只按那份 env 找。
  // 调用方常传 { ...process.env, 另加几项 } 的副本：查找要看的那几项和定位中心自己的一样，就当同一份环境，用缓存里试跑过的结论。
  sameEnv(env) {
    if (!env || env === this.env) return true;
    const { envGet } = require('./specs');
    const keys = ['PATH', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'ProgramFiles', 'NPM_CONFIG_PREFIX', 'PNPM_HOME', 'VOLTA_HOME', 'NVM_HOME', 'NVM_SYMLINK', 'FNM_DIR',
      'AI_HUB_CLI_TOOLS_DIR', 'CLAUDE_HUB_DATA_DIR', 'CODEX_INSTALL_DIR', 'AI_HUB_CODEAGENT_COMMAND', 'AI_HUB_ANTIGRAVITY_COMMAND', 'AI_HUB_CLAUDE_PATH', 'AI_HUB_CODEX_PATH', 'AI_HUB_DSH_PATH', 'AI_HUB_PI_PATH'];
    return keys.every(k => envGet(env, k) === envGet(this.env, k));
  }
  // 全部候选（同步，不试跑），按查找顺序；同一份环境且缓存里有选中的那份时，它排第一。
  quickAll(id, { env, platform } = {}) {
    const spec = specOf(id);
    const own = this.sameEnv(env);
    const plat = platform || this.platform;
    const ctx = this.ctx(spec, own ? { platform: plat } : { env, platform: plat });
    const { candidates } = this.discover(spec, ctx);
    const cached = own ? this.cache.get(id) : null;
    if (cached && cached.chosen && isFile(this.fs, cached.chosen.path)) {
      const k = keyOf(cached.chosen.path, plat, this.fs);
      const i = candidates.findIndex(c => keyOf(c.path, plat, this.fs) === k);
      const hit = i >= 0 ? candidates.splice(i, 1)[0] : { path: cached.chosen.path, source: cached.chosen.source, sourceLabel: cached.chosen.sourceLabel, form: resolveFile(cached.chosen.path, { fs: this.fs, platform: plat }) };
      candidates.unshift({ ...hit, verdict: cached.verdict, result: cached });
    }
    return candidates;
  }
  quick(id, opts = {}) {
    const list = this.quickAll(id, opts);
    if (list[0] && list[0].result) return list[0];
    return list.find(c => c.form.kind !== 'placeholder' && c.form.kind !== 'missing') || list[0] || null;
  }
  launchFor(id, cand, { env } = {}) {
    if (!cand) return null;
    const spec = specOf(id);
    const ctx = this.ctx(spec, this.sameEnv(env) ? {} : { env });
    const node = cand.form.kind === 'node' && !skipsNode(spec, cand.form) ? this.chooseNodeSync(spec, cand.form, ctx) : null;
    const launch = buildLaunch(spec, cand.form, node, env || ctx.env);
    if (!launch || launch.error || !launch.command) return null;
    const out = { command: launch.command, args: launch.args, env: launch.env };
    if (launch.shell) out.shell = launch.shell;
    if (launch.node) out.node = launch.node;
    if (launch.pending) out.pending = true; // 没有够新的 Node：node 是那份太旧的，只供诊断显示，不能拿去启动
    return out;
  }
  launchSpec(id, opts = {}) { return this.launchFor(id, this.quick(id, opts), opts); }

  // ---------- 手动路径 ----------
  async setManualPath(id, file) {
    const spec = specOf(id);
    const target = String(file || '').trim().replace(/^"|"$/g, '');
    if (!target || !path.isAbsolute(target)) {
      return { ...this.emptyResult(spec, 'manual'), verdict: 'not-found', reasonCode: 'manual-path-failed', reason: '请选择一个完整路径的程序文件' };
    }
    const trial = await this.locateNow(spec, { fresh: true, reason: 'manual', manualOverride: target });
    // 只在试跑结论是「能用」时保存（合同：setManualPath 只在 ok 时保存）；版本太低、Node 太旧时 CLI 根本没跑起来，不记。
    if (trial.verdict === 'ok') {
      this.state.manual[id] = target;
      this.saveState();
      this.onManual && this.onManual(id, target);
      return this.commit(id, { ...trial, reasonTrigger: 'manual' });
    }
    return { ...trial, reasonCode: 'manual-path-failed', reason: trial.reasonCode === 'manual-path-failed' ? trial.reason : `你选的 ${target} 没通过试跑：${trial.reason}`,
      fixes: fixesFor(spec, { ...trial, reasonCode: 'manual-path-failed' }, { isCompany: this.isCompany() }) };
  }
  async clearManualPath(id) {
    specOf(id);
    delete this.state.manual[id];
    this.saveState();
    this.onManual && this.onManual(id, '');
    return this.locate(id, { fresh: true, reason: 'manual' });
  }
  async setNodePin(id, node) {
    specOf(id);
    if (node) this.state.nodePins[id] = node; else delete this.state.nodePins[id];
    this.saveState();
    return this.locate(id, { fresh: true, reason: 'fix' });
  }
  manualPath(id) { return this.state.manual[id] || ''; }
  emptyResult(spec, reason) {
    return { id: spec.id, label: spec.label, verdict: 'not-found', reasonCode: null, reason: '', chosen: null, candidates: [], checked: [], fixes: [], lastOk: null, checkedAt: this.now(), durationMs: 0, reasonTrigger: reason };
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // ---------- 诊断文本 ----------
  diagnosisText(ids, { sanitize = true } = {}) {
    const list = (ids && ids.length ? ids : this.specs.map(s => s.id)).filter(id => IDS.includes(id));
    const V = { ok: '能用', unavailable: '暂时不可用', 'too-old': '版本太低', broken: '跑不起来', 'not-found': '没找到' };
    const R = { found: '找到', missing: '没有', skipped: '跳过', error: '出错' };
    const lines = [`AI Hub CLI 定位诊断 · ${new Date(this.now()).toISOString().replace('T', ' ').slice(0, 16)}`];
    const dirs = pathDirs(this.env);
    lines.push(`进程 PATH（${dirs.length} 个目录）：${dirs.join(' ; ')}`);
    const extra = (this.registry.dirs || []).filter(d => !dirs.some(x => x.toLowerCase() === d.toLowerCase()));
    lines.push(`注册表里最新 PATH 多出的目录（${extra.length} 个）：${extra.join(' ; ') || '无'}`);
    for (const id of list) {
      const r = this.cache.get(id);
      lines.push('');
      if (!r) { lines.push(`■ ${specOf(id).label}：还没查过`); continue; }
      lines.push(`■ ${r.label}：${V[r.verdict] || r.verdict}${r.reasonCode ? `（${r.reasonCode}）` : ''} · ${r.reason}`);
      if (r.chosen) {
        const rt = r.chosen.runtime || {};
        lines.push(`  用的是：${r.chosen.path}（${r.chosen.sourceLabel}${r.chosen.version ? ' · v' + r.chosen.version : ''}${rt.node ? ` · Node ${rt.nodeVersion || '?'}，${rt.nodeSource}：${rt.node}` : ''}）`);
        const launch = this.launchSpec(id);
        if (launch) lines.push(`  启动命令：${[launch.command, ...launch.args].map(a => /\s/.test(a) ? `"${a}"` : a).join(' ')}${launch.shell ? `（经 ${launch.shell}）` : ''}`);
      }
      if (r.lastOk && r.verdict !== 'ok') lines.push(`  上次能用：v${r.lastOk.version || '?'} · ${r.lastOk.path}`);
      if (r.candidates.length > 1 || (r.candidates.length && !r.chosen)) {
        lines.push(`  找到 ${r.candidates.length} 份：`);
        for (const c of r.candidates) lines.push(`    - ${V[c.verdict] || c.verdict}${c.version ? ' v' + c.version : ''} · ${c.path}（${c.sourceLabel}）${c.verdict !== 'ok' ? ' · ' + c.reason : ''}`);
      }
      lines.push('  查过的位置：');
      for (const c of r.checked) lines.push(`    [${R[c.result] || c.result}] ${c.label}${c.path ? '：' + c.path : ''}${c.note ? '（' + c.note + '）' : ''}`);
      lines.push(`  查于 ${new Date(r.checkedAt).toISOString().slice(11, 19)}，用时 ${r.durationMs} ms，触发：${r.reasonTrigger}`);
    }
    const text = lines.join('\n');
    return sanitize ? sanitizeText(text, { env: this.env }) : text;
  }

  // ---------- 刷新节奏 ----------
  // 轮询、复查按到点判断（2026-11-25 R40b）：低开销模式开着时放慢 4 倍（轮询 8 分钟、复查 40 分钟），模式切换后下一拍就按新节奏；
  // 上一轮还没跑完时这一拍跳过，不叠加。
  start({ startupDelayMs = 1500 } = {}) {
    if (this.timers.length) return this;
    const t = (fn, ms, repeat) => { const h = repeat ? setInterval(fn, ms) : setTimeout(fn, ms); h.unref && h.unref(); this.timers.push(h); };
    t(() => { void this.locateAll({ fresh: true, reason: 'startup' }).catch(() => {}); }, startupDelayMs, false);
    const last = { poll: this.now(), recheck: this.now() }, running = { poll: false, recheck: false };
    const every = (name, base, fn) => () => {
      if (running[name] || this.now() - last[name] < slowed(base) - 1000) return;
      last[name] = this.now(); running[name] = true;
      Promise.resolve().then(fn).catch(() => {}).finally(() => { running[name] = false; });
    };
    t(every('poll', POLL_MS, () => this.poll()), POLL_MS, true);
    t(every('recheck', VERSION_RECHECK_MS, () => this.recheckAll()), VERSION_RECHECK_MS, true);
    return this;
  }
  stop() { for (const h of this.timers) { clearTimeout(h); clearInterval(h); } this.timers = []; }
  // 便宜轮询：只看文件在不在（不起进程）。选中的没了 → 重查（自愈）；没找到的 → 按已知 PATH 看看有没有新冒出来的。
  async poll() {
    const jobs = [];
    for (const s of this.specs) {
      const r = this.cache.get(s.id);
      if (!r || !this.enabled(s.id)) continue;
      if (r.chosen && !isFile(this.fs, r.chosen.path)) { jobs.push(this.refresh(s.id, 'poll')); continue; }
      if (!r.chosen) {
        const { candidates } = this.discover(s, this.ctx(s));
        if (candidates.length) jobs.push(this.refresh(s.id, 'poll'));
      }
    }
    await Promise.all(jobs);
  }
  async recheckAll() { await Promise.all(this.specs.filter(s => this.enabled(s.id)).map(s => this.refresh(s.id, 'poll'))); }
  // 查完写进缓存并广播（IPC、安装完成、轮询都走这里）。
  refresh(id, reason = 'open') { return this.locate(id, { fresh: true, reason }); }
}

// 试跑用的是系统上单独的 Node，读不了 app.asar 里面的文件；要交给它的 Hub 文件打包时解压在 app.asar.unpacked
// （package.json 的 asarUnpack），路径换到那边。换法和 acp-profiles.js 的 dshRuntimeFile 一样；开发目录没有 app.asar，原样返回。
function unpackedPath(file) {
  return String(file).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

module.exports = { HarnessLocator, CACHE_TTL_MS, POLL_MS, VERSION_RECHECK_MS, pathExts, unpackedPath };
