'use strict';

// 超时只结束界面等待，原唤醒请求和 CLI 进程仍由主进程管理。
function createDormantResumeWatch({ onTimeout, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const attempts = new Map();
  return {
    start(id, { restart = false } = {}) {
      const previous = attempts.get(id);
      if (previous && !restart) return;
      if (previous) clearTimer(previous.timer);
      const attempt = { timedOut: false, timer: null };
      attempts.set(id, attempt);
      attempt.timer = setTimer(() => {
        if (attempts.get(id) !== attempt) return;
        attempt.timedOut = true;
        onTimeout(id);
      }, 90_000);
    },
    isTimedOut(id) { return attempts.get(id)?.timedOut === true; },
    finish(id) {
      const attempt = attempts.get(id);
      if (attempt) clearTimer(attempt.timer);
      attempts.delete(id);
    },
  };
}

module.exports = { createDormantResumeWatch };
