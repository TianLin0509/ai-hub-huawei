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
  apply(text) {
    let out = String(text || '');
    for (const f of this.read().fixes) out = out.split(f.from).join(f.to);
    return out;
  }
  // 给会议伴侣的一行说明；没有词就不占输入。
  promptLine() {
    const { terms } = this.read();
    return terms.length ? `专业词库（转写常把这些词听成近音字或拆散的字母，理解和引用时按词库还原，不确定的标注原文）：${terms.join('、')}` : '';
  }
}

module.exports = { MeetingGlossary, parse, DEFAULT_TEXT };
