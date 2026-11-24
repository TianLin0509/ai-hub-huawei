'use strict';
// 卡片视图里直接回答终端选择菜单（2026-11-24 一键反馈 v5.6.99：CodeAgent 弹问题时卡片上是一块深色浮层，只能去后台终端选）。
//
// 做法：主进程把会话缓冲回放成最后一屏（core/codeagent-model-picker.js openSessionScreen），
// 用 core/choice-menu-screen.js 认出「编号选项 + 光标行」的菜单，卡片上画成一行小字选项。
// 用户点了某项：先重新读屏，题目和选项都和用户看到的那份完全一致才按键；
// 按键沿用信任框、Bypass 警告框已验证过的方式（从光标行按上/下移到目标行，再回车），
// 不靠数字直选，避免不同 CLI 对数字键的处理不同。按完再读屏确认菜单已经收起，作为回执。
// 认不出的画面一律不按键，卡片上只给「去后台处理」。

const choiceMenu = require('./choice-menu-screen');
const trustDialog = require('./claude-trust-dialog');

const KEY_GAP_MS = 80;
const CONFIRM_WAIT_MS = 2500;
const CONFIRM_POLL_MS = 150;
const UP = '\x1b[A';
const DOWN = '\x1b[B';

// 题目上方最近的「工具(参数)」行，例如「● Bash(dir)」。先找带圆点的行，命令正文里的 sleep(1) 一类不抢先。
const TOOL_LINE = /^[\s│┃]*([●⏺•]\s*)?([A-Za-z][\w.-]*)\((.+)\)[\s│┃]*$/;
function toolLine(menu, lines) {
  const rows = (lines || []).map(l => String(l || ''));
  const q = String(menu?.question || '').trim();
  const at = q ? rows.findLastIndex(l => l.includes(q)) : -1;
  if (at < 0) return null;
  const found = [];
  for (let i = at - 1; i >= 0 && i >= at - 12; i -= 1) { const t = TOOL_LINE.exec(rows[i]); if (t) found.push(t); }
  const t = found.find(x => x[1]) || found[0];
  return t ? { tool: t[2], arg: t[3].trim() } : null;
}

// 签名带上工具参数行：两道选项文案一样、命令不同的授权题（dir → del）不算同一道。
const signatureOf = (menu, lines) => {
  const t = toolLine(menu, lines);
  return JSON.stringify([menu.kind, menu.question, t ? `${t.tool}(${t.arg})` : '', menu.options.map(o => [o.key, o.label])]);
};

// 菜单下面已经是有内容的输入框（占位符或草稿），说明菜单是没清掉的旧画面，不当菜单。
// 空提示符由 choice-menu-screen 自己排除。
const INPUT_ROW = /^\s*(?:[│┃]\s*)?[❯›>]\s*\S/;
function inputBelow(menu, lines) {
  const rows = (lines || []).map(l => String(l || ''));
  const last = menu.options[menu.options.length - 1];
  const at = rows.findLastIndex(l => l.includes(`${last.key}. ${last.label}`) || l.includes(`${last.key}) ${last.label}`));
  if (at < 0) return false;
  return rows.slice(at + 1).some(l => INPUT_ROW.test(l));
}

function detect(lines, rules) {
  const menu = choiceMenu.detectChoiceMenu(lines, rules);
  return menu && !inputBelow(menu, lines) ? menu : null;
}

// 从当前高亮项移到 key 那一项再回车；任何一端找不到就不给键。
function keysFor(menu, key) {
  const options = menu?.options || [];
  const from = options.findIndex(o => o.selected);
  const to = options.findIndex(o => o.key === String(key));
  if (from < 0 || to < 0) return null;
  const delta = to - from;
  return [...Array(Math.abs(delta)).fill(delta > 0 ? DOWN : UP), '\r'];
}

// 选项语气：卡片上按钮的顺序和颜色深浅只看这个，不改变按键。
function optionTone(label) {
  const text = String(label || '').trim();
  if (/^(?:No\b|Reject|Deny|Cancel|拒绝|取消|不允许|否)/i.test(text)) return 'deny';
  if (/don.t ask again|always|(?:for|during) this session|本次会话|总是|始终|以后都/i.test(text)) return 'always';
  if (/^(?:Yes\b|Allow\b|Proceed|Approve|允许|是|同意|确认)/i.test(text)) return 'allow';
  return 'other';
}

