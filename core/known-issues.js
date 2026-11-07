'use strict';
// 已知问题表（5.5.24 产品负责人拍板）：错误卡命中已知问题时，在标题下直接给「已知解法」，能一键做的配主按钮。
// 数据驱动：加一条就是往 KNOWN_ISSUES 里加一项；每条都注明代码里的文案依据，不凭空写。
//   areas：只在这些功能区匹配（不写 = 任何功能区）；test：匹配 标题 + 原始报错 的正则；
//   fix：一两句话的解法（可以是函数，拿到正则匹配结果，比如端口号）；action：一键动作 { label, act }，
//   act 以 known: 开头，由 renderer/hub-error-card.js 统一处理。
// 顺序就是优先级：更具体的排前面（证书被拦截排在「被公司网络拦截」前）。
// 只管「给出解法」，不改原有的报错流程；认不出的不硬套。

const KNOWN_ISSUES = [
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
    fix: '按安装说明装好 CodeAgent，回来点「重新检测」；装在自定义位置的，重启一次 AI HUB 再检测。',
    action: { label: '查看安装说明', act: 'known:codeagent-install' } },
  { id: 'codeagent-outdated', areas: ['codeagent'],
    // core/codeagent-version-check.js 门槛 1.2615.02.01；renderer/codeagent-version-notice.js「CodeAgent 版本较旧，卡片视图可能显示不出回答」。
    test: /CodeAgent\s*版本(?:较旧|过旧|太旧)|codeagent[^\n]{0,40}(?:outdated|too old)/i,
    title: 'CodeAgent 版本太旧',
    fix: '运行 codeagent update 升级（或到 CSOP 软件中心下载 Cli3.0-Setup.exe 重装），升级后重启 AI HUB。',
    action: { label: '一键升级', act: 'known:codeagent-upgrade' } },
  { id: 'cli-missing',
    // core/community-provider.js「未找到 Claude Code CLI。请从首页「安装说明」安装 …」。
    test: /未找到\s*(Claude Code|Codex|Gemini CLI|Kimi Code)\s*CLI/i,
    title: m => `这台电脑上没找到 ${m[1]}`,
    fix: m => `从首页「安装说明」装好 ${m[1]}，回到新建会话点「重新检测」，再到「账号」页登录。`,
    action: null },
  { id: 'claude-git-bash', areas: ['session-create', 'model-service', 'hub-alert'],
    // core/community-setup.js advisories：「Claude Code 在 Windows 上需要 Git for Windows（Git Bash）」。
    test: /Git for Windows|git-bash|Git Bash/i,
    title: 'Claude Code 缺少 Git Bash',
    fix: '安装 Git for Windows（默认选项即可），装好后重启 AI HUB，Claude 会话才能执行工具。',
    action: null },
  { id: 'company-proxy-not-ready', areas: ['company-proxy', 'session-create', 'codeagent', 'model-service', 'hub-alert'],
    // core/company-model-proxy.js「公司模型反代还没准备好，请稍等几秒再新建会话」；main/company-proxy-service.js「正在启动…」「意外退出，正在自动重启…」「公司上游还没准备好」。
    test: /公司模型反代(?:还没准备好|正在启动|意外退出，正在自动重启)|公司上游还没准备好/,
    title: '公司模型反代还在准备',
    fix: '反代刚启动或正在初始化（首次约 10–20 秒），稍等它就绪就能用；点下面的按钮会等它准备好后自动重试。',
    action: { label: '等它就绪后重试', act: 'known:proxy-wait' } },
  { id: 'company-proxy-failed', areas: ['company-proxy', 'session-create', 'codeagent', 'model-service', 'hub-alert'],
    // main/company-proxy-service.js「公司模型反代没能启动」「反复退出，已停止自动重启」；core/company-proxy/server.mjs「公司模型反代启动失败：」。
    test: /公司模型反代(?:没能启动|反复退出|启动失败)/,
    title: '公司模型反代没能启动',
    fix: '先重新启动一次反代；还不行就点「问问 Agent」让它看反代日志找原因。',
    action: { label: '重新启动反代', act: 'known:proxy-restart' } },
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
    return { id: issue.id, title: pick(issue.title), fix: pick(issue.fix), action: issue.action ? { ...issue.action } : null };
  }
  return null;
}

module.exports = { KNOWN_ISSUES, matchKnownIssue };
