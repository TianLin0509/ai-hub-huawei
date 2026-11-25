'use strict';

// CodeAgent 在终端里报了会话级错误（还没调到模型就被拒），原生记录里没有这一条，卡片视图就一直空着、
// 像「没有回复」。2026-11-17 反馈的真实样本（CodeAgent 1.2615.02.03 终端画面）：
//   ✗ SessionRequestError
//   部门已启用外部模型管控，外部模型不可用。请联系部门管理员关闭管控，或申请开通内部模型。 [SessionRequestError_002]
// 主进程定时读回合进行中的 CodeAgent 屏幕：出现一条新的这种报错（上一次读屏时还没有），就结束这一轮，
// 把报错原文交给界面显示。全屏界面会重绘旧报错，所以按「这条报错在屏幕上出现的次数变多」才算新的。
// 可信仓限制暂无 CLI 原文：只在明确的错误标题下按关键词兜底，普通回答不参与匹配。
const { isCodeAgentKind } = require('./ai-kinds.js');
const { classifyCodeAgentError } = require('./codeagent-model-revoked.js');

const CHECK_MS = 10_000;
// 是否值得重放终端的粗筛（2026-11-25 开销修复收紧）：必须覆盖 findScreenErrors 能认出的全部报错——
// SessionRequestError 标题，以及 codeagent-model-revoked.js 可信仓规则里的关键词。去掉了单独的「信任」，
// 只留「不受/未受/未被信任」；补上以前漏掉的「可信目录」和英文「not trusted」写法。
const HEAD_WORDS = /SessionRequestError|RiskControl|可信(?:仓|目录)|(?:不受|未受|未被)信任|风控|trusted\s+(?:repo|director)|(?:not|n't)\s+trusted/i;
// 只扫新增输出时往回多看的字符：关键词或 ANSI 序列可能正好被上一次读屏切在中间
const OVERLAP_CHARS = 64;
const stripAnsi = text => String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
const ERROR_HEADS = /^\s*[✗✘×]\s*(SessionRequestError)\s*$/;
const POLICY_HEAD = /^\s*(?:[✗✘×]\s*|(?:error|错误|失败)\s*[:：]\s*)(.*)$/i;

const strip = row => String(row || '').replace(/^\s*[│┃|]\s?/, '').replace(/\s*[│┃|]\s*$/, '').trim();

/** 从屏幕行里找出全部会话级报错：[{ name, message }]，按出现顺序。 */
function findScreenErrors(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  let inCodeBlock = false;
  for (let i = 0; i < list.length; i++) {
    const row = strip(list[i]);
    if (/^\s*```/.test(row)) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock || /^\s*>/.test(row)) continue;
    const head = ERROR_HEADS.exec(row);
    const policyHead = !head && POLICY_HEAD.exec(row);
    if (!head && !policyHead) continue;
    // 独立错误只读取限制本身；测试失败清单等普通内容不能吸入后面的讲解。
    if (policyHead?.[1] && classifyCodeAgentError(policyHead[1])?.kind !== 'trusted-repo-required'
        && !/^(?:[A-Za-z][\w-]*(?:Error|Exception)(?:_\d+)?|风控(?:错误|拦截))$/.test(policyHead[1])) continue;
    const parts = policyHead?.[1] ? [policyHead[1]] : [];
    // 模型权限提示在窄终端里会折成多行，错误块仍以空行或下一个错误标题结束。
    for (let j = i + 1; j < list.length && j <= i + 8; j++) {
      const line = strip(list[j]);
      if (!line) { if (parts.length) break; continue; }
      if (ERROR_HEADS.test(line) || POLICY_HEAD.test(line)) break;
      parts.push(line);
    }
    const message = parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (message) {
      const name = head ? head[1] : 'TrustedRepoError';
      const classified = classifyCodeAgentError(`${name} ${message}`, { source: 'codeagent-screen-error' });
      if (!head && classified?.kind !== 'trusted-repo-required') continue;
      const modelRevoked = classified?.kind === 'model-revoked' ? classified : null;
      const trustedRepoRequired = classified?.kind === 'trusted-repo-required' ? classified : null;
      out.push({ name, message, ...(modelRevoked ? { modelRevoked } : {}), ...(trustedRepoRequired ? { trustedRepoRequired } : {}) });
    }
  }
  return out;
}

/** 给用户看的一句话：原文加上「这是公司侧的限制」之类的处理提示。 */
function describeScreenError({ name, message, trustedRepoRequired }) {
  if (trustedRepoRequired) return trustedRepoRequired.reason;
  const policy = /外部模型管控|不允许使用外部模型|内部模型/.test(message);
  const hint = policy ? '这是公司侧的模型管控，Hub 绕不过去：请联系部门管理员关闭管控，或在 CodeAgent 里换成允许使用的内部模型后再发。'
    : '这一轮没有发到模型，请按提示处理后再发。';
  return `CodeAgent 报错（${name}）：${message} ${hint}`;
}

function createScreenErrorWatch({ manager, readScreen, renderRows, onError, intervalMs = CHECK_MS, now = () => Date.now(),
  setTimer = setInterval, clearTimer = clearInterval }) {
  // sessionId -> { outputAt, counts: Map(signature -> count), chars（累计输出字符数）, len（缓冲长度）, hot（上一屏上有没有关键词）, pty（读屏时的终端进程） }
  const seen = new Map();
  let timer = null, busy = false;
  async function check(sessionId, entry) {
    const outputAt = Number(entry.lastOutputAt) || 0;
    // 没读过的会话，基线是空屏（r38b 审查 P1：新会话发出去 10 秒内就报错时，第一次读屏已经带着这条错，
    // 旧做法把第一次读屏当基线，这条错就永远漏报）。会话的终端缓冲每次随 Hub 新起的终端从空开始、不落盘，
    // 这类报错也不进原生记录（恢复旧会话时重放的历史里没有它），所以屏幕上的报错都是这次运行里这个会话自己产生的；
    // 不在回合中的会话照样每次有新输出就读，旧报错在下一轮开始前就进了基线。
    // 会话原地重启（同一 sessionId 换了新终端进程，累计输出字符数从 0 重计）：旧进程的记录作废，按新会话从空屏算起
    const cachedPrev = seen.get(sessionId);
    const prev = cachedPrev && cachedPrev.pty === entry.pty ? cachedPrev : { outputAt: NaN, counts: new Map() };
    if (prev.outputAt === outputAt) return;
    const raw = readScreen(sessionId);
    if (!raw || !raw.text) { seen.set(sessionId, { outputAt, counts: prev.counts, pty: entry.pty }); return; }
    // 2026-11-25 开销修复：以前只要关键词还留在最近 300 KB 缓冲里，会话每有一点新输出就整段重放终端（约 15 ms/次），
    // 关键词滚出缓冲前能持续几十分钟。渲染只取最后一屏，所以只在两种情况下重放：
    //   1. 自上次读屏以来的新增输出里出现关键词（按会话累计输出字符数定位新增部分；拿不到就照旧看最近 300 KB）；
    //   2. 上一次渲染出的那一屏上还挂着关键词（报错可能还在屏上、正被重绘或补全后续行）。
    // 两者都没有时，屏幕上不可能出现新报错，上一屏也没有报错，计数照旧为空。
    const text = String(raw.text);
    const chars = Number(entry.outputChars);
    const delta = Number.isFinite(chars) && Number.isFinite(prev.chars) && chars >= prev.chars && text.length >= prev.len ? chars - prev.chars : Infinity;
    const scope = text.slice(-Math.min(300000, delta + OVERLAP_CHARS));
    let errors = [], hot = false;
    if (prev.hot || HEAD_WORDS.test(stripAnsi(scope))) {
      const rows = await renderRows(raw);
      // 窄屏折行时关键词会跨行：去掉盒子边框后再拼一遍看
      const stripped = rows.map(strip);
      hot = HEAD_WORDS.test(stripped.join('\n')) || HEAD_WORDS.test(stripped.join(''));
      errors = findScreenErrors(rows);
    }
    const counts = new Map();
    for (const e of errors) { const k = e.name + '\n' + e.message; counts.set(k, (counts.get(k) || 0) + 1); }
    seen.set(sessionId, { outputAt, counts, chars, len: text.length, hot, pty: entry.pty });
    // 不在回合中读到的报错只记进基线：下一轮开始时屏幕上原有的报错不算那一轮的。
    if (!entry.agentTurnActive) return;
    const fresh = errors.filter(e => { const k = e.name + '\n' + e.message; return (counts.get(k) || 0) > (prev.counts.get(k) || 0); }).at(-1);
    if (!fresh) return;
    const failedAt = now(), message = describeScreenError(fresh);
    if (manager.noteAgentTurnFinished(sessionId, { failedAt, message })) {
      try { onError({ sessionId, failedAt, kind: entry.info.kind, message, name: fresh.name, modelRevoked: fresh.modelRevoked || null, trustedRepoRequired: fresh.trustedRepoRequired || null }); } catch { /* 只影响提示 */ }
    }
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      for (const [sessionId, entry] of manager.sessions) {
        const info = entry && entry.info;
        if (!info || info.agentRuntime !== 'pty' || !isCodeAgentKind(info.kind) || /^(dormant|closed)$/.test(String(info.status || ''))) {
          seen.delete(sessionId);
          continue;
        }
        try { await check(sessionId, entry); } catch { /* 读屏失败只影响这一次 */ }
      }
      for (const id of seen.keys()) if (!manager.sessions.has(id)) seen.delete(id);
    } finally { busy = false; }
  }
  return {
    start() { if (!timer) { timer = setTimer(() => { void tick(); }, intervalMs); timer?.unref?.(); } },
    stop() { if (timer) { clearTimer(timer); timer = null; } },
    tick,
  };
}

module.exports = { createScreenErrorWatch, findScreenErrors, describeScreenError, CHECK_MS };
