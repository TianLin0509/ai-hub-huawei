'use strict';
// CodeAgent 版本：跑一次「<命令> --version」（隐藏窗口、8 秒超时），10 分钟内复用。命令取本机配置（codeagent-config.js 已拦掉特殊字符）。
// cmd.exe 用 windowsVerbatimArguments 原样传命令行（同 codeagent-pool.js 的号池登录）；超时只按 PID 用 taskkill /T 结束我们自己刚起的这一个 cmd 进程树
// ——这棵树确定是这里自己起的（2026-10-18 审核）。
let versionCache = null;
const CODEAGENT_VERSION_TIMEOUT_MS = 8000;
function parseCodeAgentVersion(text) {
  for (const line of String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)) {
    if (/new version|codeagent update|新版本|升级/i.test(line)) continue;
    const match = /^\s*(?:(?:codeagent(?:cli)?|cac)\s+(?:version\s*:?\s*|v)?|version\s*:?\s*|v)?(\d+(?:\.\d+){2,}[A-Za-z0-9.+-]*)(?:\s*\([^)]*\))?\s*$/i.exec(line);
    if (match) return match[1];
  }
  return '';
}
function codeagentVersion(command) {
  if (versionCache && versionCache.command === command && Date.now() - versionCache.at < 10 * 60000) return versionCache.promise;
  const promise = new Promise((resolve, reject) => {
    const { execFile } = require('node:child_process');
    let timer = null, timedOut = false;
    const done = (error, stdout, stderr) => {
      if (timedOut) return;
      clearTimeout(timer);
      const version = parseCodeAgentVersion(String(stdout || '') + '\n' + String(stderr || ''));
      // 命令行输出可能是本机代码页（中文 Windows 是 GBK），不原样带回，只说结论
      if (version) resolve(version); else reject(new Error(!error ? '版本号没读出来' : timedOut ? '8 秒没返回' : `命令没跑成（退出码 ${error.code}），可能没装 CodeAgent 或它不在 PATH 里`));
    };
    let child;
    const env = { ...process.env };
    require('./codeagent-launch-env').applyAccountEnv(env, require('./codeagent-config').resolveCodeAgentConfig(env));
    if (process.platform === 'win32') {
      const head = /^[A-Za-z0-9_.-]+$/.test(command) ? command : `"${String(command).replace(/"/g, '')}"`;
      child = execFile('cmd.exe', ['/d', '/s', '/c', `"call ${head} --version"`], { windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8', env }, done);
    } else child = execFile(command, ['--version'], { encoding: 'utf8', env }, done);
    timer = setTimeout(() => {
      timedOut = true;
      reject(Object.assign(new Error('8 秒没返回'), { code: 'version-timeout' }));
      const pid = child && child.pid;
      if (pid && process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      else { try { child.kill(); } catch { /* 已退出 */ } }
    }, CODEAGENT_VERSION_TIMEOUT_MS);
    timer.unref?.();
  });
  versionCache = { command, at: Date.now(), promise };
  promise.catch(() => { if (versionCache && versionCache.promise === promise) versionCache = null; });
  return promise;
}

// 已有探测（进行中或 10 分钟内）的结果；没有，或探测早于 notBefore（程序文件之后被换过）时返回 null。不会新起进程。
function peekCodeAgentVersion(command, { notBefore = 0 } = {}) {
  if (!versionCache || versionCache.command !== command || versionCache.at < notBefore || Date.now() - versionCache.at >= 10 * 60000) return null;
  return versionCache.promise;
}

module.exports = { codeagentVersion, peekCodeAgentVersion, parseCodeAgentVersion, CODEAGENT_VERSION_TIMEOUT_MS };
