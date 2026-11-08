'use strict';
// 纪要按条目增量更新（2026-11-07）。原来每轮让模型重写整份理解、程序整份替换：模型偶尔只回一句「本轮无新增」，
// 整份纪要就被这一句顶掉，再赶上换会话，前面的决定和行动项全丢。36 分钟模拟周会、DeepSeek-Flash，按标准答案逐条评分：
// 整份重写 9–19 / 34；按条目增量 33 / 34，每轮平均 13 秒 → 8 秒，最终纪要 1.5 千字 → 2 千字以内（重写版增量会膨胀到 4–5 千字）。
// 条目分五类，编号固定：T 议题、F 关键事实、D 决定、A 行动项、Q 待确认。模型只回新增或改动的条目，程序合并；
// 回复里一条都解析不出来（「本轮无更新」或格式走样）时保留原纪要，绝不清空。
const SECTIONS = [['T', '议题'], ['F', '关键事实'], ['D', '决定'], ['A', '行动项'], ['Q', '待确认']];
// 容忍常见走样：[T-1]、**[D2]**、[A 3]：…
const LINE = /^\s*(?:[-*•]\s*)?(?:\*\*)?\[([TFDAQ])\s*[-_]?\s*(\d{1,3})\](?:\*\*)?\s*[:：]?\s*(.*\S)\s*$/;
const DELETE = /^(?:删除|作废|已删除)[。.]?$/;
const SUMMARY_LINE = /^\s*本轮小结[:：]\s*(.+)$/m;

function parse(text) {
  const items = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.match(LINE);
    if (m) items.set(`${m[1]}${Number(m[2])}`, { kind: m[1], n: Number(m[2]), text: m[3] });
  }
  return items;
}

function render(items) {
  const out = [];
  for (const [kind, name] of SECTIONS) {
    const rows = [...items.values()].filter(x => x.kind === kind).sort((a, b) => a.n - b.n);
    if (!rows.length) continue;
    out.push(`## ${name}`, ...rows.map(x => `- [${kind}${x.n}] ${x.text}`));
  }
  return out.join('\n');
}

// 返回 { summary, changed, note }：changed 是本轮改动的条目数，note 是模型写的「本轮小结」。
function apply(current, reply) {
  const items = parse(current), changes = parse(reply), note = String(reply || '').match(SUMMARY_LINE)?.[1]?.trim() || '';
  if (!changes.size) {
    // 模型没按条目格式写、而纪要还是空的：先把它写的整段留下，总比空着强；有纪要时保留原纪要。
    const body = String(reply || '').replace(SUMMARY_LINE, '').trim();
    if (!current && body.length >= 8 && !/^本轮无更新/.test(body)) return { summary: body, changed: 0, note };
    return { summary: current || '', changed: 0, note };
  }
  for (const [key, x] of changes) { if (DELETE.test(x.text)) items.delete(key); else items.set(key, x); }
  return { summary: render(items), changed: changes.size, note };
}

// 界面和导出不显示条目编号；编号只给模型对齐用。
function display(summary) { return String(summary || '').replace(/^(\s*[-*]\s*)\[[TFDAQ]\d{1,3}\]\s*/gm, '$1'); }

module.exports = { parse, render, apply, display, SECTIONS };
