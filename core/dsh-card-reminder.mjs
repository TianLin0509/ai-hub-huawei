// 进展卡提醒（2026-10-24）：DSH 没有 shell 钩子，用和 Claude / Codex 钩子同样的两条规矩做成一个 DSH 插件。
//   A. 会话变长：上下文到窗口的 50%、60%、70%、80% 各提醒一次「按模板更新进展卡，然后继续」；不报 token 数，不叫它收尾。
//   B. 压缩之后：下一次工具调用结束时，告诉它压缩前在维护哪张进展卡，先读它再继续。找不到卡就不说。
// 卡从它自己的工具调用参数里认（写过、读过的路径），规则与 core/session-reference.js 的 CARD_PATH 一致。
// 提醒走 tools/post-execute 的 additionalContexts，与 DSH 自带的 repeat-tool-reminder 同一条注入路。
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export const name = 'hub-dsh-card-reminder';
export const inject = ['tokenMeter'];

const TEMPLATE = 'C:\\Users\\you\\.agents\\templates\\进展卡模板.md';
const CARD_PATH = /[A-Za-z]:(?:[\\/]{1,4}[^\\/\n"'`<>|*?:]+)*?[\\/]{1,4}[^\\/\n"'`<>|*?:]*(?:进展卡|状态卡)[^\\/\n"'`<>|*?:]*\.md/g;
const LEVELS = [0.5, 0.6, 0.7, 0.8];

export function cardPathsIn(text) {
  return [...String(text || '').matchAll(CARD_PATH)].map(m => m[0].replace(/[\\/]{1,4}/g, '\\'));
}

export function newestExisting(paths, statSync = fs.statSync) {
  let best = null;
  for (const p of paths) {
    try { const s = statSync(p); if (s.isFile() && (!best || s.mtimeMs > best.mtimeMs)) best = { path: p, mtimeMs: s.mtimeMs }; } catch {}
  }
  return best && best.path;
}

export const LONG_TEXT = '【上下文提醒】这个会话已经比较长，之后可能会被自动压缩。不用收尾或换会话，按顺序处理：\n'
  + '1. 先把正在做的步骤做到稳定点（测试跑完、文件写完、结论落盘）。\n'
  + `2. 参照 ${TEMPLATE} 更新任务目录里的进展卡（没有就新建）：当前步骤、下一步、关键数字、走不通的方向、路径和 SHA。\n`
  + '3. 然后继续当前任务。压缩后或新会话接手时，先读进展卡再动手。';

export function afterCompactText(card) {
  return `【压缩后接续】这个会话压缩前在维护进展卡：${card}\n`
    + '先读它（最新状态、拍过板的事、走不通的方向都在里面），和压缩摘要对照，确认下一步后再继续；两者不一致时以卡和实际文件为准。';
}

function notice(text) {
  return Object.freeze({ id: randomUUID(), role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'hub-card-reminder', form: 'notice', summary: '进展卡提醒' }) });
}

export function apply(ctx) {
  const window = Number(process.env.AI_HUB_DSH_CONTEXT_WINDOW) || 1048576; // DeepSeek V4 系列 1M 窗口
  const scale = Number(process.env.AI_HUB_CARD_REMIND_SCALE) || 1; // 只供测试压低阈值
  const reached = new WeakMap(), cards = new WeakMap(), compacted = new WeakSet();
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'compaction/end') { compacted.add(session); reached.delete(session); }
  });
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const downstream = await next();
    const session = exec?.agent?.session;
    if (!session) return downstream;
    let text = null;
    try {
      const seen = cards.get(session) || new Set();
      for (const p of cardPathsIn(JSON.stringify(exec.arguments ?? ''))) seen.add(p);
      cards.set(session, seen);
      if (compacted.has(session)) {
        compacted.delete(session);
        const card = newestExisting(seen);
        if (card) text = afterCompactText(card);
      } else {
        const ratio = ctx.tokenMeter.measure(session).totalTokens / (window * scale);
        const level = LEVELS.filter(l => ratio >= l).length;
        if (level > (reached.get(session) || 0)) { reached.set(session, level); text = LONG_TEXT; }
      }
    } catch { return downstream; } // 提醒失败不影响工具结果
    if (!text) return downstream;
    return { ...downstream, additionalContexts: [notice(text), ...(downstream.additionalContexts ?? [])] };
  });
}
