'use strict';
// 已知问题表（5.5.24 产品负责人拍板）：错误卡命中已知问题时，在标题下直接给「已知解法」，能一键做的配主按钮。
// 数据驱动：加一条就是往 KNOWN_ISSUES 里加一项；每条都注明代码里的文案依据，不凭空写。
//   areas：只在这些功能区匹配（不写 = 任何功能区）；test：匹配 标题 + 原始报错 的正则；
//   fix：一两句话的解法（可以是函数，拿到正则匹配结果，比如端口号）；action：一键动作 { label, act }，
//   act 以 known: 开头，由 renderer/hub-error-card.js 统一处理。
// 顺序就是优先级：更具体的排前面（证书被拦截排在「被公司网络拦截」前）。
// 只管「给出解法」，不改原有的报错流程；认不出的不硬套。

const CLI_NAMES = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', kimi: 'Kimi Code' };
const CLI_IDS = { 'claude code': 'claude', codex: 'codex', 'gemini cli': 'gemini', 'kimi code': 'kimi' };
function cliMissingId(m) {
  if (m[1]) return CLI_IDS[m[1].toLowerCase()] || '';
  return String(m[2] || m[3] || m[4] || '').toLowerCase();
}
function cliMissingName(m) { return m[1] || CLI_NAMES[cliMissingId(m)] || 'CLI'; }

