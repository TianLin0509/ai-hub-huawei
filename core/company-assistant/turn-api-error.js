'use strict';
// 助理会话这一轮是不是以「模型接口报错」收场（2026-11-22 F7 复现「PPT 做页十分钟没结果」）：
// CodeAgent（Claude 格式记录）在 401 / 402 / 429 这类错误重试完后，只写一条带 isApiErrorMessage 的回答就停下，
// 没有 end_turn 的正常回答，Hub 读不到「答完」，PPT 做页因此一直停在「助理已开始写页面内容」。
// 这里只读原生记录的末尾：最后一条回答（assistant）是 API 错误时返回 { id, text }，否则返回 null。
const fs = require('node:fs');

const TAIL_BYTES = 256 * 1024;

function apiErrorText(row) {
  const c = row.message && row.message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => String(b.text || '')).join(' ') : '';
  const hit = row.isApiErrorMessage === true || !!row.error || (row.message && row.message.model === '<synthetic>' && /^\s*API\s*Error/i.test(text));
  return hit ? text.trim() : '';
}

function lastApiError(file, { tailBytes = TAIL_BYTES } = {}) {
  if (!file) return null;
  let fd;
  try {
    const size = fs.statSync(file).size, start = Math.max(0, size - tailBytes), buf = Buffer.alloc(size - start);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // 跳过被截断的第一行
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes('"assistant"')) continue;
      let row; try { row = JSON.parse(lines[i]); } catch { continue; }
      if (row.type !== 'assistant' || row.isSidechain) continue;
      const hit = apiErrorText(row);
      if (!hit) return null; // 最后一条回答是正常内容：这一轮没有以报错收场
      return { id: row.uuid || String(row.timestamp || ''), text: hit };
    }
    return null;
  } catch { return null; } // 记录还没建好或读不了：说不准，照旧按时限等
  finally { if (fd != null) try { fs.closeSync(fd); } catch { /* 已关闭 */ } }
}

// 给用户看的一句话：原文去掉「Please run /login ·」这类 CLI 提示，留住状态码和服务端说明。
function describe(text, session = {}) {
  const raw = String(text || '').replace(/^\s*Please run \/login\s*[·:：-]\s*/i, '').replace(/\s+/g, ' ').trim();
  if (/\b(?:404|405|501)\b|method not allowed|unsupported (?:method|endpoint)/i.test(raw)) {
    const info = require('../codeagent-assistant-route').connection(session.codeagentConfigDir, session.codeagentModelProvider);
    const provider = session.codeagentModelProviderLabel || info.provider || '未确认的供应商', address = info.address;
    return { kind: `供应商「${provider}」${address ? `（${address}）` : '（地址未能读取）'}的接口不接受对话请求`,
      detail: raw.slice(0, 160), routeRejected: true, account: session.codeagentPoolAccount || 'personal' };
  }
  const kind = /\b401\b|authenticat|invalid api key|unauthori/i.test(raw) ? '模型账号鉴权失败（登录过期或密钥无效）'
    : /\b429\b|rate.?limit|too many requests|限流/i.test(raw) ? '模型接口限流'
      : /\b402\b|quota|余额|insufficient|credit/i.test(raw) ? '模型额度不足'
        : '模型接口报错';
  return { kind, detail: raw.slice(0, 160) };
}

module.exports = { lastApiError, describe };
