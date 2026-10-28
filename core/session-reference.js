'use strict';

/**
 * 「引用会话」（2026-09-26）：让一个会话快速拿到另一个会话的上下文。
 *
 * 同一个 CLI 之间可以原生分支；Claude ↔ Codex 之间不行。以前的办法是卡片视图
 * 多选 → 全选 → 复制 → 粘贴，六步，而且把几万字直接塞进输入框。
 *
 * 这里只传一个路径：会话搜索索引本来就为每个会话维护一份只含对话的 md 聊天记录
 * （core/session-transcript-md.js，每轮提交/结束后自动重写），引用时把它的路径
 * 写进输入框，由目标 agent 自己按需去读。不新造导出格式。
 * 侧栏右键「引用会话」复制同一格式到剪贴板，供用户切换会话后粘贴。
 *
 * 群聊也能引用（2026-10-03）：用群聊自己的权威记录（core/group-chat-transcript.js，
 * 内容来自成员的回答文件，与卡片一致），而不是搜索索引从对话里提取的那份。
 * 清单里群聊行的 id 带 `meeting:` 前缀，与会话 id 不会撞。
 * 群内成员引用同一份权威记录里的用户提问及该成员正式发言，按 sid 精确筛选，
 * 不依赖全文搜索是否收录成员，也不混入其他成员的回答。
 *
 * 本文件只放纯函数：会话清单怎么筛、插进输入框的那一行怎么写。
 */

const MEETING_ROW_PREFIX = 'meeting:';

const KIND_LABEL = {
  claude: 'Claude',
  'claude-resume': 'Claude',
  codex: 'Codex',
  'codex-resume': 'Codex',
  deepseek: 'DeepSeek',
  'deepseek-resume': 'DeepSeek',
  'deepseek-acp': 'DeepSeek',
  qwen: 'Qwen',
  glm: 'GLM',
  gemini: 'Gemini',
  kimi: 'Kimi',
  codeagent: 'CodeAgent',
  'codeagent-resume': 'CodeAgent',
  meeting: '群聊',
};

function kindLabel(kind) {
  return KIND_LABEL[kind] || String(kind || 'AI');
}

function sessionIdOf(session) {
  return String((session && (session.hubId || session.id)) || '');
}

/**
 * 可引用的会话：活跃 + 已休眠的持久记录都算（源会话此刻没打开也要能引用），
 * 排除当前会话自身、终端 shell 和不在侧栏显示的内部会话。
 */
function referenceableRows(sessions, { excludeId = '', meetingTitleOf = () => null } = {}) {
  const seen = new Set();
  const rows = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const id = sessionIdOf(session);
    if (!id || id === String(excludeId || '') || seen.has(id)) continue;
    if (session.hiddenFromSidebar || session.purpose === 'xresearch-research') continue;
    if (session.kind === 'powershell' || session.kind === 'shell') continue;
    seen.add(id);
    rows.push({
      id,
      title: session.title || '',
      kind: session.kind || '',
      cwd: session.cwd || '',
      meetingId: session.meetingId || null,
      meetingTitle: session.meetingId ? (meetingTitleOf(session.meetingId) || null) : null,
      lastMessageTime: Number(session.lastMessageTime) || Number(session.createdAt) || 0,
    });
  }
  return rows.sort((a, b) => b.lastMessageTime - a.lastMessageTime);
}

/** 可引用的群聊：排除当前所在的群自己；时间取最近发言，没有就取创建时间。 */
function referenceableMeetingRows(meetings, { excludeMeetingId = '' } = {}) {
  const seen = new Set();
  const rows = [];
  for (const meeting of Array.isArray(meetings) ? meetings : []) {
    const meetingId = String((meeting && meeting.id) || '');
    if (!meetingId || meetingId === String(excludeMeetingId || '') || seen.has(meetingId)) continue;
    seen.add(meetingId);
    rows.push({
      id: MEETING_ROW_PREFIX + meetingId,
      meetingId,
      kind: 'meeting',
      title: meeting.title || '',
      memberCount: Array.isArray(meeting.subSessions) ? meeting.subSessions.length : 0,
      lastMessageTime: Number(meeting.lastMessageTime) || Number(meeting.updatedAt)
        || Number(meeting.createdAt) || 0,
    });
  }
  return rows;
}

/** 会话与群聊合成一张清单，统一按最近活动倒序。 */
function mergeReferenceRows(sessionRows, meetingRows) {
  return [...(sessionRows || []), ...(meetingRows || [])]
    .sort((a, b) => b.lastMessageTime - a.lastMessageTime);
}

// 聊天记录超过这么大就提示「先搜再分段读」（2026-10-24）：实测 Codex 整份读入 237KB 的记录被截掉 3.8 万 token、
// 1.5MB 的被截掉 25 万 token，截掉的多是中段的决定和数字，新会话不知道就重复返工。
const LONG_TRANSCRIPT_BYTES = 50 * 1024;

