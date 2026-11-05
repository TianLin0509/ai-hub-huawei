'use strict';
// Team messages use the user input path, but identify their actual sender.
const HEADER = /^【团队消息 · \d+ 条】\s*\n/;
const SENDER = /^- \[([^\]\n]+)\]/gm;
const KICKOFF = /^【组队开工 · 来自负责人】/;
const STAMP = /^- \[[^\]\n]+\]/;

function teamNoticeSender(text) {
  const value = String(text || '').trimStart();
  if (!HEADER.test(value)) return null;
  const names = [];
  for (const match of value.matchAll(SENDER)) {
    const name = match[1].replace(/\s*·\s*留言$/, '').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  if (!names.length) return null;
  const label = names.length === 1 ? names[0] : names.map(name => name.split(/\s+/)[0]).join('、');
  return { label, names, onlyHub: names.every(name => name === 'Hub') };
}

function isTeamMessage(text) {
  const value = String(text || '').trimStart();
  return HEADER.test(value) || KICKOFF.test(value);
}

function teamNoticeSummary(text) {
  const value = String(text || '').trimStart();
  if (KICKOFF.test(value)) return { kind: 'kickoff', summary: clip('组队开工：' + value.split('\n')[0].replace(KICKOFF, '')) };
  const head = value.match(/^【团队消息 · (\d+) 条】/);
  if (!head) return null;
  const lines = value.split('\n').slice(1);
  const at = lines.findIndex(line => STAMP.test(line));
  // Support existing inline messages as well as id/timestamp + body records.
  const inline = at < 0 ? '' : lines[at].replace(STAMP, '').trim();
  const stamped = /^msg(?:-[\w-]+)?\s+·\s+\S+/.test(inline);
  const next = at < 0 ? '' : lines.slice(at + 1).find(line => line.trim())?.trim();
  const first = inline && !stamped ? inline : (next && !STAMP.test(next) ? next : '');
  const count = Number(head[1]);
  return { kind: 'notice', summary: clip((count > 1 ? `${count} 条 · ` : '') + (first || '团队消息')) };
}
function clip(s) { const v = s.replace(/\s+/g, ' ').trim(); return v.length > 160 ? v.slice(0, 160) + '…' : v; }

module.exports = { teamNoticeSender, teamNoticeSummary, isTeamMessage };
