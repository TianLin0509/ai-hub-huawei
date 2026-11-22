'use strict';
// CodeAgent CLI 一键安装 / 升级（2026-11-16）。
// 公司电脑实测（只读摸底，见任务报告 r25）：
//   - 官方安装器 Cli3.0-Setup.exe 是 NSIS 打包、要求管理员（requireAdministrator），静默参数 /S，默认装到 C:\Program Files\CodeAgentCLI；
//     带有效的 Authenticode 签名（签名者 CN=CodeAgentCLI3.0, O=Huawei），约 110 MB。
//   - 已装时 `codeagent update --force` 跳过确认直接升级（`update --help` 原文：-f, --force  Skip confirmation and upgrade）。
//   - 官方最新版接口要登录（匿名 401），官方下载页（CSOP 软件中心）要工号登录，所以「未装」时由用户在 Hub 打开的官方页里点下载，
//     Hub 接管落盘、核签名、静默安装。很多同事的「下载」文件夹里已经有下过的安装器，先用它（同样核签名）。
// 所有子进程隐藏窗口；安装器要管理员，Windows 会弹一次系统授权框（UAC），这是唯一需要用户点的地方。
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');

const INSTALLER_RE = /^Cli\d+(?:\.\d+)*-Setup[^\\/]*\.exe$/i;
const MIN_SIZE = 20 * 1024 * 1024;
const MAX_SIZE = 800 * 1024 * 1024;
const UPDATE_TIMEOUT_MS = 20 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const fail = (code, message) => Object.assign(new Error(message), { code });

// 官方签名：状态有效、签名者属于本公司、证书名里带 CodeAgent。只认这个签名，换包、篡改、被代理换成网页都会不通过。
function acceptSignature(sig) {
  if (!sig || String(sig.status) !== 'Valid') return { ok: false, reason: sig && sig.status ? `签名状态是 ${sig.status}` : '没有数字签名' };
  const subject = String(sig.subject || '');
  if (!/(?:^|,\s*)O=Huawei(?:\s*,|$)/i.test(subject) || !/CN=[^,]*code\s*-?agent/i.test(subject)) return { ok: false, reason: '签名者不是 CodeAgent 官方' };
  return { ok: true };
}

const psQuote = value => `'${String(value).replace(/'/g, "''")}'`;
const isAlive = pid => { if (!pid) return false; try { process.kill(Number(pid), 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// 按 PID 结束整棵子进程树（2026-11-16 r25b）：只认这次启动的进程号，不按名字杀；隐藏窗口。
function killTree(pid, { platform = process.platform } = {}) {
  return new Promise(resolve => {
    if (!pid) { resolve({ ok: false, output: 'no pid' }); return; }
    if (platform !== 'win32') { try { process.kill(Number(pid), 'SIGKILL'); resolve({ ok: true, output: '' }); } catch (error) { resolve({ ok: false, output: error.message }); } return; }
    execFile('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, encoding: 'utf8', timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout || ''}${stderr || ''}`.trim() });
    });
  });
}

// 列出某进程及其全部后代的 PID（超时结束前先记下整棵树，结束后逐个确认都退出了；2026-11-17 r25c）。
function listTree(pid, { platform = process.platform } = {}) {
  return new Promise(resolve => {
    if (!pid) { resolve([]); return; }
    if (platform !== 'win32') { resolve([Number(pid)]); return; }
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 30000 }, (error, stdout) => {
      const kids = new Map();
      let rows = 0;
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const m = /^(\d+)\s+(\d+)$/.exec(line.trim());
        if (m) { rows++; const list = kids.get(Number(m[2])) || []; list.push(Number(m[1])); kids.set(Number(m[2]), list); }
      }
      // 进程表读不出来：后代未知，标记给调用方按「可能还在跑」保守处理（r25 三审）。
      if (error || !rows) { resolve(Object.assign([Number(pid)], { unknown: true })); return; }
      const out = [Number(pid)];
      for (let i = 0; i < out.length; i++) for (const c of kids.get(out[i]) || []) if (!out.includes(c)) out.push(c);
      resolve(out);
    });
  });
}

// 等一组进程退出，最多等 ms 毫秒；返回仍在运行的 PID。
async function survivorsAfter(pids, { alive = isAlive, ms = 3000, step = 200 } = {}) {
  const deadline = Date.now() + ms;
  let left = [...new Set(pids.filter(Boolean).map(Number))].filter(p => alive(p));
  while (left.length && Date.now() < deadline) { await new Promise(r => setTimeout(r, step)); left = left.filter(p => alive(p)); }
  return left;
}