const KNOWN_ISSUES = [
  // 终端输入框里还留着没发出去的字（renderer/renderer.js、renderer/composer-codeagent-input.js「终端输入框未能清空，请到终端确认后再发送」；
  // core/group-chat-watcher.js「终端输入行已有内容或尚未确认空白，请先在终端处理」）。同事反馈不知道「终端」在哪（2026-11-19）：
  // 按钮直接切到这个会话的后台终端。
  { id: 'terminal-input-residual',
    test: /终端输入框未能清空|终端输入行已有内容|终端消息未清空/,
    title: '终端里还有没发出去的字',
    fix: '点「去后台」切到这个会话的后台终端，看一眼输入行：没用的字按退格删掉，或按回车把它发出去；处理完回到卡片再发送。',
    action: { label: '去后台', act: 'known:open-backstage' } },
  // DSH 没配套装好（2026-11-17 起分情况讲，core/dsh-cli-profile.js describeRuntimeIssue）：只装了桌面版的单独讲清「桌面版不是终端版」。
  // 一键修复默认装 Hub 自管的运行环境、不改全局 npm；「装到我的全局 npm」才按界面包要求配套装进用户自己的目录。
  { id: 'dsh-package-mismatch',
    test: /(?:Cannot find|ERR_MODULE_NOT_FOUND|missing|未找到|找不到)[^\n]{0,180}(?:dsh-user-questions|dsh-llm-pi-ai)|DSH CLI 终端运行环境(?:不完整|.*请先安装)|找到了 DSH 桌面版[^\n]*桌面版不是终端版/i,
    title: m => /桌面版不是终端版/.test(m.input) ? '装的是 DSH 桌面版，Hub 要用终端版' : 'DSH 与终端界面包没有配套装好',
    fix: m => /桌面版不是终端版/.test(m.input)
      ? '桌面版的核心封在桌面程序里、也不带终端界面包（TUI），Hub 借用不了；你的桌面版照常可用。点「一键安装终端版」由 Hub 装一份自管的终端运行环境（约 1 分钟，不改全局 npm），装好后重新新建会话。'
      : '点「一键修复 DSH」：Hub 装一份自管的运行环境，按 @deepseek-harness-tui/dsh-tui 要求配套 @deepseek-ai/dsh 及同代插件（约 1 分钟，不改你的全局 npm），装好后重新新建会话。想装进自己的 npm 全局目录就点「装到我的全局 npm」。',
    action: { label: '一键修复 DSH', act: 'known:dsh-repair' },
    actionLabel: m => /桌面版不是终端版/.test(m.input) ? '一键安装终端版' : null,
    more: [{ label: '装到我的全局 npm', act: 'known:dsh-repair-global' }] },
  { id: 'welink-login-expired', areas: ['welink', 'hub-alert', 'notice', 'toast'],
    // core/company-assistant/welink.js「WeLink 登录已过期，Hub 正在自动续期」、service.js「WeLink 没登录或登录过期」、phone.js 同句。
    test: /WeLink\s*(?:没登录或)?登录(?:已)?过期|自动续期没成功|needs-scan/i,
    title: 'WeLink 登录过期了',
    fix: '用手机 WeLink 扫码重新登录一次；登录后助理会自动接着取数，已有内容不会丢。',
    action: { label: '扫码登录', act: 'known:welink-login' } },
  { id: 'codeagent-missing', areas: ['codeagent', 'session-create'],
    // core/community-provider.js「未找到 ${name} CLI」，renderer/codeagent-setup.js「CodeAgent 未安装」。
    test: /未找到\s*CodeAgent\s*CLI|CodeAgent\s*未安装/i,
    title: '这台电脑上没找到 CodeAgent',
    fix: '点「一键安装」：Hub 用官方安装包静默安装（Windows 会弹一次管理员确认）；本机没有安装包时会打开官方下载页，点下载后自动接着装。装在自定义位置的，到安装说明里点「手动选择…」。',
    action: { label: '一键安装', act: 'known:codeagent-oneclick' } },
  { id: 'codeagent-outdated', areas: ['codeagent'],
    // core/codeagent-version-check.js 门槛 1.2615.02.01；renderer/codeagent-version-notice.js「CodeAgent 版本较旧，卡片视图可能显示不出回答」。
    test: /CodeAgent\s*版本(?:较旧|过旧|太旧)|codeagent[^\n]{0,40}(?:outdated|too old)/i,
    title: 'CodeAgent 版本太旧',
    fix: '点「一键升级」：Hub 在后台运行 codeagent update，不弹命令行窗口；升级失败时会打开官方下载页让你下载重装。',
    action: { label: '一键升级', act: 'known:codeagent-upgrade' } },
  { id: 'cli-missing',
    // core/community-provider.js「未找到 Claude Code CLI。请从首页「安装说明」安装 …」；
    // core/group-chat-watcher.js 发送时终端停在 PowerShell「找不到命令」上（反馈 08441c2e）；
    // PowerShell 原文：中文「无法将“claude”项识别为 cmdlet…」、英文「The term 'claude' is not recognized…」、
    // 两种语言共有的「ObjectNotFound: (claude:String) [], CommandNotFoundException」（写成绝对路径时括号里是完整路径）。
    test: /未找到\s*(Claude Code|Codex|Gemini CLI|Kimi Code)\s*CLI|无法将\s*["“]?(claude|codex|gemini|kimi)["”]?\s*项识别|The term\s+'(claude|codex|gemini|kimi)'\s+is not recognized|\((?:[^()\n]*[\\/])?(claude|codex|gemini|kimi)(?:\.exe|\.cmd)?:String\)[^\n]*CommandNotFoundException/i,
    title: m => `这台电脑上没找到 ${cliMissingName(m)}`,
    fix: m => {
      const name = cliMissingName(m), id = cliMissingId(m);
      return (id === 'claude' || id === 'codex')
        ? `终端里找不到 ${name} 的程序，CLI 没启动起来，消息没有发出去。先在会话上点「重启」再试（Hub 会按检测到的完整路径启动）；还不行就点「一键安装 ${name}」（Hub 自管的一份，约 1 分钟，不改你已有的安装），装好后重启会话。`
        : `从首页「安装说明」装好 ${name}，回到新建会话点「重新检测」，再到「账号」页登录。`;
    },
    action: m => {
      const id = cliMissingId(m);
      return id === 'claude' || id === 'codex' ? { label: `一键安装 ${cliMissingName(m)}`, act: `known:cli-install:${id}` } : null;
    } },
  { id: 'claude-git-bash', areas: ['session-create', 'model-service', 'hub-alert'],
    // core/community-setup.js advisories「没找到 Git for Windows（Git Bash）…」；Claude Code 自己的「requires a shell tool. Git Bash was not found…」。
    test: /Git for Windows|git-bash|Git Bash/i,
    title: 'Claude Code 没找到 Git Bash',
    fix: '安装 Git for Windows（默认选项即可；公司版可在「环境体检」的 Git Bash 一项点「一键安装 Git for Windows」），装好后新建 Claude 会话。没有 Git 时 Claude 会改用 PowerShell，若 PowerShell 也被关掉就无法执行命令。',
    action: null },
  { id: 'company-proxy-not-ready', areas: ['company-proxy', 'session-create', 'codeagent', 'model-service', 'hub-alert'],
    // core/company-model-proxy.js「公司模型反代还没准备好，请稍等几秒再新建会话」；main/company-proxy-service.js「正在启动…」「意外退出，正在自动重启…」「公司上游还没准备好」。
    test: /公司模型反代(?:还没准备好|正在启动|意外退出，正在自动重启)|公司上游还没准备好/,
    title: '公司模型反代还在准备',
    fix: '反代刚启动或正在初始化（首次约 10–20 秒），稍等它就绪就能用；点下面的按钮会等它准备好后自动重试。',
    action: { label: '等它就绪后重试', act: 'known:proxy-wait' } },
  // 签名探测里 CodeAgent 起来后自己以非 0 退出码结束、没写签名日志（core/company-proxy/upstream-profile.mjs signerInitFailureMessage
  // 「约 N 秒后 CodeAgent 就退出了（退出码 1），未生成签名日志」；反馈 11e4dff3 等 3 人 5 条）：多半是账号本身用不了，
  { id: 'codeagent-account-unusable', areas: ['company-proxy', 'session-create', 'codeagent', 'model-service', 'hub-alert', 'notice'],
    test: /^(?![\s\S]*(?:后台进程还没确认结束|仍然没有送达))[\s\S]*首次签名初始化没完成[\s\S]{0,400}?CodeAgent 就退出了（退出码 ([1-9]\d*)），未生成签名日志/,
    title: 'CodeAgent 账号现在用不了',
    fix: m => `Hub 在后台试着启动 CodeAgent 取签名信息，它几秒后自己以退出码 ${m[1]} 结束了。最常见的原因是这个 CodeAgent 账号没登录、登录过期，或没有模型权限，光重新启动模型通道解决不了。先点「个人账号重新登录」用自己的 W3 账号登录，登录成功后点「重新启动模型通道」，再新建会话；还不行点「问问 Agent」让它看日志。`,
    action: { label: '个人账号重新登录', act: 'known:codeagent-personal-login' },
    more: [{ label: '重新启动模型通道', act: 'known:proxy-restart' }] },
  { id: 'company-proxy-failed', areas: ['company-proxy', 'session-create', 'codeagent', 'model-service', 'hub-alert', 'notice'],
    // main/company-proxy-service.js「公司模型反代没能启动」「反复退出，已停止自动重启」；core/company-proxy/server.mjs「公司模型反代启动失败：」。
    test: /^(?![\s\S]*(?:后台进程还没确认结束|仍然没有送达))[\s\S]*(?:公司模型反代(?:没能启动|反复退出|启动失败)|首次签名初始化没完成|CodeAgent 未收到签名初始化所需的测试输入)/,
    title: '公司模型反代没能启动',
    fix: '先重新启动一次反代；还不行就点「问问 Agent」让它看反代日志找原因。',
    action: { label: '重新启动模型通道', act: 'known:proxy-restart' } },
  { id: 'update-corrupt', areas: ['app-update'],
    // core/app-update/downloader.js「文件校验不一致」「文件不完整」「文件大小不对」。
    test: /文件校验不一致|文件不完整|文件大小不对|收到的内容比应有的/,
    title: '更新包下载得不完整',
    fix: '下载过程中内容被截断或改动了，重新下载一次即可（会自动换下一个更新源），已有的程序不受影响。',
    action: { label: '重新下载', act: 'known:update-redownload' } },
  { id: 'cert-intercepted',
    // core/app-update/downloader.js「证书校验失败（可能被公司代理拦截了加密连接）」。
    test: /证书校验失败|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|CERT_HAS_EXPIRED|self[- ]signed certificate/i,
    title: '加密连接被拦截了',
    fix: '公司代理替换了网站证书。换到能直连的网络再试，或先在浏览器里打开一次这个地址完成放行。',
    action: null },
  { id: 'update-blocked', areas: ['app-update'],
    // core/app-update/downloader.js「收到的是网页…可能被公司代理拦截」；renderer/app-update.js「被公司网络拦截了，可以手动放行」。
    test: /可能被公司代理拦截|被公司网络拦截/,
    title: '更新源被公司网络拦住了',
    fix: '在更新窗口里点被拦网址旁的「在浏览器打开」，在网页上点允许放行，回来点「重新检查」。',
    action: { label: '重新检查', act: 'known:update-check' } },
  { id: 'port-in-use',
    // main/lan-pool-service.js「共享端口已被其他程序占用；关闭共享后换一个端口」；core/company-proxy/server.mjs 遇 EADDRINUSE 换端口。
    test: /EADDRINUSE[^\n]*?:(\d{2,5})\b|端口\s*(\d{2,5})?\s*(?:已)?被(?:其他程序)?占用|EADDRINUSE/i,
    title: m => (m[1] || m[2] ? `端口 ${m[1] || m[2]} 被别的程序占着` : '端口被别的程序占着'),
    fix: m => {
      const port = m[1] || m[2];
      return port
        ? `在 PowerShell 运行 Get-NetTCPConnection -LocalPort ${port} | Select OwningProcess 查出占用它的进程号，到任务管理器「详细信息」里按这个号找到程序关掉；常见是上次没退干净的同一个程序。`
        : '关掉重复打开的同类程序（常见是上次没退干净的同一个程序），或换一个端口后再试。';
    },
    action: null },
  { id: 'codeagent-quota', areas: ['codeagent', 'model-service'],
    // renderer/turn-error-help.js 真实样本「API Error token消耗过快， 已达到4亿上限」。
    test: /token\s*消耗\s*过快|已\s*达\s*到\s*4\s*亿\s*上\s*限/i,
    title: '这个 CodeAgent 账号今天的额度用完了',
    fix: '到「账号」页换一个还有额度的号继续，或等第二天 0 点额度恢复；对话不会丢。',
    action: { label: '打开账号页', act: 'known:open-accounts' } },
  { id: 'account-unavailable', areas: ['session-create', 'codeagent'],
    // renderer/workspace-controller.js「所选账号当前不可用，请到「账号」页登录或恢复使用后再试」。
    test: /所选账号当前不可用/,
    title: '选中的账号现在用不了',
    fix: '到「账号」页重新登录这个号，或在新建会话里换一个可用的号。',
    action: { label: '打开账号页', act: 'known:open-accounts' } },
];

function matchKnownIssue({ area = '', title = '', details = '', cause = '' } = {}) {
  const text = [title, cause, details].map(v => String(v || '')).join('\n').slice(0, 6000);
  if (!text.trim()) return null;
  for (const issue of KNOWN_ISSUES) {
    if (issue.areas && area && !issue.areas.includes(area)) continue;
    const m = issue.test.exec(text);
    if (!m) continue;
    const pick = v => (typeof v === 'function' ? v(m) : v);
    const action = pick(issue.action);
    return { id: issue.id, title: pick(issue.title), fix: pick(issue.fix), action: action ? { ...action,...(issue.actionLabel && pick(issue.actionLabel) ? { label: pick(issue.actionLabel) } : {}) } : null,
      more: (issue.more || []).map(a => ({ ...a })) };
  }
  return null;
}

module.exports = { KNOWN_ISSUES, matchKnownIssue };
