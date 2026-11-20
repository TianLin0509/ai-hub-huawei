'use strict';
// 假的部门 API 网关（New API 形态，2026-11-20）：开发机连不上真网关，单测、集成测试和体检脚本自测都用它。
//   GET  /api/pricing            公开目录（不要 key），内容取 tests/fixtures/ascend-pricing-20261120.json（11-20 黄区实测还原）
//   GET  /v1/models              这把 key 能用的模型（默认 free 分组的 4 个）
//   POST /v1/chat/completions    流式；每个模型一种回法，覆盖黄区见过和疑似的几种流形态：
//     deepseek-v4.1-flash  正常：先正文后工具调用
//     glm-5.3-flash        先 reasoning_content 思考，再调工具
//     qwen-aw-35b          每段都带空 tool_calls: []、data: 后不带空格，只回正文（不调工具）
//     qwen3.8-27b          503「No available channel for model … under group free」
//   models 里的其他名字可以用 behaviors 指定：'401' '403-whitelist' 'quota' '429' 'context' 'hang' 'normal' 'reasoning' 'empty-tools' 'no-channel'
//     'think-only'（只出思考、到输出上限 finish_reason=length 也没正文；11-20 黄区实测 qwen-aw-35b 的样子）
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const PRICING = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'ascend-pricing-20261120.json'), 'utf8'));
const FREE = ['qwen-aw-35b', 'deepseek-v4.1-flash', 'qwen3.8-27b', 'glm-5.3-flash'];
const DEFAULT_BEHAVIORS = { 'deepseek-v4.1-flash': 'normal', 'glm-5.3-flash': 'reasoning', 'qwen-aw-35b': 'empty-tools', 'qwen3.8-27b': 'no-channel' };

function sse(res, frames, { noSpace = false, delayMs = 0 } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let i = 0;
  const next = () => {
    if (i >= frames.length) return res.end();
    const f = frames[i++];
    res.write((noSpace ? 'data:' : 'data: ') + (typeof f === 'string' ? f : JSON.stringify(f)) + '\n\n');
    if (delayMs) setTimeout(next, delayMs); else next();
  };
  next();
}
function jsonError(res, status, message, code = '') {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code, message, type: 'new_api_error' } }));
}

async function startFakeAscend({ key = 'fake-ascend-key-0001', keyModels = FREE, behaviors = {}, pricing = PRICING, firstDelayMs = 0, pricingStatus = 200 } = {}) {
  const seen = [];
  const plan = { ...DEFAULT_BEHAVIORS, ...behaviors };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.method === 'GET' && req.url === '/api/pricing') {
      if (pricingStatus !== 200) { res.writeHead(pricingStatus); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json', 'x-new-api-version': 'v0.0.0' }); return res.end(JSON.stringify(pricing));
    }
    if (req.headers.authorization !== 'Bearer ' + key) return jsonError(res, 401, 'Invalid token');
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', success: true, data: keyModels.map(id => ({ id, object: 'model', owned_by: 'custom', supported_endpoint_types: ['openai'] })) }));
    }
    if (!(req.method === 'POST' && req.url === '/v1/chat/completions')) { res.writeHead(404); return res.end(); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.push(body);
    const model = body.model;
    const behavior = plan[model] || (keyModels.includes(model) ? 'normal' : 'no-channel');
    const id = 'chatcmpl-fake', alias = 'alias-' + String(model).slice(0, 6);
    // 只有一键体检的试跑（带 get_time 工具）才回工具调用；Claude Code / Codex 的正常对话回正文，免得假网关替它们乱调工具。
    const wantsTool = Array.isArray(body.tools) && body.tools.some(t => t?.function?.name === 'get_time');
    const toolName = wantsTool ? body.tools[0].function?.name || 'tool' : '';
    const go = () => {
      switch (behavior) {
        case '401': return jsonError(res, 401, 'Invalid token');
        case '403-whitelist': return jsonError(res, 403, '该令牌无权使用模型：' + model + '（模型不在白名单中）');
        case 'quota': return jsonError(res, 403, '用户额度不足，剩余额度：0', 'insufficient_user_quota');
        case '429': return jsonError(res, 429, 'Too Many Requests');
        case 'context': return jsonError(res, 400, `This model's maximum context length is 262144 tokens. However, you requested 300000 tokens.`, 'context_length_exceeded');
        case 'no-channel': return jsonError(res, 503, `No available channel for model ${model} under group free (distributor)`, 'model_not_found');
        case 'hang': return; // 首字一直不来
        case 'empty-tools':
          return sse(res, [
            { id, model: alias, choices: [{ index: 0, delta: { role: 'assistant', content: '', tool_calls: [] } }] },
            { id, model: alias, choices: [{ index: 0, delta: { content: '现在', tool_calls: [] } }] },
            { id, model: alias, choices: [{ index: 0, delta: { content: '是下午三点', tool_calls: [] } }] },
            { id, model: alias, choices: [{ index: 0, delta: { tool_calls: [] }, finish_reason: 'stop' }] },
            { id, model: alias, choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }, '[DONE]'], { noSpace: true });
        case 'think-only':
          return sse(res, [
            { id, model: alias, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
            { id, model: alias, choices: [{ index: 0, delta: { reasoning: '先想一想……' } }] },
            { id, model: alias, choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }, '[DONE]']);
        case 'reasoning':
          return sse(res, [
            { id, model: alias, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
            { id, model: alias, choices: [{ index: 0, delta: { reasoning_content: '用户要查时间，' } }] },
            { id, model: alias, choices: [{ index: 0, delta: { reasoning_content: '调用工具。' } }] },
            ...(wantsTool ? [{ id, model: alias, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_r', type: 'function', function: { name: toolName, arguments: '{}' } }] } }] },
              { id, model: alias, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]
              : [{ id, model: alias, choices: [{ index: 0, delta: { content: 'OK' } }] }, { id, model: alias, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]),
            '[DONE]']);
        default:
          return sse(res, [
            { id, model: alias, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
            ...(wantsTool ? [{ id, model: alias, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: toolName, arguments: '' } }] } }] },
              { id, model: alias, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] },
              { id, model: alias, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]
              : [{ id, model: alias, choices: [{ index: 0, delta: { content: 'O' } }] }, { id, model: alias, choices: [{ index: 0, delta: { content: 'K' } }] },
                { id, model: alias, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]),
            { id, model: alias, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }, '[DONE]']);
      }
    };
    if (firstDelayMs) setTimeout(go, firstDelayMs); else go();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, baseURL: origin + '/v1', key, seen, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

module.exports = { startFakeAscend, PRICING, FREE, DEFAULT_BEHAVIORS };
