'use strict';
// Team messages use the user input path, but identify their actual sender.
const HEADER = /^【团队消息 · \d+ 条(?: · 原文已存文件)?】\s*\n/;
const SENDER = /^- \[([^\]\n]+)\]/gm;
// 兼容旧长编号索引与短号索引。
const FILE_SENDER = /^- (?:msg-[\w-]+ · |#\d+ )([^·\n]+?) · /gm;
const KICKOFF = /^【组队开工 · 来自负责人】/;
const RECALL = /^【回到队里 · 新任务】/;
const STAMP = /^- \[[^\]\n]+\]/;

function teamNoticeSender(text) {
  const value = String(text || '').trimStart();
  if (!HEADER.test(value)) return null;
  const names = [];
  for (const match of [...value.matchAll(SENDER), ...value.matchAll(FILE_SENDER)]) {
    const name = match[1].replace(/\s*·\s*留言$/, '').trim();
    if (!name) continue;
    const key = name.split(/\s+/)[0], at = names.findIndex(n => n.split(/\s+/)[0] === key);
    if (at < 0) names.push(name); else if (name.length > names[at].length) names[at] = name;
  }
  if (!names.length) return null;
  const label = names.length === 1 ? names[0] : names.map(name => name.split(/\s+/)[0]).join('、');
  return { label, names, onlyHub: names.every(name => name === 'Hub') };
}

function isTeamMessage(text) {
  const value = String(text || '').trimStart();
  return HEADER.test(value) || KICKOFF.test(value) || RECALL.test(value);
}

function teamNoticeSummary(text) {
  const value = String(text || '').trimStart();
  if (KICKOFF.test(value)) return { kind: 'kickoff', summary: clip('组队开工：' + value.split('\n')[0].replace(KICKOFF, '')) };
  if (RECALL.test(value)) return { kind: 'kickoff', summary: clip('返工叫回：' + value.split('\n')[0].replace(RECALL, '')) };
  const head = value.match(/^【团队消息 · (\d+) 条(?: · 原文已存文件)?】/);
  if (!head) return null;
  const lines = value.split('\n').slice(1);
  if (/原文已存文件】$/.test(head[0])) {
    const item = (lines.find(line => /^- (?:msg-|#\d|\[)/.test(line)) || '').replace(/^- (?:msg-[\w-]+ · |#\d+ )/, '').trim();
    return { kind: 'notice', summary: clip(`${head[1]} 条 · 原文已存文件` + (item ? ' · ' + item : '')) };
  }
  const at = lines.findIndex(line => STAMP.test(line));
  // Support existing inline messages as well as id/timestamp + body records.
  const inline = at < 0 ? '' : lines[at].replace(STAMP, '').trim();
  const stamped = /^(?:msg(?:-[\w-]+)?\s+·\s+\S+|#\d+\s+\S+)/.test(inline);
  const next = at < 0 ? '' : lines.slice(at + 1).find(line => line.trim())?.trim();
  const first = inline && !stamped ? inline : (next && !STAMP.test(next) ? next : '');
  const count = Number(head[1]);
  return { kind: 'notice', summary: clip((count > 1 ? `${count} 条 · ` : '') + (first || '团队消息')) };
}
function clip(s) { const v = s.replace(/\s+/g, ' ').trim(); return v.length > 160 ? v.slice(0, 160) + '…' : v; }

module.exports = { teamNoticeSender, teamNoticeSummary, isTeamMessage };
