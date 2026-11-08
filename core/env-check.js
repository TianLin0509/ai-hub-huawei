'use strict';
// 环境体检（5.5.24，产品负责人拍板）：一屏列出 Hub 依赖的外部工具和本机条件是绿/黄/红，红黄项给出原因和修复入口。
// 这里只放「查什么、怎么判、怎么写成人话」，具体的检测都复用现有模块（community-setup、welink、PPT Doctor、
// CodeAgent 版本检查、公司模型反代、一键更新）；主进程（main/ipc/env-check-handlers.js）把这些模块的实例注进来。
//
// 规矩：各项并行、各自限时（单项最长约 8 秒），一项卡住只把那一项标成「没查完」，不拖整页；
// 只读——不登录、不安装、不改设置；起的子进程一律隐藏窗口（windowsHide），超时只结束自己起的那一个进程树。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ITEM_TIMEOUT_MS = 8000;
const STATUS = Object.freeze({ ok: 'ok', warn: 'warn', bad: 'bad', off: 'off' });
const STATUS_LABEL = Object.freeze({ ok: '正常', warn: '注意', bad: '有问题', off: '不适用' });
const GB = 1024 * 1024 * 1024;

// ---------- 通用小工具 ----------

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    // 不 unref：单项卡住时这个计时器是唯一能让整页按时返回的东西，unref 后进程可能先于它退出（CI 实测出现过）。最长 8 秒，结束即清。
    new Promise(resolve => { timer = setTimeout(() => resolve(onTimeout()), ms); }),
  ]);
}

const VERSION_RE = /(\d+\.\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?)/;
function parseVersion(text) {
  const clean = String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const m = VERSION_RE.exec(clean);
  return m ? m[1] : '';
}