// 卡片上的短文案：长选项只留前半句，完整原文放 title。
function shortLabel(label) {
  const text = String(label || '').trim();
  const tone = optionTone(text);
  if (/^Yes$/i.test(text)) return '允许';
  if (/^No$/i.test(text)) return '拒绝';
  if (tone === 'always' && /^Yes\b/i.test(text)) return '允许且不再询问';
  if (tone === 'deny' && /^No,/i.test(text)) return '拒绝';
  return text.length > 28 ? text.slice(0, 27) + '…' : text;
}

// lines：最后一屏。返回给卡片的描述，认不出返回 null。
//   auto: 'pending' —— 信任目录、Bypass 警告这类 Hub 启动时会自动确认的框，卡片先不打扰；
function describeMenu(lines, rules) {
  if (trustDialog.detectTrustDialogInLines(lines, { cursorOnTrustIsEnough: true }) || trustDialog.detectBypassWarningInLines(lines)) {
    const menu = detect(lines, rules);
    return menu ? { ...present(menu, lines), auto: 'pending' } : { auto: 'pending', options: [] };
  }
  const menu = detect(lines, rules);
  return menu ? present(menu, lines) : null;
}

const clip = (text, n = 60) => (text.length > n ? text.slice(0, n - 1) + '…' : text);
// 卡片上的一句话题目：授权类尽量说出要做的事（「允许执行 dir？」），说不出就用原题。原题放 title 备查。
function plainQuestion(menu, lines) {
  const q = String(menu.question || '').trim();
  if (menu.kind !== 'permission') return q;
  let m = /^Do you want to (?:make this edit to|edit) (.+?)\?$/i.exec(q);
  if (m) return `允许修改 ${clip(m[1])}？`;
  if ((m = /^Do you want to (?:create|write) (.+?)\?$/i.exec(q))) return `允许写入 ${clip(m[1])}？`;
  const t = toolLine(menu, lines);
  if (t) return /^(?:Bash|PowerShell|Shell|Run|Exec)/i.test(t.tool) ? `允许执行 ${clip(t.arg)}？` : `允许 ${t.tool}：${clip(t.arg)}？`;
  if (/^Do you want to proceed\?$/i.test(q)) return '允许继续执行？';
  return q;
}

function present(menu, lines) {
  return {
    kind: menu.kind,
    question: plainQuestion(menu, lines),
    original: menu.question,
    signature: signatureOf(menu, lines),
    options: menu.options.map(o => ({ key: o.key, label: o.label, short: shortLabel(o.label), tone: optionTone(o.label), selected: o.selected })),
  };
}

// 用户已选「全部放开」的会话又停在一道普通的工具授权上：按用户既有设置选「仅本次允许」那一项（纯 Yes）。
// 只认纯「Yes」，不替用户选「不再询问」「切换模式」这类会改变以后行为的选项。
// 还要有授权特征文字（题目或除 Yes/No 外的选项）：孤零零的「1. Yes / 2. No」可能只是一道普通提问，不代答。
const PERMISSION_FEATURE = /^Do you want to\b|\bAllow\b.*\?|Would you like to run\b|是否允许|允许.*吗|don.t ask again|tell \S+ what to do differently|^Yes, (?:allow|and )|(?:for|during) this session|\balways\b/i;
function autoAnswerKey(menu, info) {
  if (!menu || menu.kind !== 'permission' || menu.auto) return null;
  if (info?.permissionMode !== 'bypassPermissions') return null;
  const texts = [menu.original || '', ...menu.options.map(o => o.label).filter(l => !/^(?:Yes|No)\.?$/i.test(l))];
  if (!texts.some(t => PERMISSION_FEATURE.test(t))) return null;
  const yes = menu.options.find(o => /^Yes\.?$/i.test(o.label));
  return yes ? yes.key : null;
}

