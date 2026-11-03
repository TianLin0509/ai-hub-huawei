'use strict';
const { timingSafeEqual } = require('node:crypto');

async function handleTeamRequest({ parsed, hookToken, teamTokenFor, service }) {
  const sid = parsed?.sessionId;
  const supplied = parsed?.teamToken;
  const expected = typeof sid === 'string' && /^[\w-]{4,80}$/.test(sid) ? teamTokenFor(sid) : null;
  if (parsed?.token !== hookToken || typeof supplied !== 'string' || typeof expected !== 'string'
      || !/^[a-f0-9]{64}$/.test(supplied) || !/^[a-f0-9]{64}$/.test(expected)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return { statusCode: 403, body: { error: '团队会话身份校验失败' } };
  }
  if (!service) return { statusCode: 503, body: { error: '组队服务没有启动' } };
  try {
    const result = await service.invoke(sid, String(parsed.action || ''), parsed.args && typeof parsed.args === 'object' ? parsed.args : {});
    return { statusCode: 200, body: { result } };
  } catch (error) {
    return { statusCode: 400, body: { error: String(error?.message || error) } };
  }
}

module.exports = { handleTeamRequest };
