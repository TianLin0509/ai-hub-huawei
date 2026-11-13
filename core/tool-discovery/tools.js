'use strict';
// 三个外部工具各自「去哪找、怎样算能用、选好的写到哪」（2026-11-07，5.5.24）。
// 只查常见安装位置和环境变量 / 注册表里的 PATH，不做全盘深搜；welink-cli 的全盘找仍是它原来那套（用户点「再找一次」时才跑）。
const fs = require('node:fs');
const path = require('node:path');
const { npmPrefixes, pathDirs, registryPathDirs } = require('./npm-global-dirs');
const { probeVersion } = require('./candidates');

const exists = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };

// ---- welink-cli ----
// npm 全局目录里真正的 exe 在 node_modules\@welink\welink-cli 下，welink-cli.cmd 只是包装；两处都看。
function welinkUnder(dir) {
  if (!dir) return [];
  return [path.join(dir, 'node_modules', '@welink', 'welink-cli', 'welink-cli.exe'), path.join(dir, 'welink-cli.exe')].filter(exists);
}
function welinkAdapter(service, { env = process.env, findDeep = null, registryDirs = registryPathDirs } = {}) {
  const welink = require('../company-assistant/welink');
  return {
    label: 'welink-cli',
    async list({ deep = false } = {}) {
      const out = [];
      const add = (files, via) => { for (const f of [].concat(files || [])) if (f && welink.isCliFile(f)) out.push({ path: f, via }); };
      add(env.CLAUDE_HUB_WELINK_CLI, 'env');
      add(this.getConfigured(), 'manual');
      for (const dir of npmPrefixes(env)) add(welinkUnder(dir), 'npm');
      for (const dir of pathDirs(env)) add(welinkUnder(dir), 'path');
      for (const dir of await registryDirs({ env })) add(welinkUnder(dir), 'path');
      if (deep) {
        const found = await (findDeep || service.deps?.findCliDeep || welink.findCliDeep)({ env, onStage: stage => service.onCliStage?.(stage) });
        for (const hit of found?.paths || (found?.path ? [found] : [])) add(hit.path, hit.via || 'disk');
      }
      return out;
    },
    // 不是 welink-cli 的程序（如 WeLink 桌面客户端）不运行：启动它会把客户端主窗口弹出来。
    probe: file => welink.isCliFile(file) ? probeVersion(file, { timeoutMs: 8000, env }) : Promise.resolve({ ok: false, reason: '这不是 welink-cli（请选 welink-cli.exe）' }),
    getConfigured: () => service.settings().cliPath || '',
    configuredByUser: () => service.settings().cliPathManual === true,
    setConfigured: (file, { manual = false } = {}) => service.setSettings({ cliPath: file || '', cliPathManual: manual }),
  };
}

// ---- PPT Doctor ----
// 版本：安装目录的联动能力标记（hub-api.json）里有 version 就用它；没有就读 exe 的文件版本信息（PowerShell，隐藏窗口、5 秒超时）。
function exeFileVersion(file, { execFileImpl } = {}) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const run = execFileImpl || require('node:child_process').execFile;
  const data = Buffer.from(JSON.stringify(file), 'utf8').toString('base64');
  const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}'))|ConvertFrom-Json; $v=(Get-Item -LiteralPath $p).VersionInfo; if ($v.ProductVersion) { $v.ProductVersion } else { $v.FileVersion }`;
  return new Promise(resolve => {
    try {
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 5000, encoding: 'utf8' }, (error, stdout) => {
          const m = /(\d+(?:\.\d+)+)/.exec(String(stdout || ''));
          resolve(m ? m[1] : null);
        });
    } catch { resolve(null); }
  });
}
function pptDoctorAdapter(service, { env = process.env } = {}) {
  const discovery = require('../company-assistant/ppt-doctor-discovery');
  const deps = service.deps || {};
  const names = dir => ['PPT-Doctor.exe', 'PPT Doctor.exe'].map(n => path.join(dir, n));
  return {
    label: 'PPT Doctor',
    async list() {
      const out = [];
      const add = (files, via) => { for (const f of [].concat(files || [])) if (f) out.push({ path: f, via }); };
      add(this.getConfigured(), 'manual');
      add(env.PPT_DOCTOR_EXE, 'env');
      add(await discovery.candidates(env, deps), 'install');
      for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) add(names(path.join(base, 'PPT-Doctor')), 'install');
      return out;
    },
    async probe(file) {
      // 测试用：直接信任指定的程序（与 PptDoctor 的 pptDoctorTrustedExecutable 一致）。
      const marker = deps.pptDoctorTrustedExecutable ? (deps.pptDoctorCapability || {}) : await discovery.capability(file);
      if (!marker) return { ok: false, reason: '缺少兼容的联动能力标记' };
      const version = marker.version || marker.appVersion || (deps.pptDoctorTrustedExecutable ? null : await exeFileVersion(file));
      return { ok: true, version: version ? String(version) : null };
    },
    getConfigured: () => (service.settings().ppt || {}).doctorExe || '',
    setConfigured: file => service.setSettings({ ppt: { doctorExe: file || '' } }),
  };
}

