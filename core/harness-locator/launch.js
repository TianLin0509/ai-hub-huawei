'use strict';
// 由解析结果拼出启动命令（定位中心）。试跑用的就是这条命令再加 --version，建会话也用它：两边永远是同一条。
//   native  → { command: exe, args: [] }
//   node    → { command: <选中的 node.exe>, args: [<JS 入口>], node: { path, version, source } }
//   cmd/ps1 → { command: 壳本身, args: [], shell: 'cmd' | 'ps1' }
// 个别 CLI 的特殊处理（spec.hook）：
//   codex  npm 包里的 bin/codex.js 只是转发器（转发时不隐藏窗口），直接换成包里自带的原生 codex.exe；
//   dsh    检查终端界面包（TUI）和同代插件，缺了判「跑不起来」并说清缺什么；
//   pi     旧包名 @mariozechner/… 作者已弃用，判「版本太低」。
const path = require('node:path');

// 这种 JS 入口其实不用 Node 跑（Codex 的 npm 包：换成包里自带的原生程序）。
function skipsNode(spec, form) { return spec.hook === 'codex' && !!form.pkg && form.pkg.name === '@openai/codex'; }

function buildLaunch(spec, form, node, env) {
  if (!form) return null;
  if (form.kind === 'native') return { command: form.exe, args: [], env };
  if (form.kind === 'cmd') return { command: form.file, args: [], env, shell: 'cmd' };
  if (form.kind === 'ps1') return { command: form.file, args: [], env, shell: 'ps1' };
  if (form.kind === 'node') {
    if (spec.hook === 'codex' && form.pkg && /^@openai\/codex$/.test(form.pkg.name)) {
      try {
        const r = require('./codex-npm').resolveCodexScript(env, form.script);
        return { command: r.command, args: r.args || [], env: r.env };
      } catch (error) { return { error: error.message, reasonCode: 'missing-core' }; }
    }
    if (!node || !node.node) return { command: node && node.best ? node.best.file : null, args: [form.script], env, node: node && node.best ? { path: node.best.file, version: node.best.version || null, source: node.best.label } : null, pending: true };
    return { command: node.node, args: [form.script], env, node: { path: node.node, version: node.version, source: node.label } };
  }
  return null;
}

// 试跑用的环境：CodeAgent 读版本也要带上账号环境（和 tool-discovery 的 CodeAgent 适配器一致）。
function probeEnv(spec, env) {
  if (spec.id !== 'codeagent') return env;
  const out = { ...env };
  try {
    const config = require('../codeagent-config');
    require('../codeagent-launch-env').applyAccountEnv(out, config.resolveCodeAgentConfig(out));
  } catch { /* 读不到账号环境也照样读版本 */ }
  return out;
}