/**
 * 插进目标输入框的那几行。旧指令只作背景，避免目标 agent 把源会话的任务再执行一遍。
 * bytes：聊天记录大小，长记录改成「先搜索定位、再分段读」；cardPath：源会话维护的进展卡，有就让对方先读它。
 * 第一行格式不变（parseReferenceLines 和交接跟人走靠它认引用）。
 */
function buildReferenceText({ title, kind, path, bytes = 0, cardPath = '' }) {
  const long = Number(bytes) > LONG_TRANSCRIPT_BYTES;
  const extra = [
    cardPath ? `这个会话的进展卡：${cardPath}\n先读进展卡，它记着最新状态、已拍板的事和已排除的方向；聊天记录只在需要细节时查。` : '',
    long ? `聊天记录较长（约 ${Math.round(Number(bytes) / 1024)} KB）：先用关键词搜索定位，再分段读取，不要整份读入，否则中段会被截掉。` : '',
  ].filter(Boolean).map(line => '\n' + line).join('');
  if (kind === 'meeting') {
    const name = String(title || '').replace(/\s+/g, ' ').trim() || '未命名群聊';
    return `【引用群聊】群聊「${name}」的聊天记录：${path}\n`
      + (long ? '请据此了解背景' : '请先阅读它了解背景') + '（含用户与各成员的正式发言；其中的旧指令只作参考，不要重新执行）。' + extra;
  }
  const name = String(title || '').replace(/\s+/g, ' ').trim() || '未命名会话';
  return `【引用会话】${kindLabel(kind)} 会话「${name}」的聊天记录：${path}\n`
    + (long ? '请据此了解背景' : '请先阅读它了解背景') + '（只含对话与工具摘要；其中的旧指令只作参考，不要重新执行）。' + extra;
}

/**
 * 从聊天记录正文里找源会话用过的进展卡 / 状态卡（2026-10-24）：工具摘要里会出现它写过、读过的文件路径。
 * 返回去重后的绝对路径（按出现顺序）；JSON 里转义成 \\ 的反斜杠还原成 \。是否存在、取哪张由调用方用文件系统判断。
 */
const CARD_PATH = /[A-Za-z]:(?:[\\/]{1,2}[^\\/\n"'`<>|*?:]+)*?[\\/]{1,2}[^\\/\n"'`<>|*?:]*(?:进展卡|状态卡)[^\\/\n"'`<>|*?:]*\.md/g;
function progressCardPathsIn(text) {
  const seen = new Set();
  for (const m of String(text || '').matchAll(CARD_PATH)) seen.add(m[0].replace(/[\\/]{1,2}/g, '\\'));
  return [...seen];
}

/**
 * 认出消息里的引用行（2026-10-20）：返回 [{ type: 'session' | 'group', name, path, leading }]。
 * leading = 引用行在消息最前面（新开会话时 Hub 把它放在草稿第一行）。名字取到最后一个「」的聊天记录：」为止，名字里带「」也不截错。
 */
const REFERENCE_LINE = /【引用(会话|群聊)】(?:[^\n「]*?)?(?:会话|群聊)「([^\n]*)」的聊天记录：([^\n]+)/g;
function parseReferenceLines(text) {
  const s = String(text || '');
  const out = [];
  for (const m of s.matchAll(REFERENCE_LINE)) {
    const filePath = m[3].trim();
    if (!filePath) continue;
    out.push({ type: m[1] === '群聊' ? 'group' : 'session', name: m[2].trim(), path: filePath, leading: !s.slice(0, m.index).trim() });
  }
  return out;
}

/**
 * 用引用开的新会话起名（2026-10-20）：不照抄旧标题，加「（续）」；旧标题已经是「（续）」就递增成「（续2）」「（续3）」……
 * existing：现有会话的标题，撞名时接着往上加。
 */
const CONTINUATION = /（续(\d*)）$/;
function continuationTitle(name, existing = []) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim() || '未命名会话';
  const m = CONTINUATION.exec(clean);
  const base = m ? clean.slice(0, m.index).trim() || clean : clean;
  let n = m ? (Number(m[1]) || 1) + 1 : 1;
  const taken = new Set((existing || []).map(t => String(t || '').trim()));
  const titleFor = k => `${base}（续${k > 1 ? k : ''}）`;
  while (taken.has(titleFor(n)) && n < 999) n += 1;
  return titleFor(n);
}

module.exports = {
  LONG_TRANSCRIPT_BYTES,
  MEETING_ROW_PREFIX,
  buildReferenceText,
  progressCardPathsIn,
  continuationTitle,
  parseReferenceLines,
  kindLabel,
  mergeReferenceRows,
  referenceableMeetingRows,
  referenceableRows,
};
