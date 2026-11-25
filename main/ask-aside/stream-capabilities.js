'use strict';
// Process-local CLI capability cache. Only explicit argument rejection may trigger a retry;
// received protocol events/answer text mean the request may already have reached the model.
class StreamCapabilities {
  constructor({ limit = 64 } = {}) { this.limit = limit; this.entries = new Map(); }
  key(config = {}) { return [config.flavor || 'codeagent', config.command || ''].join('|'); }
  get(config) { return { stream: true, partial: true, effort: true, ...(this.entries.get(this.key(config)) || {}) }; }
  update(config, patch) {
    const key = this.key(config), value = { ...this.get(config), ...patch }; this.entries.delete(key); this.entries.set(key, value);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
    return value;
  }
  rejected(config, error, { sawJson = false, answer = '' } = {}) {
    if (sawJson || String(answer || '').trim()) return null;
    const text = String(error?.message || error || '');
    if (!/unknown|unrecognized|unexpected|unsupported|not support|invalid|不支持|未知|无效/i.test(text)) return null;
    if (/--effort|effort\s+(?:option|argument|flag)/i.test(text) && this.get(config).effort) return this.update(config, { effort: false });
    if (/--include-partial-messages|partial.messages/i.test(text) && this.get(config).partial) return this.update(config, { partial: false });
    if (/stream-json|--output-format/i.test(text) && this.get(config).stream) return this.update(config, { stream: false, partial: false });
    return null;
  }
  observed(config, result = {}) { if (result.fallbackText) this.update(config, { stream: false, partial: false }); }
}
module.exports = { StreamCapabilities };