// 隐藏运行命令（11-22：结束后确认退出的等待 3 秒→10 秒，机器忙时 taskkill 已成功但进程退出要 3 秒以上，会误报没结束）。超时后按 PID 结束整棵进程树再返回（原来只结束最外层的 PowerShell/cmd，安装子进程会继续跑）。
// 超时一旦触发就定局（2026-11-17 r25c）：包装进程在结束树期间先退出，它的 close 不能把结果改成「普通失败」；
// 要等 taskkill 返回、并逐个确认结束前记下的整棵树都已退出，才返回；没退出的 PID 放进 survivors，交给调用方继续占用。
function runHidden(file, args, { timeout = 60000, env, kill = killTree, tree = listTree, alive = isAlive, settleMs = 10000 } = {}) {
  return new Promise(resolve => {
    let child, done = false, timingOut = false, stdout = '', stderr = '', timer = null;
    const limit = 4 * 1024 * 1024;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); resolve({ stdout, stderr, timedOut: false, ...result }); };
    const settle = result => { if (!timingOut) finish(result); };
    try { child = spawn(file, args, { windowsHide: true, env, windowsVerbatimArguments: file.toLowerCase().endsWith('cmd.exe') }); }
    catch (error) { resolve({ code: -1, stdout: '', stderr: error.message, timedOut: false }); return; }
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', d => { if (stdout.length < limit) stdout += d; });
    child.stderr?.on('data', d => { if (stderr.length < limit) stderr += d; });
    child.on('error', error => settle({ code: -1, stderr: stderr + error.message }));
    child.on('close', code => settle({ code: typeof code === 'number' ? code : -1 }));
    timer = setTimeout(async () => {
      timingOut = true;   // 同步定局：此后 close/error 都不再结束这次调用
      const pid = child.pid;
      let pids = [pid], treeUnknown = false;
      try { pids = await tree(pid); treeUnknown = !!(pids && pids.unknown); } catch { treeUnknown = true; }
      let k;
      try { k = await kill(pid); } catch (error) { k = { ok: false, output: error.message }; }
      const survivors = await survivorsAfter([pid, ...pids], { alive, ms: settleMs }).catch(() => [pid]);
      finish({ code: 'timeout', timedOut: true, killed: !!k.ok && survivors.length === 0, killOutput: k.output, pid, tree: pids, survivors, treeUnknown });
    }, timeout);
  });
}

async function readSignature(file, { run = runHidden } = {}) {
  const script = `$s = Get-AuthenticodeSignature -LiteralPath ${psQuote(file)}; [pscustomobject]@{ status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject; issuer = [string]$s.SignerCertificate.Issuer } | ConvertTo-Json -Compress`;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 60000 });
  try { return JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop()); } catch { return null; }
}

// 安装包本身的检查：是 Windows 程序、大小在合理范围、带官方签名。
async function verifyInstaller(file, { signature = readSignature } = {}) {
  let st;
  try { st = await fsp.stat(file); } catch { throw fail('CA_INSTALL_MISSING', '安装包不见了，可能被安全软件隔离，请重新下载'); }
  if (st.size < MIN_SIZE || st.size > MAX_SIZE) throw fail('CA_INSTALL_SIZE', `安装包大小不对（${Math.round(st.size / 1024)} KB），可能下到的是公司代理的提示网页，请在官方页面重新下载`);
  const fd = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(2); await fd.read(head, 0, 2, 0);
    if (head[0] !== 0x4d || head[1] !== 0x5a) throw fail('CA_INSTALL_FORMAT', '下到的不是 Windows 安装程序，可能被公司代理换成了网页，请在官方页面重新下载');
  } finally { await fd.close(); }
  const check = acceptSignature(await signature(file));
  if (!check.ok) throw fail('CA_INSTALL_SIGNATURE', `安装包签名校验没通过（${check.reason}），已停止安装`);
  return { size: st.size };
}

