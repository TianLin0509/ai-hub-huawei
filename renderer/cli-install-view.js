'use strict';
// 启动中心「一键安装」的界面文字（2026-11-07）：把安装器状态（core/cli-tools/installer.js）翻成人话。
// 只做纯函数，弹窗怎么接线见 renderer/company-api-settings.js。

const TOOL_FOR_KIND = Object.freeze({ claude: 'claude', codex: 'codex', 'deepseek-acp': 'dsh' });
const TOOL_NAMES = Object.freeze({ claude: 'Claude Code', codex: 'Codex', dsh: 'DSH 运行环境', git: 'Git for Windows' });
const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mb = bytes => (Math.max(0, Number(bytes) || 0) / 1024 / 1024).toFixed(1);

// 一个工具当前的进度：text 一句话；percent 0–100（不确定时为 null）；busy 正在跑；retry 可以重试。
function progressView(tool) {
  const t = tool || { phase: 'idle' };
  const step = t.step && t.step.count > 1 ? `（第 ${t.step.index}/${t.step.count} 项：${t.step.name}）` : '';
  const percent = t.total > 0 ? Math.min(100, Math.round((t.received || 0) / t.total * 100)) : null;
  switch (t.phase) {
    case 'checking': return { text: '正在读取组件目录…', percent: null, busy: true };
    case 'downloading': return { text: `下载中 ${mb(t.received)} / ${mb(t.total)} MB${step}${t.sourceName ? ` · 来自${t.sourceName}` : ''}`, percent, busy: true };
    case 'verifying': return { text: `正在校验文件…${step}`, percent, busy: true };
    case 'installing': return { text: `正在安装${t.files ? `（已解压 ${t.files} 个文件）` : ''}…${step}`, percent, busy: true };
    case 'probing': return { text: `正在试运行，确认能启动…${step}`, percent, busy: true };
    case 'done': return { text: '安装完成', percent: 100, busy: false, done: true };
    case 'cancelled': return { text: '已取消，可以重新安装', percent: null, busy: false, retry: true };
    case 'error': return { text: '安装没有成功：' + (t.error || '未知原因'), percent: null, busy: false, retry: true,
      blocked: t.blocked || null };
    default: return { text: '', percent: null, busy: false };
  }
}

const sizeText = (state, id) => {
  const entry = (state.catalog || []).find(c => c.id === id);
  return entry && entry.bytes ? `约 ${Math.max(1, Math.round(entry.bytes / 1024 / 1024))} MB` : '';
};

// Claude Code 区块下面的 Git for Windows 小节（2026-11-07）。state.git 有值 = 本机已找到 Git Bash，不再提示。
// 点「一键安装」时 Hub 先全局找一遍，本机已有就直接用（tools.git.found），没有才下载。
function gitBlockHtml(state) {
  if (!state || !state.available) return '';
  const tool = state.tools && state.tools.git || { phase: 'idle' };
  if (tool.phase === 'done') {
    const text = tool.found ? `这台电脑已经有 Git Bash（${tool.found}），不用重复安装，Claude 会话会直接用它。` : 'Git for Windows 已装好，新建的 Claude 会话会用它执行命令。';
    return `<div class="cli-install cli-install-git" data-cli-tool="git" data-cli-phase="done"><p class="cli-install-status" role="status">${esc(text)}</p></div>`;
  }
  if (state.git && !['checking', 'downloading', 'verifying', 'installing', 'probing'].includes(tool.phase)) return '';
  const view = progressView(tool);
  const size = sizeText(state, 'git');
  const otherBusy = state.busy && state.busy !== 'git';
  const intro = '<p class="cli-install-intro">建议同时装 Git for Windows：Claude Code 优先用它自带的 bash 执行命令，没有时改用 PowerShell（官方预览功能，复杂命令偶尔不如 bash 顺手）。'
    + `点一键安装时 Hub 先在这台电脑上全局找一遍，已有就直接用；没有才下载${esc(size ? '（' + size + '）' : '')}，装在你的用户目录，不需要管理员权限。</p>`;
  const button = view.busy ? '<button type="button" data-cli-action="cancel">取消</button>'
    : `<button type="button" data-cli-action="install-git"${otherBusy ? ' disabled' : ''}>${view.retry ? '重试安装 Git' : '一键安装 Git for Windows'}</button>`;
  const bar = view.busy ? `<div class="cli-install-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"${view.percent == null ? '' : ` aria-valuenow="${view.percent}"`}><span style="width:${view.percent == null ? 100 : view.percent}%"${view.percent == null ? ' data-indeterminate="1"' : ''}></span></div>` : '';
  const status = view.text ? `<p class="cli-install-status" role="status" aria-live="polite">${esc(tool.phase === 'checking' ? '正在全局查找本机的 Git，没有再下载…' : view.text)}</p>` : '';
  return `<div class="cli-install cli-install-git" data-cli-tool="git" data-cli-phase="${esc(tool.phase || 'idle')}">${view.busy ? '' : intro}${bar}${status}`
    + `<div class="cli-install-actions">${button}</div></div>`;
}

