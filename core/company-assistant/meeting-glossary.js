'use strict';
// 专业词库（2026-11-07）。新转写引擎中文准，但英文缩写常被听成近音字（合成会议里 OLLA→欧亚、CodeAgent→coagent、AI Hub→EI）。
// 两层用法：「错词=正确词」在转写落盘时直接替换；所有词（含替换后的正确词）交给会议伴侣，让它理解时按词库还原没替换到的写法。
// 一台电脑一份，所有会议共用；存在助理数据目录的 meeting-glossary.txt，用户在「更多」里直接编辑。
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TEXT = ['PPT', 'CodeAgent', 'AI Hub', 'MIMO', 'SINR', 'MCS', 'CQI', 'OLLA', '吞吐量', '高负载', '基线'].join('\n') + '\n';
const MAX_CHARS = 4000;

function parse(text) {
  const terms = new Set(), fixes = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(.+?)\s*(?:=|→|->)\s*(.+)$/);
    if (m && m[1].trim() && m[2].trim()) { fixes.push({ from: m[1].trim(), to: m[2].trim() }); terms.add(m[2].trim()); }
    else terms.add(line);
  }
  // 长的错词先替换，免得「欧亚」先吃掉「欧亚拉」里的一段。
  fixes.sort((a, b) => b.from.length - a.from.length);
  return { terms: [...terms].slice(0, 200), fixes: fixes.slice(0, 200) };
}

// 从会后复核回复里取「词库建议：欧拉=OLLA；CQ=CQI」，只留像样的「错词=正确词」。
function parseHints(text) {
  const line = String(text || '').match(/^\s*词库建议[:：]\s*(.+)$/m)?.[1] || '';
  return [...new Set(line.split(/[；;，,、]\s*/).map(x => x.trim().replace(/\s*(?:=|→|->)\s*/, '=')).filter(x => /^[^=]{1,20}=[^=]{1,20}$/.test(x) && x.split('=')[0] !== x.split('=')[1]))];
}

class MeetingGlossary {
  constructor(dir) { this.file = path.join(dir, 'meeting-glossary.txt'); this.cache = null; }
  text() { try { return fs.readFileSync(this.file, 'utf8'); } catch { return DEFAULT_TEXT; } }
  save(text) {
    const value = String(text ?? '').slice(0, MAX_CHARS);
    fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, value, 'utf8'); this.cache = null;
    return this.read();
  }
  read() {
    let mtime = 0; try { mtime = fs.statSync(this.file).mtimeMs; } catch {}
    if (!this.cache || this.cache.mtime !== mtime) this.cache = { mtime, ...parse(this.text()) };
    return this.cache;
  }
  // 两个坑：正确词本身含错词（CQ=CQI，「CQI」不能变「CQII」）；英文错词不能拆别的词（SI=SINR 不能改 SIM）。
  apply(text) {
    let out = String(text || '');
    for (const f of this.read().fixes) {
      const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.split(f.to).join('\u0000'); // 已经写对的先藏起来
      const ascii = /^[A-Za-z0-9 ]+$/.test(f.from);
      out = out.replace(new RegExp(ascii ? `(?<![A-Za-z0-9])${esc(f.from)}(?![A-Za-z0-9])` : esc(f.from), 'g'), f.to);
      out = out.split('\u0000').join(f.to);    }
    return out;
  }
  // 会议伴侣在会后复核里给的「词库建议」，去掉词库里已有的。
  newHints(list) {
    const have = new Set(this.read().fixes.map(f => `${f.from}=${f.to}`));
    return (list || []).filter(x => !have.has(x));
  }
  // 给会议伴侣的一行说明；没有词就不占输入。
  promptLine() {
    const { terms } = this.read();
    return terms.length ? `专业词库（转写常把这些词听成近音字或拆散的字母，理解和引用时按词库还原，不确定的标注原文）：${terms.join('、')}` : '';
  }
}

module.exports = { MeetingGlossary, parse, parseHints, DEFAULT_TEXT };
