'use strict';
// 试跑结果 → 五种结论（定位中心）：能用 ok / 暂时不可用 unavailable / 版本太低 too-old / 跑不起来 broken / 没找到 not-found。
// 每种配 reasonCode 和一句直接给同事看的人话；修复按钮由 fixes() 按结论给。
const path = require('node:path');
const { versionAtLeast } = require('./node-pick');

const VERDICTS = ['ok', 'unavailable', 'too-old', 'broken', 'not-found'];
const RANK = { ok: 0, 'too-old': 1, unavailable: 2, broken: 3, 'not-found': 4 };

function shortNode(v) { const m = /^(\d+)\.(\d+)/.exec(String(v || '')); return m ? `${m[1]}.${m[2]}` : String(v || ''); }
function firstLine(text) { return String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || ''; }

// 读版本：跳过「有新版本」这类提示行，只取第一行带版本号的（代码页提示 Active code page: 65001 不含点分版本，自然跳过）。
function defaultParse(text) {
  for (const line of String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)) {
    if (/new version|update available|新版本|升级/i.test(line)) continue;
    const m = /(\d+\.\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.+-]+)?)/.exec(line);
    if (m) return m[1];
  }
  return '';
}
function parserFor(spec) {
  if (spec.versionParser === 'codeagent') { try { return require('../codeagent-version-probe').parseCodeAgentVersion; } catch { return defaultParse; } }
  if (spec.isNode) return text => { const m = /v?(\d+\.\d+\.\d+)/.exec(String(text || '')); return m ? m[1] : ''; };
  return defaultParse;
}
function minVersionFor(spec) {
  if (spec.minVersion) return spec.minVersion;
  if (spec.id === 'codeagent') { try { return require('../codeagent-version-check').MIN_VERSION; } catch { return null; } }
  return null;
}
function cliTooOld(spec, version) {
  const min = minVersionFor(spec);
  if (!min || !version) return false;
  if (spec.id === 'codeagent') { try { return require('../codeagent-version-check').isOutdated(version); } catch { /* 用通用比较 */ } }
  return !versionAtLeast(version, min);
}

const POLICY_RE = /组策略|group policy|blocked by your (?:system )?administrator|管理员已阻止|已被系统管理员|禁止运行脚本|running scripts is disabled|cannot be loaded because|AppLocker|Software Restriction/i;
const BAD_EXE_RE = /not a valid Win32|不是有效的 Win32|ERROR_BAD_EXE_FORMAT|\b193\b|EFTYPE|spawn UNKNOWN/i;
const MISSING_MODULE_RE = /Cannot find (?:package|module)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/i;
const NOT_RECOGNIZED_RE = /is not recognized as an internal or external command|不是内部或外部命令|系统找不到指定的路径|The system cannot find the path specified/i;