function createPtyChoiceMenu(manager, {
  openScreen = sid => require('./codeagent-model-picker').openSessionScreen(manager, sid),
  rules = () => choiceMenu.loadRules(require('./data-dir').getHubDataDir()).rules,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
  log = (...args) => console.log('[pty-choice]', ...args),
} = {}) {
  const busy = new Set();
  const infoOf = sid => manager.sessions?.get?.(sid)?.info || null;
  const hasPty = sid => !!manager.sessions?.get?.(sid)?.pty;

  async function withScreen(sid, fn) {
    const screen = await openScreen(sid);
    try { return await fn(screen); } finally { try { screen.dispose(); } catch { /* 已释放 */ } }
  }

  // 多步按键：方向键都发完、回车之前再读一次屏，确认还是同一道题、光标停在目标项上，才按回车。
  async function press(sid, keys, { screen, signature, key, rulesValue }) {
    const moves = keys.slice(0, -1);
    for (let i = 0; i < moves.length; i += 1) {
      if (i) await sleep(KEY_GAP_MS);
      manager.writeToSession(sid, moves[i]);
    }
    if (moves.length) {
      let ready = false;
      const deadline = now() + CONFIRM_WAIT_MS;
      while (!ready && now() < deadline) {
        await sleep(KEY_GAP_MS);
        const lines = await screen.lines();
        const menu = detect(lines, rulesValue);
        if (!menu || signatureOf(menu, lines) !== signature) return { ok: false, reason: 'menu-changed', message: '终端里的问题变了，没有按回车' };
        ready = menu.options.find(o => o.selected)?.key === String(key);
      }
      if (!ready) return { ok: false, reason: 'cursor-mismatch', message: '光标没移到这一项，没有按回车，请再点一次' };
    }
    manager.writeToSession(sid, '\r');
    return { ok: true };
  }

  // 按完键等菜单收起或换成另一道题，作为回执。
  async function confirmGone(screen, signature, rulesValue) {
    const deadline = now() + CONFIRM_WAIT_MS;
    while (now() < deadline) {
      await sleep(CONFIRM_POLL_MS);
      const lines = await screen.lines();
      const menu = detect(lines, rulesValue);
      if (!menu || signatureOf(menu, lines) !== signature) return true;
    }
    return false;
  }

  async function read(sid) {
    if (!hasPty(sid)) return { ok: false, reason: 'no-terminal' };
    if (busy.has(sid)) return { ok: true, menu: null, busy: true };
    const rulesValue = rules();
    return withScreen(sid, async screen => {
      const lines = await screen.lines();
      const menu = describeMenu(lines, rulesValue);
      const autoKey = autoAnswerKey(menu, infoOf(sid));
      if (autoKey) {
        busy.add(sid);
        try {
          const pressed = await press(sid, keysFor(menu, autoKey), { screen, signature: menu.signature, key: autoKey, rulesValue });
          if (!pressed.ok) return { ok: true, menu: null, busy: true };
          const confirmed = await confirmGone(screen, menu.signature, rulesValue);
          log(sid, '按会话的「全部放开」设置自动允许：', menu.question, confirmed ? '已收起' : '未确认收起');
          return { ok: true, menu: null, autoAnswered: { question: menu.question, label: menu.options.find(o => o.key === autoKey)?.label, confirmed } };
        } finally { busy.delete(sid); }
      }
      return { ok: true, menu };
    });
  }

  // 只在屏幕上的菜单与卡片看到的那份（signature）一致时按键。
  async function answer(sid, { signature, key } = {}) {
    if (!hasPty(sid)) return { ok: false, reason: 'no-terminal', message: '终端已经不在了' };
    if (!signature || key == null) return { ok: false, reason: 'bad-request', message: '缺少选项' };
    if (busy.has(sid)) return { ok: false, reason: 'busy', message: '上一次选择还在处理' };
    busy.add(sid);
    try {
      const rulesValue = rules();
      return await withScreen(sid, async screen => {
        const lines = await screen.lines();
        const menu = detect(lines, rulesValue);
        if (!menu) return { ok: false, reason: 'menu-gone', message: '终端里的问题已经不在了' };
        if (signatureOf(menu, lines) !== signature) return { ok: false, reason: 'menu-changed', message: '终端里的问题变了，请看新的选项' };
        const keys = keysFor(menu, key);
        if (!keys) return { ok: false, reason: 'option-missing', message: '没找到这个选项' };
        const pressed = await press(sid, keys, { screen, signature, key, rulesValue });
        if (!pressed.ok) { log(sid, '卡片选择中止：', pressed.reason); return pressed; }
        const confirmed = await confirmGone(screen, signature, rulesValue);
        log(sid, '卡片选择：', menu.question, '→', menu.options.find(o => o.key === String(key))?.label, confirmed ? '已收起' : '未确认收起');
        return { ok: true, confirmed };
      });
    } finally { busy.delete(sid); }
  }

  return { read, answer };
}

module.exports = { createPtyChoiceMenu, describeMenu, keysFor, optionTone, shortLabel, autoAnswerKey, signatureOf, inputBelow };
