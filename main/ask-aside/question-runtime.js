'use strict';
const fs = require('node:fs'), path = require('node:path');
const redact = value => String(value || '').replace(/(Bearer\s+)[^\s"',}]+/gi, '$1[已隐藏]')
  .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[已隐藏令牌]')
  .replace(/((?:api[-_]?key|auth(?:orization)?(?:[-_]token)?|token|secret|password)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1[已隐藏]')
  // CLI 报 HTTP 错误时可能带出请求头：Cookie / Set-Cookie 整个值隐去（看后台抽屉常被截图转发，发版前复审 2026-11-24）。
  .replace(/((?:set-)?cookie["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\r\n]+)/gi, '$1[已隐藏]');
const byteTail = (value, size) => Buffer.from(String(value || ''), 'utf8').subarray(-size).toString('utf8').replace(/^\uFFFD+/, '');
function safeCommand(command, args = []) {
  let hideNext = false;
  return [command, ...args.map(arg => {
    if (hideNext) { hideNext = false; return '[已隐藏]'; }
    if (/^--?(?:api[-_]?key|token|secret|password|authorization|auth-token)$/i.test(arg)) { hideNext = true; return arg; }
    return redact(arg);
  })].map(redact).join(' ');
}
class QuestionRuntime {
  constructor({ meetingId, questionId, engine = '', model = '', mode = 'fork', speed = 'fast', now = Date.now,
    emit = () => {}, onPhase = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { meetingId, questionId, now, emit, onPhase, setTimer, clearTimer });
    this.meta = { engine, model, mode, speed }; this.steps = []; this.lines = [];
    this.live = { phase: 'queued', partial: '', chars: 0, firstTokenAt: null, lastOutputAt: null, pid: null, slot: { running: 0, max: 3 }, queueAhead: 0 };
    this.lastPushAt = -Infinity; this.stdoutChars = 0; this.stderr = ''; this.finished = false;
  }
  log(kind, text) {
    if (kind === 'stdout') { const room = Math.max(0, 2000 - this.stdoutChars); text = String(text || '').slice(0, room); this.stdoutChars += text.length; if (!text) return; }
    if (kind === 'stderr') { this.stderr = byteTail(this.stderr + String(text || ''), 8192); this.lines = this.lines.filter(l => l.kind !== 'stderr'); text = this.stderr; }
    const safe = redact(text);
    this.lines.push({ at: this.now(), kind, text: kind === 'stderr' ? byteTail(safe, 8192) : safe.slice(0, 2000) });
    if (this.lines.length > 128) this.lines.splice(0, this.lines.length - 128);
  }
  phase(phase, text, meta = {}) {
    if (this.finished) return;
    Object.assign(this.meta, meta); const changed = this.live.phase !== phase;
    this.live.phase = phase;
    if (!changed && this.steps.length) return;
    if (changed || !this.steps.length) {
      this.steps.push({ at: this.now(), phase, text: String(text || phase) }); this.steps = this.steps.slice(-12);
      this.log('step', text || phase);
      try { this.onPhase(this.snapshot()); } catch (error) { this.callbackError = error; this.log('event', '保存阶段暂未成功：' + error.message); }
    }
    this.push(true);
  }
  note(text) {
    if (this.finished) return;
    this.steps = [...this.steps, { at: this.now(), phase: this.live.phase, text }].slice(-12); this.log('step', text);
    try { this.onPhase(this.snapshot()); } catch (error) { this.callbackError = error; this.log('event', error.message); }
    this.push(true);
  }
  start({ pid, cwd, command, args = [], contextChars, slot } = {}) {
    Object.assign(this.meta, { pid, cwd, command: safeCommand(command, args), contextChars, startedAt: this.now(), ...(slot ? { slot } : {}) });
    Object.assign(this.live, { pid, ...(slot ? { slot } : {}) });
    this.phase('starting', this.meta.engine === 'codeagent' ? '正在启动 CodeAgent（通常约 45 秒）。' : '正在启动回答进程。');
  }
  chunk(partial) {
    if (this.finished) return;
    const text = String(partial || '').slice(0, 60000); if (!text || text === this.live.partial) return;
    this.log('stdout', text.startsWith(this.live.partial) ? text.slice(this.live.partial.length) : text);
    Object.assign(this.live, { partial: text, chars: text.length, lastOutputAt: this.now() });
    if (this.live.firstTokenAt == null) { this.live.firstTokenAt = this.now(); this.meta.firstTokenAt = this.now(); }
    if (this.live.phase !== 'streaming') this.phase('streaming', '已收到第一个字，正在回答。'); else this.push();
  }
  push(force = false) {
    const interval = this.live.chars > 8000 ? 1000 : 250, remaining = interval - (this.now() - this.lastPushAt);
    if (!force && remaining > 0) { if (!this.timer) this.timer = this.setTimer(() => { this.timer = null; this.push(); }, remaining); return; }
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    this.lastPushAt = this.now();
    try { this.emit('company-assistant:meeting-question', { meetingId: this.meetingId, questionId: this.questionId, phase: this.live.phase,
      partial: this.live.partial, chars: this.live.chars, firstTokenAt: this.live.firstTokenAt, lastOutputAt: this.live.lastOutputAt, at: this.now() }); }
    catch (error) { this.callbackError = error; this.log('event', '界面推送暂不可用，等待状态轮询：' + error.message); }
  }
  snapshot() { return { ...this.meta, phase: this.live.phase, steps: this.steps.map(s => ({ ...s })), firstTokenAt: this.live.firstTokenAt }; }
  view() { return { ...this.live, slot: { ...this.live.slot } }; }
  finish(phase, text, extra = {}) {
    if (this.finished) return;
    Object.assign(this.meta, extra, { endedAt: this.now() }); this.phase(phase, text, extra); this.finished = true;
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
  }
  record(understanding = {}) {
    return { ok: true, meta: { ...this.meta }, lines: this.lines.map(l => ({ ...l })), understanding: { ...understanding } };
  }
  save(directory, understanding = {}) {
    if (!/^[\da-f-]{36}$/i.test(this.questionId || '')) throw Error('问题编号无效');
    const file = path.join(directory, 'question-logs', this.questionId + '.json'), record = this.record(understanding);
    let content = JSON.stringify(record);
    while (Buffer.byteLength(content, 'utf8') > 64 * 1024 && record.lines.length) { record.lines.shift(); content = JSON.stringify(record); }
    if (Buffer.byteLength(content, 'utf8') > 64 * 1024) throw Error('后台记录元数据过长');
    fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = file + '.tmp'; fs.writeFileSync(temp, content, 'utf8'); fs.renameSync(temp, file);
    return file;
  }
}
module.exports = { QuestionRuntime, safeCommand, redact };
