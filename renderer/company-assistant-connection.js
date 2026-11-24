'use strict';

// Current auth is authoritative. A saved snapshot is not a fresh login check.
function connectionState(data = {}) {
  if (!data.cliFound) {
    const search = data.cliSearch || {}, install = data.cliInstall || {};
    if (['checking', 'downloading', 'verifying'].includes(install.phase)) return { kind: 'searching', title: '正在安装 WeLink 连接工具', detail: install.message || '正在安装，完成后会继续登录。', action: '', label: '' };
    // 全盘查找可能要一两分钟（实测约 2 分钟）；能一键安装时不把按钮藏起来：安装会先等这次查找，找到已装的就直接用。
    if (search.state === 'searching') return data.cliInstallAvailable
      ? { kind: 'searching', title: '正在查找 WeLink 连接工具', detail: '后台正在各个硬盘里找已经装好的 welink-cli，可能要一两分钟。不想等可以直接点一键安装：找到已装的就直接用，没有再装。', action: 'install-cli', label: '一键安装' }
      : { kind: 'searching', title: '正在查找 WeLink 连接工具', detail: '后台正在查找 welink-cli，找到后会继续检查连接。', action: '', label: '' };
    if (data.cliInstallAvailable && search.state !== 'searching') {
      const failed = install.phase === 'error';
      return { kind: 'missing', title: failed ? 'WeLink 工具安装没成功' : '先接入 WeLink', detail: failed ? `${install.error} 可以重试，或手动选择已经安装的工具。` : '这台电脑还没有 welink-cli，它负责读取当前账号可见的消息、会议和邮件。点一键安装即可，不需要 Node，也不需要管理员权限。', action: 'install-cli', label: failed ? '重试安装' : '一键安装', alt: 'find-cli', altLabel: '已安装，重新检测' };
    }
    if (search.state === 'error') return { kind: 'missing', title: 'WeLink 工具查找未完成', detail: search.error || '查找出错，可重试或手动选择已经安装的工具。', action: 'find-cli', label: '重新查找' };
    return { kind: 'missing', title: '先接入 WeLink', detail: '尚未检测到 welink-cli。它负责读取当前账号可见的消息、会议和邮件。', action: 'find-cli', label: '已安装，重新检测' };
  }
  const auth = data.auth || {}, login = auth.login;
  if (auth.state === 'online' && login?.ok) return { kind: 'online', title: 'WeLink 已连接', detail: '可以查询当前账号可见的工作信息。', action: 'refresh', label: '刷新工作信息' };
  if (auth.state === 'renewing') return { kind: 'renewing', title: '正在维护 WeLink 登录', detail: '正在尝试自动续期，结果会显示在这里。', action: '', label: '' };
  if (auth.state === 'signed-out') return { kind: 'login', title: '已退出 WeLink 登录', detail: '你在设置里退出了登录，助理暂停读取 WeLink。需要时扫码重新登录。', action: 'login', label: '扫码登录' };
  if (auth.state === 'needs-scan' || login?.reason === 'expired') return { kind: 'login', title: auth.state === 'needs-scan' ? '自动续期没成功，点这里扫码登录' : '登录 WeLink 后继续', detail: auth.renewCause?.text || '登录已失效或尚未登录，请用 WeLink 扫码确认。', action: 'login', label: '扫码登录' };
  // 认不出登录状态时也给扫码入口（2026-11-06）：以前只有「重新检查」，CLI 一改措辞就没法登录。
  return { kind: 'unknown', alt: 'login', altLabel: '扫码登录', title: 'WeLink 连接尚未确认', detail: auth.error || login?.error || '工具已找到，还需要确认登录状态。若检查失败，请核对公司网络和工具是否可运行。', action: 'refresh', label: '重新检查并取数' };
}

// 输入框左上的一行状态（11-21 全新用户深查 #12）：按实际能不能答显示，不在什么都没接时写「已就绪」。
// 助理靠本机 CodeAgent 作答；codeagentInstalled 为 false 时说清没装、给安装入口。WeLink 没接上时说明只能讨论已有材料，入口同连接提示。
// 返回 { text, busy, tone, action, label }；action 为空时不放按钮。
function composerState(data = {}, { codeagentInstalled = null } = {}) {
  if (data.job) {
    const text = (data.job.type === 'brief' ? '助理正在整理今天的摘要…' : '助理正在回答…') + (data.queued ? `（还有 ${data.queued} 个排队）` : '');
    return { text, busy: true, tone: '', action: '', label: '' };
  }
  // 助理用部门 API key 作答时不靠 CodeAgent（core/assistant-gateway-route.js），没装 CodeAgent 也能问。
  if (codeagentInstalled === false && !data.answerRoute) {
    return { text: '还不能提问：这台电脑没找到 CodeAgent，助理靠它回答', busy: false, tone: 'bad', action: 'install-codeagent', label: '安装 CodeAgent' };
  }
  const c = connectionState(data);
  if (c.kind !== 'online') {
    return { text: 'WeLink 还没接上：可以提问，但只能讨论已有材料，查不到消息、会议和邮件', busy: false, tone: 'warn', action: c.action || '', label: c.label || '' };
  }
  return { text: '已就绪 · 只读，草稿你自己发', busy: false, tone: '', action: '', label: '' };
}

module.exports = { connectionState, composerState };
