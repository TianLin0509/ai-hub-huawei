'use strict';

// 主进程统一写入并读回系统剪贴板。规则（2026-10-24 用户确认）：
// - 用户在 Hub 里的手动复制优先：剪贴板被别的程序占着时持续重试约 5 秒，而不是很快放弃；
// - 不锁剪贴板：之后任何复制（Hub 内或其他程序）都能覆盖它；
// - Hub 内新复制到达，旧重试立即作废；读回发现别的程序写入了更新的内容，也立即停手，不再覆盖。
const DEFAULT_RETRY_DELAYS_MS = [0, 20, 50, 100, 200, 400, 600, 800, 1000, 1000, 1000];

function createVerifiedClipboardWriter({ clipboard, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS } = {}) {
  let sequence = 0;
  const normalize = value => String(value ?? '').replace(/\r\n?/g, '\n');
  const readSafe = () => { try { return normalize(clipboard.readText()); } catch { return null; } };
  async function writeText(value, formats = {}) {
    const request = ++sequence;
    const text = String(value ?? '');
    const result = { ok: false, length: Array.from(text).length, attempts: 0 };
    const superseded = extra => ({ ...result, reason: 'superseded', ...extra });
    if (!text) return { ...result, reason: 'empty' };
    if (!clipboard?.writeText || !clipboard?.readText) return { ...result, reason: 'clipboard-unavailable' };
    const wanted = normalize(text);
    // 最近一次有效读回。剪贴板被占用时读到的是空串，不算数；两次有效读回之间内容变了、
    // 又不是我们要写的，才说明别的程序有更新的复制。
    const known = value => (value ? value : null);
    let lastSeen = known(readSafe());
    for (const delay of retryDelaysMs) {
      if (delay) await wait(delay);
      if (request !== sequence) return superseded();
      result.attempts++;
      try {
        // Electron's main-process API is synchronous; the first write has no retry delay.
        if (typeof formats?.html === 'string' && formats.html) clipboard.write({ text, html: formats.html });
        else clipboard.writeText(text);
        // Cross an event-loop turn before reading, instead of trusting the renderer's cached value.
        await wait(0);
        if (request !== sequence) return superseded();
        const current = readSafe();
        if (current === wanted) return { ...result, ok: true };
        if (known(current) && lastSeen && current !== lastSeen) return superseded({ external: true });
        if (known(current)) lastSeen = current;
        result.reason = 'clipboard verification mismatch';
      } catch (error) {
        result.reason = error.message || 'clipboard-write-failed';
      }
    }
    return result;
  }
  // Screenshot writes share the same ordering as text copies.
  writeText.beginExternalWrite = () => { const request = ++sequence; return () => request === sequence; };
  // 截图等非文本写入复用同一套重试节奏；isCurrent 为假（有更新的复制）时立即停手。
  writeText.retry = async (attempt, isCurrent = () => true) => {
    let lastError = null;
    for (const delay of retryDelaysMs) {
      if (delay) await wait(delay);
      if (!isCurrent()) return { ok: false, reason: 'superseded' };
      try { if (await attempt()) return { ok: true }; } catch (error) { lastError = error; }
    }
    return { ok: false, reason: lastError?.message || 'clipboard-write-failed' };
  };
  return writeText;
}

module.exports = { createVerifiedClipboardWriter, DEFAULT_RETRY_DELAYS_MS };