// ---- CodeAgent ----
// 同一个目录里的 codeagent.exe / .cmd / .bat、旧名 cac 是同一份安装，只取一个（顺序与 codeagent-config.commandFile 一致）。
const CA_NAMES = ['codeagent', 'cac'], CA_EXTS = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
function codeagentIn(dir) {
  if (!dir) return null;
  for (const name of CA_NAMES) for (const ext of CA_EXTS) { const f = path.join(dir, name + ext); if (exists(f)) return f; }
  return null;
}
// 常见安装目录：%LOCALAPPDATA%\Programs、%ProgramFiles%、%ProgramFiles(x86)% 下名字里带 codeagent 的文件夹（本身和 bin 子目录）。
function installDirs(env = process.env) {
  const out = [];
  for (const base of [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) if (e.isDirectory() && /code\s*-?agent/i.test(e.name)) out.push(path.join(base, e.name), path.join(base, e.name, 'bin'));
  }
  return out;
}
function codeagentAdapter(store, { env = process.env, registryDirs = registryPathDirs } = {}) {
  return {
    label: 'CodeAgent',
    async list() {
      const out = [];
      const add = (file, via) => { if (file) out.push({ path: file, via }); };
      add(this.getConfigured(), 'manual');
      for (const dir of pathDirs(env)) add(codeagentIn(dir), 'path');
      for (const dir of npmPrefixes(env)) add(codeagentIn(dir), 'npm');
      for (const dir of await registryDirs({ env })) add(codeagentIn(dir), 'path');
      for (const dir of installDirs(env)) add(codeagentIn(dir), 'install');
      return out;
    },
    probe(file) {
      const probeEnv = { ...env };
      try {
        const config = require('../codeagent-config');
        require('../codeagent-launch-env').applyAccountEnv(probeEnv, config.resolveCodeAgentConfig(probeEnv));
      } catch { /* 读不到账号环境也照样读版本 */ }
      return probeVersion(file, { timeoutMs: 10000, env: probeEnv, parse: require('../codeagent-version-probe').parseCodeAgentVersion });
    },
    getConfigured: () => store.choice('codeagent'),
    setConfigured: file => store.setChoice('codeagent', file),
    // 选定的路径交给 codeagent-config：之后建会话、查版本、开登录窗口都用它。
    onPick: file => {
      try {
        const config = require('../codeagent-config');
        if ((config.getDiscoveredCommand() || '') === (file || '')) return;
        config.setDiscoveredCommand(file || '');
        require('../codeagent-version-probe').forgetCodeAgentVersion();
      } catch { /* 配置模块不可用时保持原样 */ }
    },
  };
}

module.exports = { welinkAdapter, pptDoctorAdapter, codeagentAdapter, codeagentIn, installDirs, welinkUnder, exeFileVersion };
