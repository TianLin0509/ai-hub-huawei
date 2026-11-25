'use strict';
// 会议问答「看后台」抽屉（右栏内，不跳页）：这题用了什么引擎/模型/档位、逐条过程、stderr 尾巴、超时和退出码。
// 数据来自 IPC company-assistant:meeting-question-log（契约第 6 节）；老后端没有这个接口时，只用题目上已有的持久字段，
// 并写明「详细记录需新版后端」。纯函数，页面负责挂载与刷新。
const { questionStatus, engineText, SPEED_LABEL, chars, seconds, isInFlight, askedAt } = require('./company-meeting-chat');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = at => { if (!Number.isFinite(at)) return ''; const d = new Date(at), p = n => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const KIND_LABEL = { step: '步骤', event: '事件', stdout: '输出', stderr: '错误输出', exit: '退出', timeout: '超时' };
const MODE_LABEL = { fresh: '不分叉理解会话（只带纪要 + 最近原话）', fork: '分叉理解会话' };

// 这个错误是不是「后端还没有这个接口」：老版本 Hub 没注册 meeting-question-log。
function isMissingHandler(error) {
  return /No handler registered|未知操作|unknown (op|channel)|not (a )?function/i.test(String(error?.message || error || ''));
}

// 老后端兜底：把题目上的持久字段拼成同样形状的记录。
function fallbackLog(q, meeting) {
  const lines = (q?.steps || []).map(s => ({ at: s.at, kind: 'step', text: s.text }));
  if (!lines.length) {
    if (Number.isFinite(q?.queuedAt)) lines.push({ at: q.queuedAt, kind: 'step', text: '已送达，排队' });
    if (Number.isFinite(q?.dispatchedAt)) lines.push({ at: q.dispatchedAt, kind: 'step', text: '派给回答进程' });
    if (q?.waiting) lines.push({ at: q.waitingSince, kind: 'step', text: q.waiting });
  }
  if (q?.state === 'done') lines.push({ at: q.at, kind: 'exit', text: `答完${Number.isFinite(q.durationMs) ? '，用时 ' + seconds(q.durationMs) : ''}` });
  if (q?.state === 'error') lines.push({ at: q.at, kind: 'stderr', text: q.error || '没有收到回答' });
  return {
    ok: true, fallback: true,
    meta: { engine: q?.engine, model: q?.model, mode: q?.mode, speed: q?.speed, startedAt: q?.startedAt, firstTokenAt: q?.firstTokenAt },
    lines,
    understanding: { sessionId: meeting?.sessionId || null, state: meeting?.agent?.state, error: meeting?.agent?.error, engineLabel: meeting?.engineLabel },
  };
}

// 复制日志用的纯文本。
function logText(q, log) {
  const meta = log?.meta || {};
  const head = [`问题：${q?.q || ''}`, `状态：${questionStatus(q).label}`,
    `引擎：${engineText({ engine: meta.engine || q?.engine, model: meta.model || q?.model }) || '未知'}`,
    meta.mode ? `模式：${MODE_LABEL[meta.mode] || meta.mode}` : '', meta.speed || q?.speed ? `档位：${SPEED_LABEL[meta.speed || q?.speed] || meta.speed || q?.speed}` : '',
    Number.isFinite(meta.contextChars) ? `材料：${chars(meta.contextChars)}` : '', meta.pid ? `进程号：${meta.pid}` : '',
    meta.slot ? `进程位：${meta.slot.running}/${meta.slot.max}` : '', meta.command ? `命令：${meta.command}` : '', meta.cwd ? `目录：${meta.cwd}` : ''].filter(Boolean);
  const lines = (log?.lines || []).map(l => `${clock(l.at)} [${KIND_LABEL[l.kind] || l.kind}] ${l.text}`);
  return [...head, '', ...lines].join('\n');
}

function backstageHtml(q, log, { engines = [], error = '', ...extra } = {}) {
  if (!q) return '';
  const meta = log?.meta || {}, st = questionStatus(q), id = esc(q.id), und = log?.understanding || {};
  const row = (k, v) => (v || v === 0 ? `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>` : '');
  // 命令、工作目录很长（完整路径 + 全套参数）：占整行、默认一行省略，点开看全，不把日志区和按钮挤出抽屉。
  const long = (k, v) => (v ? `<div class="meeting-backstage-wide"><dt>${esc(k)}</dt><dd><details class="meeting-backstage-long" data-long="${esc(k)}"><summary title="点开看全">${esc(v)}</summary><div>${esc(v)}</div></details></dd></div>` : '');
  const asked = askedAt(q), firstAt = meta.firstTokenAt ?? q.firstTokenAt;
  const first = Number.isFinite(firstAt) && Number.isFinite(asked) ? seconds(firstAt - asked) : '';
  const facts = [
    row('引擎 · 模型', engineText({ engine: meta.engine || q.engine, model: meta.model || q.model }) || '还没定（排队中或老版本没记录）'),
    row('模式', MODE_LABEL[meta.mode || q.mode] || meta.mode || q.mode),
    row('档位', SPEED_LABEL[meta.speed || q.speed] ? SPEED_LABEL[meta.speed || q.speed] + '档' : ''),
    row('材料字数', Number.isFinite(meta.contextChars) ? chars(meta.contextChars) : ''),
    row('进程号', meta.pid), row('进程位', meta.slot ? `全机 ${meta.slot.running}/${meta.slot.max} 在用` : ''),
    row('启动', clock(meta.startedAt ?? q.startedAt)), row('提问到首字', first), row('结束', clock(meta.endedAt)),
    long('命令', meta.command), long('工作目录', meta.cwd),
  ].join('');
  const lines = (log?.lines || []).map(l => `<li data-kind="${esc(l.kind)}"><time>${esc(clock(l.at))}</time><b>${esc(KIND_LABEL[l.kind] || l.kind)}</b><span>${esc(l.text)}</span></li>`).join('')
    || '<li data-kind="step"><span>还没有过程记录</span></li>';
  const notice = log?.fallback ? '<p class="meeting-backstage-note">详细记录（命令、逐条事件、stderr、退出码）需新版后端；这里先显示题目上已有的记录。</p>' : '';
  const failed = error ? `<p class="meeting-question-error">后台记录没读出来：${esc(error)}</p>` : '';
  const sessionNote = extra.sessionNote ? `<p class="meeting-backstage-note">${esc(extra.sessionNote)}</p>` : '';
  const btn = (attr, label) => `<button type="button" class="ca-btn" ${attr}>${label}</button>`;
  const inFlight = isInFlight(q);
  const speedButtons = inFlight ? '' : Object.entries(SPEED_LABEL).filter(([v]) => v !== q.speed).map(([v, l]) => btn(`data-reanswer="${id}" data-speed-to="${v}"`, `用${l}重答`)).join('');
  const engineMenu = !inFlight && engines.length ? `<details class="meeting-engine-menu"><summary class="ca-btn">换引擎重答</summary><div class="meeting-engine-list">${engines.map(e => btn(`data-reanswer="${id}" data-engine-to="${esc(e.id)}"`, esc(e.label || e.id))).join('')}</div></details>` : '';
  const sessionId = und.sessionId;
  const understanding = `<p class="meeting-backstage-und">会议理解会话：${esc(und.engineLabel || '')}${und.state ? ' · ' + esc({ ready: '已就绪', starting: '启动中', error: '启动异常' }[und.state] || und.state) : ''}${und.error ? ' · ' + esc(und.error) : ''}</p>`;
  return `<header><strong>后台 · ${esc(q.q)}</strong><button type="button" class="meeting-notice-close" data-backstage-close aria-label="关闭后台">×</button></header>`
    + `<p class="meeting-backstage-state" data-tone="${st.tone}">${esc(st.label)}${inFlight ? ' · 每秒刷新' : ''}</p>${failed}${notice}`
    + `<dl class="meeting-backstage-facts">${facts}</dl>` + sessionNote
    + `<ol class="meeting-backstage-lines">${lines}</ol>`
    + understanding
    + `<div class="meeting-backstage-actions">${btn(`data-backstage-copy="${id}"`, '复制日志')}${inFlight ? btn(`data-cancel-question="${id}"`, '取消这题') : ''}${speedButtons}${engineMenu}${sessionId ? btn(`data-open-backstage-session="${esc(sessionId)}"`, '打开理解会话后台') : ''}</div>`;
}

module.exports = { backstageHtml, fallbackLog, logText, isMissingHandler };
