'use strict';

// 新建会话的结果判定（2026-11-23，一键反馈：会话已建成、侧栏可见，却弹「创建失败」，用户以为没建成又点一次）。
// 规则：拿到会话（创建调用返回了会话，或收到带本次请求标识的 session-created 事件）就算建成；
// 之后哪一步没成只给一行提示，说清是哪一步、会话可以直接用、下一步做什么。真没建成才说「创建失败」。

const IPC_PREFIX = /Error invoking remote method '[^']+': (?:Error: )?/;

function errorText(error) {
  const raw = error && error.message ? error.message : String(error || '');
  return raw.replace(IPC_PREFIX, '').trim() || '未知原因';
}

// 本次创建请求自己的标识：随创建请求发给主进程，主进程在 session-created 事件里原样带回。
function newCreateRequestId(cryptoImpl = globalThis.crypto) {
  if (cryptoImpl && typeof cryptoImpl.randomUUID === 'function') return cryptoImpl.randomUUID();
  return `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// 创建调用报错时，只认带着本次请求标识的 session-created 事件；别的会话（哪怕同目录同种类）一律不算。
function matchCreatedSession(events, requestId) {
  if (!requestId) return null;
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i];
    if (event && event.createRequestId === requestId && event.session && event.session.id) return event.session;
  }
  return null;
}

// 附属步骤没成时给用户的下一步。
function nextStep(step, message) {
  if (/公司模型|反代|签名|模型通道|SIGNER/i.test(message)) return { text: '如果发消息没有回应，点旁边的「重新启动模型通道」再发。', actions: ['open-session', 'proxy-restart'] };
  if (step === 'tap') return { text: '终端里照常可用，聊天卡片可能不刷新，点「打开会话」到终端里看。', actions: ['open-session'] };
  if (step === 'remember') return { text: '不影响使用，只是下次新建时要重新选一次。', actions: ['open-session'] };
  return { text: '如果发消息没有回应，点「打开会话」看终端里的提示。', actions: ['open-session'] };
}

const STEP_LABEL = {
  launch: '启动后的收尾步骤',
  tap: '对话记录接入',
  remember: '记住本次的选择',
};

/**
 * @param {{ session?: object|null, error?: unknown, followup?: { step: string, error: unknown }|null }} input
 * @returns {{ state: 'created'|'created-partial'|'failed', session: object|null, message: string, actions: string[] }}
 */
function classifyCreateOutcome({ session = null, error = null, followup = null } = {}) {
  if (session && session.id) {
    if (!followup) return { state: 'created', session, message: '', actions: [] };
    // 一行提示：多行原因只取第一行（完整原因仍在控制台）。
    const why = errorText(followup.error).split(/\r?\n/)[0].replace(/[。.\s]+$/, '');
    const label = STEP_LABEL[followup.step] || followup.step || '附属步骤';
    const next = nextStep(followup.step, why);
    return { state: 'created-partial', session, actions: next.actions,
      message: `会话已建好，可以直接用；${label}没成：${why}。${next.text}` };
  }
  return { state: 'failed', session: null, message: `创建失败：${errorText(error)}`, actions: [] };
}

module.exports = { classifyCreateOutcome, matchCreatedSession, newCreateRequestId, errorText };