// 用户的 .npmrc 指向内部源：registry= 填了地址、又不是公网 npm（npmjs 官方、yarn、npmmirror、淘宝老域名）。只读本机配置判断来源，不下载。
const PUBLIC_NPM_HOSTS = /(?:^|\.)(?:npmjs\.org|yarnpkg\.com|npmmirror\.com|npm\.taobao\.org)$/i;
function internalNpmRegistry(env = process.env) {
  try {
    const home = env.USERPROFILE || require('node:os').homedir();
    const text = require('node:fs').readFileSync(path.join(home, '.npmrc'), 'utf8');
    const lines = [...text.matchAll(/^\s*registry\s*=\s*["']?([^\s"'#;]+)/gim)];
    if (!lines.length) return false;
    const host = new URL(lines[lines.length - 1][1]).hostname; // npm 取最后一行 registry=
    return !!host && !PUBLIC_NPM_HOSTS.test(host);
  } catch { return false; }
}

// DSH 的配套包检查。form 是 node 或 cmd；返回 { ok } 或 { ok:false, reasonCode, reason }。
function dshCompanions(form, version, source) {
  const profile = require('../dsh-cli-profile');
  if (source === 'dsh-desktop' || form.kind === 'cmd' || form.kind === 'ps1') {
    return { ok: false, reasonCode: 'missing-tui', desktop: true,
      reason: `DSH 桌面版自带的命令能运行${version ? `（v${version}）` : ''}，但它不带终端界面包（TUI），Hub 的 DSH 会话开不起来；点「一键补齐」由 Hub 装一份配套的终端版，不动你的桌面版` };
  }
  if (form.kind !== 'node' || !form.pkg) return { ok: true };
  const pkg = form.pkg;
  const isCore = pkg.name === '@deepseek-ai/dsh';
  const wantsTui = isCore || profile.TUI_PACKAGES.some(n => pkg.dependencies && pkg.dependencies[n]);
  if (!wantsTui) return { ok: true };
  // 核心所在的全局目录（…\node_modules\@deepseek-ai\dsh 往上两级的那个 node_modules 的父目录）；npm link 的源码目录按真实位置往上找。
  const m = /^(.*?)[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]/i.exec(form.script);
  const root = m ? m[1] : null;
  const tui = (root && profile.tuiAt(root)) || profile.tuiNear(pkg.dir);
  if (!tui) {
    // 黄区实测（2026-11-20）：公司内部 npm 源有 @deepseek-ai/dsh（1.0.0-htrunk.x），但没有界面包（404），npm 默认源又被代理挡（407）——
    // 这种情况 npm i -g 补不上，只能由 Hub 从自己的下载源补。
    const internal = /htrunk/i.test(pkg.version || '') || internalNpmRegistry();
    return { ok: false, reasonCode: 'missing-tui', internalRegistry: internal,
      reason: internal
        ? `找到了 DSH 核心 v${pkg.version || '?'}（公司内部 npm 源装的），但缺终端界面包（TUI）：公司内部 npm 源没有 DSH 界面包，用 npm 补不上；点「一键补齐」从 Hub 自己的下载源装`
        : `找到了 DSH 核心${pkg.version ? ' v' + pkg.version : ''}，但缺终端界面包（TUI，@deepseek-harness-tui/dsh-tui），Hub 的 DSH 会话开不起来；点「一键补齐」由 Hub 装配套的一份` };
  }
  const core = { root: root || pkg.dir, version: pkg.version };
  // 能不能起 Hub 的会话以试跑为准（负责人 2026-11-21）：locator 在隔离的临时 DSH_HOME 里按 Hub 的 hub-cli profile 组装一次（--dump-config），
  // 不再按包结构静态判断同代插件、dsh-base 或 0.20 启动器的界面本体——0.2.2 这一代插件由核心自己的 node_modules 提供，静态规则会误伤。
  // 版本范围对不上只提示、不判坏（内源版本号带预发布后缀，声明范围天然对不上）。
  const chk = profile.peerCheck(tui, core);
  const note = !chk.coreFits || chk.wrong.length
    ? `DSH 核心 v${pkg.version || '?'} 和终端界面包 v${tui.version || '?'} 这个组合不在界面包声明的版本范围内${chk.wrong.length ? `（${chk.wrong.slice(0, 3).join('、')}）` : ''}，试跑通过就照常用`
    : '';
  const sameRoot = root && tui.root && path.resolve(tui.root).toLowerCase() === path.resolve(root).toLowerCase();
  // 核心和界面包在同一个全局目录：Hub 的 hub-cli 把它的 node_modules 链进 profile，试跑照做。分在两处时 Hub 另建拼接目录，这里只按 --version。
  const bootCheck = sameRoot ? { modules: path.join(root, 'node_modules'), tuiPackage: tui.name } : null;
  return { ok: true, ...(note ? { note } : {}), ...(bootCheck ? { bootCheck } : {}), runtime: { root: sameRoot ? root : null, core, tui } };
}

function companions(spec, form, version, source) {
  if (spec.hook === 'dsh') return dshCompanions(form, version, source);
  if (spec.hook === 'pi' && form.kind === 'node' && form.pkg && form.pkg.name === '@mariozechner/pi-coding-agent') {
    return { ok: false, tooOld: true, reasonCode: null, reason: `找到的是旧包 @mariozechner/pi-coding-agent ${form.pkg.version || ''}（作者已改名弃用），请装新版 @earendil-works/pi-coding-agent` };
  }
  return { ok: true };
}

module.exports = { buildLaunch, probeEnv, companions, dshCompanions, skipsNode, internalNpmRegistry };
