'use strict';
const { cancelled } = require('../../core/help-ask/request-lifecycle');
// A meeting retains one process slot even when ordinary side questions are busy.
class QuestionSlots {
  constructor({ max = 3, reserved = 1 } = {}) { this.max = max; this.reserved = reserved; this.running = 0; this.ordinary = 0; this.waiters = []; this.closed = false; }
  stats() { return { running: this.running, max: this.max }; }
  available(meeting) { return this.running < this.max && (meeting || this.ordinary < this.max - this.reserved); }
  acquire({ meeting = false, signal, onWait = () => {} } = {}) {
    if (this.closed) return Promise.resolve(null);
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : cancelled());
    if (this.available(meeting)) return Promise.resolve(this.claim(meeting));
    onWait(this.stats());
    return new Promise((resolve, reject) => {
      const waiter = { meeting, signal, onWait, resolve, reject };
      waiter.abort = () => { this.waiters = this.waiters.filter(w => w !== waiter); signal.removeEventListener('abort', waiter.abort); reject(signal.reason instanceof Error ? signal.reason : cancelled()); };
      signal?.addEventListener('abort', waiter.abort, { once: true }); this.waiters.push(waiter);
      if (signal?.aborted) waiter.abort();
    });
  }
  claim(meeting) { this.running++; if (!meeting) this.ordinary++; return { meeting, released: false }; }
  release(token) {
    if (!token || token.released) return; token.released = true; this.running--; if (!token.meeting) this.ordinary--;
    // Meeting waiters first; ordinary questions still progress through their other slots.
    for (;;) {
      let index = this.waiters.findIndex(w => w.meeting && this.available(true));
      if (index < 0) index = this.waiters.findIndex(w => this.available(w.meeting));
      if (index < 0) break;
      const [w] = this.waiters.splice(index, 1); w.signal?.removeEventListener('abort', w.abort); w.resolve(this.claim(w.meeting));
    }
    for (const w of this.waiters) w.onWait(this.stats());
  }
  dispose() { this.closed = true; for (const w of this.waiters.splice(0)) { w.signal?.removeEventListener('abort', w.abort); w.resolve(null); } }
}
module.exports = { QuestionSlots };