// 「下载」文件夹里已有的官方安装器，按修改时间新到旧，只看文件名（签名在用之前再核）。
function findLocalInstallers({ dirs = [path.join(os.homedir(), 'Downloads')], readdir = fs.readdirSync, stat = fs.statSync } = {}) {
  const out = [];
  for (const dir of dirs) {
    let names = [];
    try { names = readdir(dir); } catch { continue; }
    for (const name of names) {
      if (!INSTALLER_RE.test(name)) continue;
      try { const st = stat(path.join(dir, name)); if (st.isFile() && st.size >= MIN_SIZE) out.push({ path: path.join(dir, name), size: st.size, mtime: st.mtimeMs }); } catch { /* 读不到就跳过 */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// 把命令行输出翻成人话。只取结论，不把原文（可能是 GBK 乱码）直接给用户看。
function explainFailure(result, stage) {
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.timedOut || result.code === 'timeout') {
    const stuck = result.killed === false ? '，但没能结束它（可能正以管理员身份运行），请等它结束或在任务管理器里结束后再试' : '并结束了这次启动的全部进程';
    return stage === 'update' ? `升级 20 分钟还没结束，已停止等待${stuck}；也可以改用「打开官方下载页」手动安装` : `安装 20 分钟还没结束，已停止等待${stuck}`;
  }
  if (/canceled by the user|已取消|操作已被用户取消|\b1223\b/i.test(text)) return '系统授权（管理员确认）被取消了。安装 CodeAgent 需要管理员权限，请再点一次并在弹框里选「是」';
  if (/\b(?:401|403)\b|unauthori[sz]ed|not logged|未登录|登录已过期|login/i.test(text)) return 'CodeAgent 还没登录或登录已过期，升级要先登录：到「账号」页登录后再点一键升级';
  if (/proxy|HIS Proxy|proxycontrolwarn|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|getaddrinfo|socket hang up|network|网络/i.test(text)) return '连不上 CodeAgent 的升级服务器，可能是没连公司网络或被公司代理拦了。确认在公司网络后重试，或改用「打开官方下载页」';
  if (/access is denied|拒绝访问|EPERM|EACCES|permission/i.test(text)) return '没有权限写入安装目录，安装需要管理员权限；请在弹出的系统授权框里选「是」，或联系 IT 开通';
  return stage === 'update' ? `升级没有成功（退出码 ${result.code}）` : `安装器没有成功（退出码 ${result.code}）`;
}

function createCodeAgentInstaller({
  dataDir,
  resolveCommand,                       // () => 当前 CodeAgent 命令（完整路径或命令名），没装返回 ''
  rediscover = async () => {},          // 安装 / 升级后让 Hub 重新找 CodeAgent
  probeVersion = async () => null,      // (command) => 版本号（要求不走缓存）
  run = runHidden,
  signature = readSignature,
  localInstallers = () => findLocalInstallers(),
  downloadPage = null,
  onState = () => {},
  now = Date.now,
  platform = process.platform,
  alive = isAlive,                      // (pid) => 进程是否还在
  kill = pid => killTree(pid),          // 按 PID 结束进程树
  waitExit = pid => new Promise(resolve => { const t = setInterval(() => { if (!alive(pid)) { clearInterval(t); resolve(); } }, 5000); }),
  settleMs = 3000,                      // 结束进程后最多等多久确认它真的退出
  unknownHoldMs = Infinity,             // 列不出进程树时保守占用多久：默认一直占到 Hub 重启（看不到后代就不放第二次升级）
} = {}) {
  let state = { phase: 'idle' };
  let lock = null;      // 当前占用：含超时后仍在跑、Hub 无权强停的安装器
  let active = null;    // 正在跑的任务结果，连点「一键安装」合并到它
  let linger = null;    // 超时后仍在跑、Hub 结束不了的安装器 / 更新器，确认退出后才释放占用
  let lingerMessage = '';
  const STILL_RUNNING = '安装器以管理员身份运行了 20 分钟还没结束，Hub 没有权限强行停止它；已停止等待，等它自己结束后会自动清理并重新查找 CodeAgent，在此之前不会再启动新的安装。也可以在任务管理器里结束 Cli 安装程序，或重启 AI HUB 后再试';
  const UPDATE_STILL_RUNNING = '升级 20 分钟还没结束，Hub 没能停下它（可能正以管理员身份运行）；已停止等待，等它自己结束后会自动重新查找 CodeAgent，在此之前不会再启动新的升级或安装。也可以在任务管理器里结束 CodeAgent 升级程序，或重启 AI HUB 后再试';
  const snapshot = () => ({ ...state });
  const set = patch => { state = { ...patch, downloadPage, at: now() }; try { onState(snapshot()); } catch { /* 界面关了不影响安装 */ } return snapshot(); };
  const jobsRoot = () => path.join(dataDir || os.tmpdir(), 'codeagent-install');

  async function finish(verb, before) {
    set({ phase: 'rediscovering', message: '正在重新查找 CodeAgent…' });
    try { await rediscover(); } catch { /* 下面按读到的版本说话 */ }
    const command = resolveCommand();
    const version = command ? await Promise.resolve(probeVersion(command)).catch(() => null) : null;
    if (!command) return set({ phase: 'error', code: 'CA_INSTALL_NOT_FOUND', error: `${verb}跑完了，但还没找到 CodeAgent`, message: `${verb}跑完了，但还没找到 CodeAgent。重启一次 AI HUB 再试；仍找不到时用「手动选择…」指定程序` });
    if (verb === '升级' && before && version && version === before) return set({ phase: 'done', upToDate: true, version, message: `CodeAgent 已是最新版 v${version}` });
    return set({ phase: 'done', version, previous: before || null, message: `CodeAgent ${verb}完成${version ? ` v${version}` : ''}${before && version && before !== version ? `（原来 v${before}）` : ''}。新建会话即可使用` });
  }

  // 超时后还活着的进程（2026-11-17 r25c）：runHidden 结束前记下的整棵树里没退出的，加上已知的安装器 PID；
  // 再按 PID 结束一次，等 settleMs 确认。返回仍在运行的 PID——非空就不能清理目录、不能释放占用。
  async function stillAlive(r, extra = []) {
    const known = [...(Array.isArray(r.survivors) ? r.survivors : (r.killed === false ? [r.pid] : [])), ...extra];
    let left = await survivorsAfter(known, { alive, ms: 0 });
    for (const pid of left) { try { await kill(pid); } catch { /* 下面按是否还活着判断 */ } }
    if (left.length) left = await survivorsAfter(left, { alive, ms: settleMs });
    // 进程树列不出来时看不到后代（如更新器拉起的提权进程），只能按「可能还在跑」限时占用（r25 三审）。
    if (r.treeUnknown) left.unknown = true;
    return left;
  }
  // 保持占用直到这些进程全部退出（后代未知时再至少等 unknownHoldMs），然后执行收尾。
  function holdUntilGone(pids, message, after) {
    lingerMessage = message;
    const waits = pids.map(pid => waitExit(pid));
    if (pids.unknown) waits.push(new Promise(resolve => { if (Number.isFinite(unknownHoldMs)) setTimeout(resolve, unknownHoldMs); }));
    linger = Promise.all(waits).then(after).catch(() => {}).finally(() => { linger = null; lingerMessage = ''; });
  }

  async function doUpgrade(command) {
    const before = await Promise.resolve(probeVersion(command)).catch(() => null);
    set({ phase: 'upgrading', from: before, message: '正在升级 CodeAgent（从官方服务器下载新版，可能要几分钟；Windows 弹出管理员确认时请选「是」）…' });
    const head = /^[A-Za-z0-9_.-]+$/.test(command) ? command : `"${String(command).replace(/"/g, '')}"`;
    const r = platform === 'win32'
      ? await run('cmd.exe', ['/d', '/s', '/c', `"call ${head} update --force"`], { timeout: UPDATE_TIMEOUT_MS })
      : await run(command, ['update', '--force'], { timeout: UPDATE_TIMEOUT_MS });
    if (r.timedOut || r.code === 'timeout') {
      // 更新器没确认退出就保持占用，不允许再点出第二次升级或安装。
      const left = await stillAlive(r);
      if (left.length || left.unknown) {
        holdUntilGone(left, UPDATE_STILL_RUNNING, () => finish('升级', before));
        throw fail('CA_UPDATE_STILL_RUNNING', UPDATE_STILL_RUNNING);
      }
    }
    if (r.code !== 0) throw fail('CA_UPDATE_FAILED', explainFailure(r, 'update'));
    return finish('升级', before);
  }

  async function doInstallFile(file, { source = 'local' } = {}) {
    set({ phase: 'verifying', source, message: '正在核对安装包的官方签名…' });
    await verifyInstaller(file, { signature });
    // 拷进 Hub 自己的一次性目录再运行：校验过的就是要运行的，期间不会被别的程序换掉；用完删掉。
    const job = path.join(jobsRoot(), 'job-' + randomUUID());
    const target = path.join(job, path.basename(file));
    let keepJob = false;
    try {
      await fsp.mkdir(job, { recursive: true });
      await fsp.copyFile(file, target);
      await verifyInstaller(target, { signature });
      set({ phase: 'installing', source, message: '正在静默安装 CodeAgent（Windows 会弹一次管理员确认，请选「是」；安装约 1–3 分钟）…' });
      // 安装器起来后先把它的进程号写进任务目录：超时时据此区分「还在等管理员确认」和「安装器在跑」（2026-11-16 r25b）。
      const pidFile = path.join(job, 'installer.pid');
      const script = `try { $p = Start-Process -FilePath ${psQuote(target)} -ArgumentList '/S' -Verb RunAs -PassThru -WindowStyle Hidden; $null = $p.Handle; Set-Content -LiteralPath ${psQuote(pidFile)} -Value $p.Id -Encoding ascii; $p.WaitForExit(); exit $p.ExitCode } catch { [Console]::Error.WriteLine($_.Exception.Message); if ($_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.Message -match 'canceled') { exit 1223 }; exit 1 }`;
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script], { timeout: INSTALL_TIMEOUT_MS });
      if (r.timedOut || r.code === 'timeout') {
        // runHidden 已按 PID 结束 PowerShell 那棵进程树，并报回没退出的进程；再加上安装器本身。
        const installerPid = Number(String(await fsp.readFile(pidFile, 'utf8').catch(() => '')).trim()) || 0;
        const left = await stillAlive(r, installerPid ? [installerPid] : []);
        if (left.length || left.unknown) {
          // 有进程 Hub 无权强停（多为管理员身份的安装器）：保留任务目录和占用，等它们都退出后再清理、再重新查找。
          keepJob = true;
          holdUntilGone(left, STILL_RUNNING, async () => {
            await fsp.rm(job, { recursive: true, force: true }).catch(() => {});
            await finish('安装', null);
          });
          throw fail('CA_INSTALL_STILL_RUNNING', STILL_RUNNING);
        }
        if (!installerPid) throw fail('CA_INSTALL_UAC_PENDING', '管理员确认框 20 分钟都没有点，已停止等待并关掉这次安装；需要时再点一次，在弹框里选「是」');
        throw fail('CA_INSTALL_TIMEOUT', explainFailure(r, 'install'));
      }
      if (r.code !== 0) throw fail(r.code === 1223 ? 'CA_INSTALL_UAC' : 'CA_INSTALL_FAILED', explainFailure(r, 'install'));
    } finally {
      if (!keepJob) await fsp.rm(job, { recursive: true, force: true }).catch(() => {});
    }
    return finish('安装', null);
  }

  // 一键入口：已装就升级；没装先用「下载」里现成的官方安装器；都没有就请用户在官方页里点下载（下载完由 installFile 接手）。
  async function perform(options = {}) {
    try {
      if (platform !== 'win32') throw fail('CA_INSTALL_PLATFORM', '一键安装只支持 Windows');
      const command = options.forceInstall ? '' : resolveCommand();
      if (command) return await doUpgrade(command);
      const local = options.file ? [{ path: options.file }] : localInstallers();
      for (const item of local.slice(0, 3)) {
        try { return await doInstallFile(item.path, { source: options.file ? (options.source || 'download') : 'local' }); }
        catch (error) { if (options.file || !/CA_INSTALL_(SIZE|FORMAT|SIGNATURE|MISSING)/.test(error.code)) throw error; }
      }
      return set({ phase: 'need-download', message: downloadPage ? '这台电脑上还没有 CodeAgent 安装包。点「打开官方下载页」，在页面里点下载，下载完成后 Hub 会自动核对并安装' : '这台电脑上还没有 CodeAgent 安装包，请先到 CodeAgent 官方渠道下载 Cli3.0-Setup.exe，放进「下载」文件夹后再点一键安装' });
    } catch (error) {
      return set({ phase: 'error', code: error.code || 'CA_INSTALL_FAILED', error: error.message, message: error.message + (downloadPage ? '。也可以点「打开官方下载页」手动下载安装' : '') });
    }
  }
  // 同一时刻只跑一个（2026-11-16 r25b）：连点「一键安装」合并到正在跑的任务；
  // 下载回来的安装包各自排队，结果只属于它自己，不拿别的任务的结果顶替。
  function enqueue(fn) {
    const prev = lock || Promise.resolve();
    const result = prev.then(() => fn());
    const mine = result.then(() => linger, () => linger).then(() => {}, () => {});
    lock = mine;
    void mine.then(() => { if (lock === mine) lock = null; });
    active = result;
    const clear = () => { if (active === result) active = null; };
    void result.then(clear, clear);
    return result;
  }
  const stillRunning = () => {
    const message = lingerMessage || STILL_RUNNING;
    return { ...state, phase: 'error', code: message === UPDATE_STILL_RUNNING ? 'CA_UPDATE_STILL_RUNNING' : 'CA_INSTALL_STILL_RUNNING', error: message, message };
  };
  return {
    snapshot,
    busy: () => !!lock,
    start: (options = {}) => linger ? Promise.resolve(stillRunning()) : active || enqueue(() => perform(options)),
    installFile: (file, options = {}) => enqueue(() => perform({ ...options, file, forceInstall: true })),
    report: patch => set(patch),
  };
}

module.exports = { createCodeAgentInstaller, runHidden, killTree, listTree, survivorsAfter, isAlive, verifyInstaller, readSignature, acceptSignature, findLocalInstallers, explainFailure, INSTALLER_RE };