// 弹窗里的一键安装区块。state：cli-tools:state 的快照；没有下载源时返回空串，弹窗只留手动安装说明。
function installBlockHtml(kind, state) {
  const id = TOOL_FOR_KIND[kind];
  if (!id || !state || !state.available) return '';
  const tool = state.tools && state.tools[id];
  const view = progressView(tool);
  const entry = (state.catalog || []).find(c => c.id === id);
  const size = entry && entry.bytes ? `（约 ${Math.max(1, Math.round(entry.bytes / 1024 / 1024))} MB${id === 'dsh' ? '，没有 Node.js 时另加约 30 MB' : ''}）` : '';
  const otherBusy = state.busy && state.busy !== id;
  const intro = `<p class="cli-install-intro">Hub 替你下载并装好 ${esc(TOOL_NAMES[id])}${esc(size)}：装在你自己的用户目录，不需要管理员权限，也不用去官网。</p>`;
  const label = view.retry ? '重试' : '一键安装';
  const button = view.done ? ''
    : view.busy ? '<button type="button" data-cli-action="cancel">取消</button>'
    : `<button type="button" class="primary" data-cli-action="install"${otherBusy ? ' disabled' : ''}>${label}</button>`;
  const bar = view.busy || view.done
    ? `<div class="cli-install-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"${view.percent == null ? '' : ` aria-valuenow="${view.percent}"`}><span style="width:${view.percent == null ? 100 : view.percent}%"${view.percent == null ? ' data-indeterminate="1"' : ''}></span></div>` : '';
  const blocked = view.blocked ? `<p class="cli-install-note">公司网络可能拦截了下载地址：可在浏览器里打开 <code>${esc(view.blocked)}</code>，点「允许」后回来点「重试」。</p>` : '';
  const busyNote = otherBusy ? `<p class="cli-install-note">正在安装${esc(TOOL_NAMES[state.busy] || '其他组件')}，装完再装这个。</p>` : '';
  const git = id === 'claude' ? gitBlockHtml(state) : '';
  const advice = !git && view.done && state.advice && state.advice[id] ? `<p class="cli-install-note">${esc(state.advice[id])}</p>` : '';
  return `<div class="cli-install" data-cli-tool="${id}" data-cli-phase="${esc(tool && tool.phase || 'idle')}">${view.done ? '' : intro}${bar}`
    + `<p class="cli-install-status" role="status" aria-live="polite">${esc(view.text)}</p>${blocked}${busyNote}${advice}`
    + `${button ? `<div class="cli-install-actions">${button}</div>` : ''}</div>${git}`;
}

module.exports = { TOOL_FOR_KIND, TOOL_NAMES, progressView, installBlockHtml, gitBlockHtml };