// 跑「程序 --version」：隐藏窗口；.cmd/.bat 经 cmd.exe 原样传命令行；超时只按 PID 结束自己刚起的这一棵进程树。
function runVersion(file, { args = ['--version'], timeoutMs = 6000, env = process.env, execFileImpl } = {}) {
  const { execFile } = require('node:child_process');
  const run = execFileImpl || execFile;
  return new Promise(resolve => {
    let child = null, done = false, timer = null;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const callback = (error, stdout, stderr) => {
      const version = parseVersion(String(stdout || '') + '\n' + String(stderr || ''));
      finish(version ? { ok: true, version } : { ok: false, error: error ? (error.code === 'ENOENT' ? '程序打不开' : `命令没跑成（退出码 ${error.code ?? '未知'}）`) : '版本号没读出来' });
    };
    try {
      if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(file)) {
        const line = `"call "${String(file).replace(/"/g, '')}" ${args.join(' ')}"`;
        child = run('cmd.exe', ['/d', '/s', '/c', line], { windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8', env, maxBuffer: 256 * 1024 }, callback);
      } else {
        child = run(file, args, { windowsHide: true, encoding: 'utf8', env, maxBuffer: 256 * 1024 }, callback);
      }
    } catch (error) { finish({ ok: false, error: '程序打不开：' + error.message }); return; }
    timer = setTimeout(() => {
      finish({ ok: false, error: `${Math.round(timeoutMs / 1000)} 秒没返回版本号` });
      const pid = child && child.pid;
      if (pid && process.platform === 'win32') {
        try { require('node:child_process').execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch { /* 已退出 */ }
      } else { try { child?.kill(); } catch { /* 已退出 */ } }
    }, timeoutMs);
    // 不 unref：这个计时器负责让卡住的读版本按时返回，unref 后进程可能先于它退出（11-07 CI 实测）。
  });
}

function fmtGb(bytes) { return (bytes / GB).toFixed(bytes >= 100 * GB ? 0 : 1) + ' GB'; }

// ---------- 结果条目 ----------
// { id, name, status, detail, cause?, steps?, fixes?: [{ label, act, url? }], raw?, area }
// area 对应统一错误卡（renderer HubErrorCard）的功能区，便于「问问 Agent」「一键反馈」带上下文。
function entry(id, name, area, status, detail, extra = {}) {
  return { id, name, area, status, detail: String(detail || ''), ...extra };
}
const RECHECK = { label: '重新检测', act: 'recheck' };

// ---------- 各项检测 ----------
// ctx：主进程注入的依赖，见 main/ipc/env-check-handlers.js。都可以缺省，缺了就跳过对应项。

function probeList(ctx) {
  const setup = ctx.setup || require('./community-setup');
  const env = ctx.env || process.env;
  const platform = ctx.platform || process.platform;
  const kindAllowed = ctx.kindAllowed || (() => true);
  const isCompany = !!ctx.isCompany;
  const assistant = ctx.assistant ? ctx.assistant() : null;
  const versionOf = ctx.runVersion || runVersion;
  const installAct = isCompany ? { label: '去一键安装', act: 'open-cli-install' } : null;
  const probes = [];
  const add = (id, name, area, run) => probes.push({ id, name, area, run });

  // WeLink、PPT Doctor 只在公司版助理存在时检测（没有助理的版本不出这两项）。
  if (assistant) {
    add('welink', 'welink-cli', 'welink', async () => {
      const cli = assistant.cli();
      if (!cli) {
        return entry('welink', 'welink-cli', 'welink', STATUS.bad, '没找到 welink-cli', {
          cause: 'Hub 在常见的 npm 全局目录和 PATH 里都没找到它；刚装完没重启 Hub 时也会这样。',
          steps: ['确认这台电脑已经装好 welink-cli（公司软件中心或 npm 全局安装）', '点「再找一次」，Hub 会在后台把各个盘找一遍', '还找不到就到助理页手动选择程序位置'],
          fixes: [{ label: '再找一次', act: 'welink-find' }, { label: '去助理页', act: 'open-assistant' }],
        });
      }
      const [ver, login] = await Promise.all([
        assistant.rawWelink(['--version'], { timeoutMs: 6000 }).then(r => parseVersion(r.stdout)).catch(() => ''),
        readWelinkLogin(assistant),
      ]);
      const where = `${ver ? 'v' + ver + ' · ' : ''}${cli}`;
      if (login.ok) return entry('welink', 'welink-cli', 'welink', STATUS.ok, `已登录 · ${where}`);
      if (login.reason === 'expired') {
        return entry('welink', 'welink-cli', 'welink', STATUS.warn, `找到了，但 WeLink 登录已过期 · ${where}`, {
          cause: 'WeLink 的登录令牌过期或作废了，助理取不到消息、会议和邮件。',
          steps: ['到助理页左栏点 WeLink 一行「扫码登录」', '用手机 WeLink 扫码确认'],
          fixes: [{ label: '扫码登录', act: 'open-assistant' }],
        });
      }
      return entry('welink', 'welink-cli', 'welink', STATUS.warn, `找到了，但暂时确认不了登录状态 · ${where}`, {
        cause: login.error || 'welink-cli 的登录状态输出一时没认出来，通常过一会儿就好。',
        steps: ['稍后点「重新检测」', '一直这样就到助理页看 WeLink 一行'],
        fixes: [RECHECK, { label: '去助理页', act: 'open-assistant' }], raw: login.raw || '',
      });
    });

    add('ppt-doctor', 'PPT Doctor', 'ppt-doctor', async () => {
      const doctor = assistant.ppt?.doctor;
      if (!doctor) return entry('ppt-doctor', 'PPT Doctor', 'ppt-doctor', STATUS.off, '这个版本没有 PPT 素材库');
      const st = await doctor.status({ force: true });
      // status 里的 version 是 PPT Doctor 内置检索引擎的版本（如 0.4.0），程序版本在 doctorVersion；先认程序版本，和工具自动发现一致。
      const ver = st.doctorVersion || st.appVersion || st.version || '';
      const download = { label: '下载 PPT Doctor', act: 'ppt-download' };
      if (st.state === 'ready' || st.state === 'empty') {
        return entry('ppt-doctor', 'PPT Doctor', 'ppt-doctor', STATUS.ok, `${ver ? 'v' + ver + ' · ' : ''}${st.state === 'empty' ? '已安装，还没有建素材库' : '已安装，能联动'}`);
      }
      if (st.state === 'missing') {
        return entry('ppt-doctor', 'PPT Doctor', 'ppt-doctor', STATUS.warn, '没装 PPT Doctor（用 PPT 素材库和图片转可编辑时才需要）', {
          cause: '在开始菜单、注册表和默认安装位置都没找到它。', steps: ['点「下载 PPT Doctor」安装', '装好后点「重新检测」'], fixes: [download, RECHECK],
        });
      }
      if (st.state === 'upgrade') {
        return entry('ppt-doctor', 'PPT Doctor', 'ppt-doctor', STATUS.warn, `版本太旧，和 Hub 联动不上${ver ? '（v' + ver + '）' : ''}`, {
          cause: st.error || '装的 PPT Doctor 缺少和 Hub 联动所需的能力标记。', steps: ['点「下载 PPT Doctor」装最新版', '装好后点「重新检测」'], fixes: [download, RECHECK], raw: st.error || '',
        });
      }
      return entry('ppt-doctor', 'PPT Doctor', 'ppt-doctor', STATUS.warn, '找到了，但这次没能读出它的状态', {
        cause: st.error || 'PPT Doctor 没有正常回应。', steps: ['稍后点「重新检测」', '一直这样就重新安装 PPT Doctor'], fixes: [RECHECK, download], raw: st.error || '',
      });
    });
  }

  if (kindAllowed('codeagent')) {
    add('codeagent', 'CodeAgent', 'codeagent', async () => {
      const found = setup.findCommand('codeagent', env, platform);
      const check = ctx.codeagentVersionCheck || require('./codeagent-version-check');
      const downloadFix = check.DOWNLOAD_PAGE ? [{ label: '打开下载页', act: 'open-url', url: check.DOWNLOAD_PAGE }] : [];
      if (!found) {
        if (!isCompany) return entry('codeagent', 'CodeAgent', 'codeagent', STATUS.off, '没装（只有公司电脑需要）');
        return entry('codeagent', 'CodeAgent', 'codeagent', STATUS.bad, '没找到 CodeAgent', {
          cause: 'PATH 里没有 codeagent 命令，或设置里写的程序位置不存在。CodeAgent 会话、助理、公司模型都要用到它。',
          steps: ['到公司软件中心安装 CodeAgent 3.0', '装好后重启 Hub，或点「重新检测」', '装在非默认位置时，到 CodeAgent 设置里填程序位置'],
          fixes: [...downloadFix, { label: '打开 CodeAgent 设置', act: 'open-codeagent' }, RECHECK],
        });
      }
      const command = ctx.codeagentCommand ? ctx.codeagentCommand() : 'codeagent';
      let version = '', error = '';
      try { version = await (ctx.codeagentVersion || require('./codeagent-version-probe').codeagentVersion)(command); } catch (e) { error = e.message; }
      if (!version) {
        return entry('codeagent', 'CodeAgent', 'codeagent', STATUS.warn, `找到了，但版本号没读出来 · ${found}`, {
          cause: error || '运行「codeagent --version」没有得到版本号。', steps: ['稍后点「重新检测」', '在命令行里运行 codeagent --version 看是否正常'], fixes: [RECHECK], raw: error,
        });
      }
      if (check.isOutdated(version)) {
        return entry('codeagent', 'CodeAgent', 'codeagent', STATUS.warn, `v${version} 太旧，最低要 v${check.MIN_VERSION}`, {
          cause: '旧版 CodeAgent 下卡片视图不显示回答（新版才有 Hub 读取的会话记录）。',
          steps: ['在命令行运行 codeagent update，或到软件中心下载最新安装包', '升级后点「重新检测」'], fixes: [...downloadFix, RECHECK],
        });
      }
      return entry('codeagent', 'CodeAgent', 'codeagent', STATUS.ok, `v${version} · ${found}`);
    });
  }

  for (const [id, name, docs] of [['claude', 'Claude Code', 'https://code.claude.com/docs/en/setup'], ['codex', 'Codex', 'https://developers.openai.com/codex/cli/']]) {
    if (!kindAllowed(id)) continue;
    add(id, name, 'env-check', async () => {
      const found = setup.findCommand(id, env, platform);
      if (!found) {
        return entry(id, name, 'env-check', STATUS.warn, `没装（要用 ${name} 会话时再装）`, {
          cause: `PATH、npm 全局目录和 Hub 一键安装的位置里都没有 ${name}。`,
          steps: installAct ? [`点「去一键安装」装 ${name}`, '装好后点「重新检测」'] : [`按官方说明安装 ${name}`, '装好后点「重新检测」'],
          fixes: [installAct || { label: '打开安装说明', act: 'open-url', url: docs }, RECHECK],
        });
      }
      const v = await versionOf(found, { env });
      return entry(id, name, 'env-check', v.ok ? STATUS.ok : STATUS.warn, `${v.ok ? 'v' + v.version : '找到了，但版本号没读出来'} · ${found}`,
        v.ok ? {} : { cause: v.error, steps: ['稍后点「重新检测」'], fixes: [RECHECK], raw: v.error });
    });
  }

  if (kindAllowed('deepseek-acp')) {
    add('dsh', 'DSH（DeepSeek 终端）', 'env-check', async () => {
      const config = ctx.getConfig ? ctx.getConfig() : {};
      let runtime = null, error = '';
      try { runtime = (ctx.resolveDsh || require('./dsh-cli-profile').resolveDshCliRuntime)(config?.acp?.providers?.['deepseek-acp'], env); } catch (e) { error = e.message; }
      if (!runtime) {
        return entry('dsh', 'DSH（DeepSeek 终端）', 'env-check', STATUS.warn, '没装（要用 DeepSeek · DSH 会话时再装）', {
          cause: error || '没找到 DSH 的终端运行环境。', steps: installAct ? ['点「去一键安装」装 DSH', '装好后点「重新检测」'] : ['用 npm 全局安装 @deepseek-ai/dsh 和 @deepseek-harness-tui/dsh-tui', '装好后点「重新检测」'],
          fixes: [...(installAct ? [installAct] : []), RECHECK], raw: error,
        });
      }
      let ver = '';
      try { ver = JSON.parse(fs.readFileSync(path.join(runtime.modules, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version || ''; } catch { /* 读不到版本不影响结论 */ }
      return entry('dsh', 'DSH（DeepSeek 终端）', 'env-check', STATUS.ok, `${ver ? 'v' + ver + ' · ' : ''}${runtime.root}`);
    });
  }

  if (platform === 'win32') {
    add('git-bash', 'Git Bash', 'env-check', async () => {
      // 先全局找（注册表、各硬盘、VS / GitHub Desktop 自带的），找到就不提示安装，免得重复装。
      const hit = setup.searchGitBash ? await setup.searchGitBash(env, { force: true, timeoutMs: 6000 }) : null;
      const bash = hit ? hit.bash : setup.findGitBash(env);
      if (bash) return entry('git-bash', 'Git Bash', 'env-check', STATUS.ok, hit && hit.source === 'hub' ? `${bash}（Hub 装的）` : bash);
      const claude = kindAllowed('claude') && setup.findCommand('claude', env, platform);
      const install = isCompany ? [{ label: '一键安装 Git for Windows', act: 'git-install' }] : [];
      return entry('git-bash', 'Git Bash', 'env-check', STATUS.warn, claude ? '没找到 Git Bash，Claude 会改用 PowerShell 执行命令（建议安装）' : '没找到 Git Bash（只有 Claude Code 用得上）', {
        cause: 'Claude Code 在 Windows 上优先用 Git for Windows 自带的 bash 执行命令；没有时改用 PowerShell（官方预览功能，复杂命令偶尔不如 bash 顺手）。',
        steps: [isCompany ? '点「一键安装 Git for Windows」，或自己安装 Git for Windows（默认选项即可）' : '安装 Git for Windows（默认选项即可）', '装好后点「重新检测」'],
        fixes: [...install, { label: '打开下载页', act: 'open-url', url: 'https://git-scm.com/download/win' }, RECHECK],
      });
    });
  }

  add('node', 'Node.js', 'env-check', async () => {
    const node = setup.findCommand('node', env, platform);
    if (!node) {
      return entry('node', 'Node.js', 'env-check', STATUS.warn, '没找到（welink-cli 和部分组件需要它）', {
        cause: 'PATH 里没有 node 命令。Hub 本身不需要，但用 npm 装的命令行工具要靠它运行。',
        steps: ['安装 Node.js 22 或更新的长期支持版', '装好后重启 Hub'], fixes: [{ label: '打开下载页', act: 'open-url', url: 'https://nodejs.org/zh-cn/download' }, RECHECK],
      });
    }
    const v = await versionOf(node, { env });
    const major = Number(String(v.version || '').split('.')[0]);
    if (v.ok && major && major < 18) {
      return entry('node', 'Node.js', 'env-check', STATUS.warn, `v${v.version} 太旧 · ${node}`, {
        cause: '一些命令行工具要求 Node.js 18 以上。', steps: ['安装 Node.js 22 或更新的长期支持版'], fixes: [{ label: '打开下载页', act: 'open-url', url: 'https://nodejs.org/zh-cn/download' }, RECHECK],
      });
    }
    return entry('node', 'Node.js', 'env-check', v.ok ? STATUS.ok : STATUS.warn, `${v.ok ? 'v' + v.version : '版本号没读出来'} · ${node}`, v.ok ? {} : { fixes: [RECHECK], raw: v.error });
  });

  if (ctx.proxy) {
    add('company-proxy', '公司模型反代', 'company-proxy', async () => {
      const p = ctx.proxy();
      if (!p) return entry('company-proxy', '公司模型反代', 'company-proxy', STATUS.off, '这个版本没有公司模型');
      const fix = [{ label: '重新启动反代', act: 'proxy-restart' }, { label: '打开设置', act: 'open-company-api' }];
      const s = p.status || {};
      if (!p.enabled && (s.state === 'stopped' || !s.state)) return entry('company-proxy', '公司模型反代', 'company-proxy', STATUS.off, '没有工具选「公司模型」，不需要启动');
      if (s.state === 'running') return entry('company-proxy', '公司模型反代', 'company-proxy', STATUS.ok, `已就绪${s.port ? ' · 本机端口 ' + s.port : ''}${s.mock ? '（模拟上游）' : ''}`);
      if (s.state === 'starting' || s.state === 'draining') return entry('company-proxy', '公司模型反代', 'company-proxy', STATUS.warn, s.message || '正在启动', { fixes: [RECHECK] });
      if (s.state === 'not-ready') {
        return entry('company-proxy', '公司模型反代', 'company-proxy', STATUS.warn, s.message || '已启动，但公司上游还没准备好', {
          cause: '反代在跑，但连公司模型服务还没成功（首次签名初始化约 10–20 秒；区域选错或登录过期也会这样）。',
          steps: ['等半分钟后点「重新检测」', '一直不好就打开设置看区域和登录', '再不行点「重新启动反代」'], fixes: [RECHECK, ...fix], raw: s.code || '',
        });
      }
      return entry('company-proxy', '公司模型反代', 'company-proxy', STATUS.bad, s.message || '没能启动', {
        cause: '反代进程起不来或反复退出，选了「公司模型」的会话会发不出消息。',
        steps: ['点「重新启动反代」', '还不行就点「一键反馈」，诊断包里带日志'], fixes: fix, raw: s.message || '',
      });
    });
  }

  if (ctx.appUpdate) {
    add('app-update', '一键更新下载源', 'app-update', async () => {
      const controller = ctx.appUpdate();
      if (!controller || typeof controller.probeSources !== 'function') return entry('app-update', '一键更新下载源', 'app-update', STATUS.off, '这个版本没有一键更新');
      const r = await controller.probeSources({ timeoutMs: 7000 });
      const ok = r.sources.filter(s => s.ok), bad = r.sources.filter(s => !s.ok);
      const latest = ok.map(s => s.version).filter(Boolean).sort((a, b) => require('./app-update/manifest').compareVersions(b, a))[0];
      const failText = bad.map(s => `${s.name}：${s.blocked ? '被公司网络的确认页挡住' : s.reason || '连不上'}`).join('；');
      if (!r.sources.length) return entry('app-update', '一键更新下载源', 'app-update', STATUS.off, '没有配置下载源');
      if (!ok.length) {
        return entry('app-update', '一键更新下载源', 'app-update', STATUS.bad, '所有下载源都连不上', {
          cause: failText, steps: ['检查网络或代理', '被确认页挡住时，打开「检查更新」按提示放行', '稍后点「重新检测」'], fixes: [{ label: '打开检查更新', act: 'open-update' }, RECHECK], raw: failText,
        });
      }
      const head = `${ok.map(s => s.name).join('、')} 连得上${latest ? ' · 最新 v' + latest : ''}`;
      if (bad.length) return entry('app-update', '一键更新下载源', 'app-update', STATUS.warn, `${head}；${failText}`, { cause: '有一个下载源连不上，更新会自动改用能连上的那个。', fixes: [RECHECK], raw: failText });
      return entry('app-update', '一键更新下载源', 'app-update', STATUS.ok, head);
    });
  }

  if (ctx.dataDir) {
    add('disk', '磁盘剩余空间', 'env-check', async () => {
      const st = await fs.promises.statfs(ctx.dataDir);
      const free = Number(st.bavail) * Number(st.bsize);
      const where = `数据目录所在盘还剩 ${fmtGb(free)}`;
      if (free < 1 * GB) return entry('disk', '磁盘剩余空间', 'env-check', STATUS.bad, where, { cause: '空间不到 1 GB，会话记录、更新包和截图可能写不进去。', steps: ['清理这块盘上的大文件或回收站', '清理后点「重新检测」'], fixes: [{ label: '打开数据目录', act: 'open-data-dir' }, RECHECK] });
      if (free < 5 * GB) return entry('disk', '磁盘剩余空间', 'env-check', STATUS.warn, where, { cause: '空间不到 5 GB，一键更新和长会话可能不够用。', steps: ['有空时清理一下这块盘'], fixes: [{ label: '打开数据目录', act: 'open-data-dir' }, RECHECK] });
      return entry('disk', '磁盘剩余空间', 'env-check', STATUS.ok, where);
    });

    add('data-dir', '数据目录可写', 'env-check', async () => {
      const probe = path.join(ctx.dataDir, `.env-check-${process.pid}-${Date.now()}.tmp`);
      try {
        await fs.promises.mkdir(ctx.dataDir, { recursive: true });
        await fs.promises.writeFile(probe, 'ok');
        await fs.promises.unlink(probe);
        return entry('data-dir', '数据目录可写', 'env-check', STATUS.ok, ctx.dataDir);
      } catch (error) {
        try { await fs.promises.unlink(probe); } catch { /* 没写成就没有文件 */ }
        return entry('data-dir', '数据目录可写', 'env-check', STATUS.bad, `写不进去 · ${ctx.dataDir}`, {
          cause: error.code === 'EACCES' || error.code === 'EPERM' ? '没有写入权限，可能被安全软件或公司策略拦了。' : error.code === 'ENOSPC' ? '盘满了。' : '写测试文件失败。',
          steps: ['确认这个目录没有被设成只读', '检查安全软件是否拦截了 AI Hub', '处理后点「重新检测」'], fixes: [{ label: '打开数据目录', act: 'open-data-dir' }, RECHECK], raw: `${error.code || ''} ${error.message}`.trim(),
        });
      }
    });
  }
  return probes;
}

// WeLink 登录状态：助理刚查过（10 分钟内）就用它的结论，否则只读地查一次 auth status（不触发登录）。
async function readWelinkLogin(assistant) {
  try {
    const auth = assistant.auth?.status?.() || {};
    if (auth.state === 'online' && auth.login?.ok) return { ok: true };
    const r = await assistant.rawWelink(['auth', 'status'], { timeoutMs: 6000 });
    const text = String(r.stdout || '') + '\n' + String(r.stderr || '');
    const login = require('./company-assistant/welink').loginState(text);
    if (login.ok) return { ok: true };
    return { ok: false, reason: login.reason, error: r.code ? `登录状态查询失败（退出码 ${r.code}）` : '', raw: text.trim().slice(0, 400) };
  } catch (error) { return { ok: false, reason: 'unknown', error: error.message, raw: error.message }; }
}

// 各项并行跑、各自限时；一项抛错或超时只影响它自己。
async function runEnvCheck(ctx = {}, { timeoutMs = ITEM_TIMEOUT_MS, now = Date.now } = {}) {
  const startedAt = now();
  const probes = probeList(ctx);
  const items = await Promise.all(probes.map(async probe => {
    const t0 = now();
    const fallback = () => entry(probe.id, probe.name, probe.area, STATUS.warn, `${Math.round(timeoutMs / 1000)} 秒内没查完`, {
      cause: '这一项的检测卡住了（程序没回应或网络慢），其他项不受影响。', steps: ['稍后点「重新检测」'], fixes: [RECHECK], timedOut: true });
    let result;
    try { result = await withTimeout(Promise.resolve().then(probe.run), timeoutMs, fallback); }
    catch (error) {
      result = entry(probe.id, probe.name, probe.area, STATUS.warn, '这一项没查成', { cause: error.message, steps: ['稍后点「重新检测」'], fixes: [RECHECK], raw: String(error.stack || error.message || error).slice(0, 600) });
    }
    return { ...result, ms: now() - t0 };
  }));
  const counts = { ok: 0, warn: 0, bad: 0, off: 0 };
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
  return { at: startedAt, ms: now() - startedAt, version: ctx.version || '', items, counts };
}

// ---------- 复制给别人看的纯文本（脱敏） ----------

function sanitize(text, { home = os.homedir(), user = safeUser() } = {}) {
  let s = String(text == null ? '' : text);
  if (home) {
    const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')]);
    for (const v of variants) if (v && v.length > 3) s = s.split(v).join('~').replace(new RegExp(escapeRe(v), 'gi'), '~');
  }
  if (user && user.length >= 3) s = s.replace(new RegExp(`(^|[\\\\/\\s:：(（])${escapeRe(user)}(?=$|[\\\\/\\s.,，)）])`, 'gi'), '$1<用户>');
  return s
    .replace(/\b(?:sk|pk|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{8,}\b/g, '<密钥>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <密钥>')
    .replace(/([?&](?:token|key|sig|signature|code|auth)=)[^&\s]+/gi, '$1<略>')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<邮箱>')
    .replace(/\bUID\s*[:：]\s*[A-Za-z0-9_-]+/gi, 'UID: <略>');
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function safeUser() { try { return os.userInfo().username || ''; } catch { return ''; } }

const MARK = { ok: '[正常]', warn: '[注意]', bad: '[有问题]', off: '[不适用]' };
function formatReport(result, options = {}) {
  const pad = n => String(n).padStart(2, '0');
  const d = new Date(result.at || Date.now());
  const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const c = result.counts || {};
  const lines = [`AI Hub 环境体检${result.version ? ' · v' + result.version : ''} · ${when}`,
    `结果：正常 ${c.ok || 0} · 注意 ${c.warn || 0} · 有问题 ${c.bad || 0}${c.off ? ' · 不适用 ' + c.off : ''}`, ''];
  const order = { bad: 0, warn: 1, ok: 2, off: 3 };
  for (const item of [...(result.items || [])].sort((a, b) => order[a.status] - order[b.status])) {
    lines.push(`${MARK[item.status] || '[?]'} ${item.name}：${item.detail}`);
    if (item.status !== 'ok' && item.status !== 'off' && item.cause) lines.push(`    原因：${item.cause}`);
    if (item.status !== 'ok' && item.status !== 'off' && item.raw) lines.push(`    原始信息：${String(item.raw).replace(/\s+/g, ' ').slice(0, 240)}`);
  }
  lines.push('', `系统：Windows ${os.release()} · ${os.arch()}`);
  return sanitize(lines.join('\n'), options);
}

module.exports = { ITEM_TIMEOUT_MS, STATUS, STATUS_LABEL, runEnvCheck, probeList, formatReport, sanitize, parseVersion, runVersion, withTimeout };
