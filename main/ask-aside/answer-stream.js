'use strict';
const { StringDecoder } = require('node:string_decoder');
const clean = value => String(value || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/扩展初始化中：\S*?\.m?js\s*/g, '').replace(/\r\n/g, '\n').trim();
// stdout is a protocol, not screen text. Only assistant answer blocks become user-visible.
class AnswerStream {
  constructor({ onText = () => {}, onEvent = () => {}, onThinking = () => {}, maxAnswer = 60000, format = 'stream-json' } = {}) {
    Object.assign(this, { onText, onEvent, onThinking, maxAnswer, format });
    this.decoder = new StringDecoder('utf8'); this.buffer = ''; this.raw = ''; this.rawLength = 0; this.completed = ''; this.pending = ''; this.answer = ''; this.sawJson = false; this.truncated = false; this.ids = new Set();
  }
  write(chunk) {
    const value = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.rawLength += value.length; this.raw = (this.raw + value).slice(0, this.maxAnswer);
    if (this.format === 'text') { if (this.rawLength > this.maxAnswer) this.truncated = true; this.set(this.raw); return; }
    this.buffer += value;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) { const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1); this.line(line); }
    // Ignore oversized protocol lines instead of retaining unbounded tool arguments.
    if (this.buffer.length > 1024 * 1024) { this.buffer = ''; this.onEvent('忽略过长的协议行'); }
  }
  set(value) {
    const text = String(value || ''); if (text.length > this.maxAnswer) this.truncated = true;
    const next = text.slice(0, this.maxAnswer);
    if (next !== this.answer) { this.answer = next; if (next.trim()) this.onText(next); }
  }
  line(raw) {
    const value = raw.replace(/^\uFEFF/, '').trim(); if (!value) return;
    let event; try { event = JSON.parse(value); } catch { this.onEvent('忽略非 JSON 协议行'); return; }
    if (!event || typeof event.type !== 'string') return;
    this.sawJson = true;
    if (event.type === 'system' && event.subtype === 'thinking_tokens') {
      if (!this.thinkingSeen) { this.thinkingSeen = true; this.onThinking(); }
      this.onEvent('system thinking_tokens'); return;
    }
    const inner = event.type === 'stream_event' ? event.event : event;
    const delta = inner?.delta;
    if (delta?.type === 'thinking_delta' || inner?.content_block?.type === 'thinking') {
      if (!this.thinkingSeen) { this.thinkingSeen = true; this.onThinking(); this.onEvent('thinking'); }
      return;
    }
    if (inner?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
      this.pending = (this.pending + delta.text).slice(0, this.maxAnswer + 1); this.set(this.completed + this.pending); return;
    }
    if (event.type === 'assistant') {
      const id = event.message?.id || event.uuid;
      const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
      if (blocks.some(part => part?.type === 'thinking') && !this.thinkingSeen) { this.thinkingSeen = true; this.onThinking(); }
      const unseen = blocks.filter((part, index) => {
        if (!id) return true;
        const content = part?.type === 'text' ? String(part.text || '') : String(part?.id || part?.name || '');
        const key = [id, part?.type, part?.index ?? event.index ?? index, require('node:crypto').createHash('sha256').update(content).digest('hex')].join('|');
        if (this.ids.has(key)) return false;
        if (this.ids.size >= 2000) this.ids.delete(this.ids.values().next().value); this.ids.add(key); return true;
      });
      const text = unseen.filter(p => p?.type === 'text').map(p => p.text || '').join('');
      if (text) {
        this.completed = (this.completed + text).slice(0, this.maxAnswer + 1); this.pending = ''; this.set(this.completed);
      }
      const tools = (Array.isArray(event.message?.content) ? event.message.content : []).filter(p => p?.type === 'tool_use').map(p => p.name).filter(Boolean);
      this.onEvent(tools.length ? 'tool_use ' + tools.join(', ') : 'assistant'); return;
    }
    if (event.type === 'result') {
      if (event.is_error) { this.failure = (Array.isArray(event.errors) ? event.errors.join('; ') : String(event.errors || '')) || event.result || 'CLI 返回失败'; this.onEvent('result error'); return; }
      if (typeof event.result === 'string' && event.result.trim()) { this.completed = event.result; this.pending = ''; this.set(event.result); }
      this.onEvent('result ' + (event.subtype || '')); return;
    }
    if (event.type === 'error' || event.type === 'turn.failed') this.failure = event.message || event.error?.message || 'CLI 返回失败';
    // Codex exec JSON: some versions update agent_message items, others only complete them.
    if (/^item\.(?:started|updated|completed)$/.test(event.type)) {
      const item = event.item;
      if (item?.type === 'reasoning' && !this.thinkingSeen) { this.thinkingSeen = true; this.onThinking(); }
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        const key = item.id || '__current__'; this.codexTexts ||= new Map();
        if (!this.codexTexts.has(key) && this.codexTexts.size >= 100) { this.truncated = true; return; }
        this.codexTexts.set(key, item.text.slice(0, this.maxAnswer + 1));
        this.set([...this.codexTexts.values()].join('\n')); return;
      }
      this.onEvent(event.type + ' ' + (item?.type || '')); return;
    }
    if (/^(?:agent_message|response\.output_text)\.delta$/.test(event.type) && typeof event.delta === 'string') {
      this.pending = (this.pending + event.delta).slice(0, this.maxAnswer + 1); this.set(this.completed + this.pending); return;
    }
    this.onEvent([event.type, event.subtype || inner?.type || ''].filter(Boolean).join(' '));
  }
  end() {
    const tail = this.decoder.end(); if (tail) { this.raw = (this.raw + tail).slice(0, this.maxAnswer); this.buffer += tail; }
    if (this.format !== 'text' && this.buffer.trim()) this.line(this.buffer);
    this.buffer = '';
    if (!this.sawJson) { if (this.rawLength > this.maxAnswer) this.truncated = true; this.set(clean(this.raw)); }
    return { answer: clean(this.answer), truncated: this.truncated, sawJson: this.sawJson, fallbackText: this.format !== 'text' && !this.sawJson && !!this.answer, ...(this.failure ? { error: this.failure } : {}) };
  }
}
function errorInfo(error = {}) {
  let kind = error.errorKind || '';
  const text = String(error.message || error.error || '');
  if (!kind) {
    if (error.cancelled) kind = 'cancelled';
    else if (error.timedOut || error.timeoutKind) kind = error.timeoutKind === 'idle' ? 'idle-timeout' : 'total-timeout';
    else if (error.code === 'MEETING_CONTEXT_NOT_READY') kind = 'context-not-ready';
    else if (error.code === 'ENOENT' || /启动.+失败|无法启动|命令.+找不到|账号目录.+不可用/.test(text)) kind = 'spawn-failed';
    else if (/后台尚未就绪|问答服务.+未就绪/.test(text)) kind = 'service-not-ready';
    else if (/模型尚未就绪|引擎.+(?:不可用|异常)|终端没在运行/.test(text)) kind = 'engine-not-ready';
    else if (/超过.+字|材料.+过长/.test(text)) kind = 'too-long';
    else if (/没有返回内容|空回复|空回答|返回了空/.test(text)) kind = 'empty-answer';
    else if (error.exitCode != null || /退出码/.test(text)) kind = 'exit-nonzero';
    else if (/中断|Hub.+关闭|重启/.test(text)) kind = 'interrupted';
    else kind = 'unknown';
  }
  const hints = { cancelled: '这题已取消，可以重试。', 'context-not-ready': '可以用快速档重答，直接根据纪要和最近原话回答。',
    'engine-not-ready': '换一个可用引擎重答，或查看后台的启动错误。', 'service-not-ready': '稍后重试这道题。',
    'spawn-failed': '查看后台的启动错误，或换引擎重答。', 'idle-timeout': '查看后台最后输出，再重试或换档重答。',
    'total-timeout': '可以改用快速档重答，或查看后台。', 'exit-nonzero': '查看后台错误后重试。', 'empty-answer': '可以重试或换档重答。',
    'too-long': '可以用快速档重答，减少本次需要核对的材料。', interrupted: '原材料仍在，可以重试。', unknown: '查看后台记录后重试。' };
  return { errorKind: kind, errorHint: error.errorHint || hints[kind] || hints.unknown };
}
function trimContext(context, max = 60000) {
  const text = String(context || ''); if (text.length <= max) return { context: text, trimmed: false };
  const note = '\n【材料过长，保留纪要开头和最近原话，中间部分已裁剪】\n';
  const head = Math.min(20000, Math.floor((max - note.length) / 2));
  return { context: text.slice(0, head) + note + text.slice(-(max - head - note.length)), trimmed: true };
}
module.exports = { AnswerStream, errorInfo, trimContext };