// 一个候选的结论。ctx：{ spec, form, node（pickNode 的结果，JS 入口才有）, trial（runner.trial 的结果）, companions（DSH 包检查）}
function classify({ spec, form, node, trial, companions }) {
  const name = spec.label;
  if (!form || form.kind === 'missing') return { verdict: 'not-found', reasonCode: null, reason: `文件不在了` };
  if (form.kind === 'placeholder') {
    return { verdict: 'broken', reasonCode: 'placeholder-exe',
      reason: `${path.basename(form.file)} 只是 npm 留下的占位文件，没装完整（安装脚本被禁用时会这样），重新安装 ${name} 即可` };
  }
  if (form.kind === 'node' && node) {
    if (node.none) return { verdict: 'broken', reasonCode: 'no-node', reason: `${name} 要 Node.js ${shortNode(node.required) || ''} 以上才能运行，这台电脑上没找到 Node.js` };
    if (node.tooOld) {
      const ver = form.pkg && form.pkg.version ? ` ${form.pkg.version}` : '';
      return { verdict: 'too-old', reasonCode: 'node-too-old',
        reason: `本机 Node 是 ${shortNode(node.best.version)}，${name}${ver} 要 ${shortNode(node.required)} 以上` };
    }
  }
  if (!trial) return { verdict: 'unavailable', reasonCode: 'timeout', reason: '还没试跑' };
  if (trial.timedOut) return { verdict: 'unavailable', reasonCode: 'timeout', reason: `试跑 ${Math.round((trial.ms || 10000) / 1000)} 秒没有回应（电脑忙或杀毒软件在扫描时会这样），稍后会再试` };
  const text = `${trial.stdout || ''}\n${trial.stderr || ''}\n${trial.error || ''}`;
  const version = parserFor(spec)(`${trial.stdout || ''}\n${trial.stderr || ''}`);
  if (!version || trial.code !== 0) {
    if (POLICY_RE.test(text)) return { verdict: 'broken', reasonCode: 'policy-blocked', reason: `${name} 被这台电脑的安全策略（组策略）拦下了，没能运行：${firstLine(trial.stderr || trial.error)}`.slice(0, 200) };
    if (BAD_EXE_RE.test(text) || trial.errno === 'UNKNOWN' || trial.errno === 'EFTYPE') {
      return { verdict: 'broken', reasonCode: 'placeholder-exe', reason: `${name} 的程序文件不是有效的 Windows 程序（多半是 npm 留下的占位文件），重新安装即可` };
    }
    if (MISSING_MODULE_RE.test(text)) {
      const tui = /dsh-tui/i.test(text);
      return { verdict: 'broken', reasonCode: tui ? 'missing-tui' : 'missing-core', reason: `${name} 缺文件，启动时报找不到模块：${firstLine((text.match(/Cannot find[^\n]*/i) || [''])[0])}`.slice(0, 200) };
    }
    if (trial.code === 9009 || NOT_RECOGNIZED_RE.test(text)) {
      return { verdict: 'broken', reasonCode: 'spawn-failed', reason: `命令壳 ${path.basename(form.file || form.exe || '')} 指向的程序不在了（可能升级到一半或被删了）` };
    }
    if (trial.errno === 'ENOENT') return { verdict: 'broken', reasonCode: 'spawn-failed', reason: '程序打不开（文件不在或没有权限）' };
    if (trial.code === 0 && !version) return { verdict: 'broken', reasonCode: 'bad-output', reason: `运行了，但没有输出版本号：${firstLine(trial.stdout) || '（没有输出）'}`.slice(0, 200) };
    // 非零退出一律不算能用，即使输出里带了版本号（试跑通过 = 真能启动）。
    return { verdict: 'broken', reasonCode: 'spawn-failed', reason: `运行出错（退出码 ${trial.code ?? trial.errno ?? '未知'}）：${firstLine(trial.stderr || trial.stdout || trial.error) || '没有输出'}`.slice(0, 200) };
  }
  if (companions && !companions.ok) return { verdict: companions.tooOld ? 'too-old' : 'broken', reasonCode: companions.reasonCode || null, reason: companions.reason, version };
  if (cliTooOld(spec, version)) return { verdict: 'too-old', reasonCode: null, reason: `${name} 是 v${version}，最低要 v${minVersionFor(spec)}`, version };
  return { verdict: 'ok', reasonCode: null, reason: `${name} v${version} 能用`, version };
}

// 结论对应的按钮（和体检现有的 { label, act } 同一格式）。
function fixes(spec, result, { isCompany = false } = {}) {
  const out = [];
  const add = f => { if (f && !out.some(x => x.act === f.act && x.url === f.url)) out.push(f); };
  const install = (isCompany && spec.companyInstall) || spec.install;
  const pick = { label: '手动选择程序…', act: 'harness-pick', id: spec.id };
  const recheck = { label: '重新检测', act: 'recheck' };
  const code = result.reasonCode;
  if (result.chosen && result.chosen.source === 'manual' && result.verdict !== 'ok') add({ label: '改回自动查找', act: 'harness-clear-manual', id: spec.id });
  if (code === 'manual-path-failed') { add({ label: '改回自动查找', act: 'harness-clear-manual', id: spec.id }); add(pick); add(recheck); return out; }
  switch (result.verdict) {
    case 'ok': return out;
    case 'unavailable': add(recheck); return out;
    case 'not-found': add(install); add(pick); add(recheck); return out;
    case 'too-old':
      if (code === 'node-too-old') { if (spec.id === 'pi') add(spec.install); if (spec.repair) add(spec.repair); add({ label: '下载新版 Node.js', act: 'open-url', url: 'https://nodejs.org/zh-cn/download' }); }
      else add(install);
      add(recheck); return out;
    default: // broken
      if ((code === 'missing-tui' || code === 'missing-core') && spec.repair) add(spec.repair);
      if (code === 'no-node') { if (spec.id === 'pi') add(spec.install); if (spec.repair) add(spec.repair); add({ label: '下载 Node.js', act: 'open-url', url: 'https://nodejs.org/zh-cn/download' }); }
      if (code === 'placeholder-exe' || code === 'spawn-failed' || code === 'bad-output') add(install);
      add(pick); add(recheck); return out;
  }
}

module.exports = { classify, fixes, defaultParse, parserFor, minVersionFor, cliTooOld, VERDICTS, RANK, POLICY_RE };
