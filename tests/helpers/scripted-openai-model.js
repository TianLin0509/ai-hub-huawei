'use strict';
// 本机脚本模型（R58b）：一个 OpenAI 兼容的 /chat/completions 服务，给真实 CLI（如 DSH）当模型用，不联网、不花钱。
// 第一轮：从开工消息里取出 hub-team 命令路径和暗号，按请求里的命令类工具回一个 tool_call，让 CLI 真的去跑这条命令；
// 工具结果回来后：回一句文字收尾。其余辅助请求（起标题等）回一句短文字。只记录请求的形状（工具名、角色），不记正文。
const http = require('node:http');

const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('\n') : '';

function pickTool(tools = []) {
  const fns = tools.map(t => t?.function || t).filter(f => f?.name);
  const tool = fns.find(f => /bash|shell|terminal|command|exec|run/i.test(f.name) && f.parameters?.properties)
    || fns.find(f => f.parameters?.properties?.command);
  if (!tool) return null;
  const props = tool.parameters.properties || {};
  const key = props.command ? 'command' : props.cmd ? 'cmd' : (tool.parameters.required || []).find(k => props[k]?.type === 'string')
    || Object.keys(props).find(k => props[k]?.type === 'string');
  // 其他必填字段（如 pwsh 的 description）按类型补一个占位值，不然 CLI 会拒绝这次调用。
  const extra = {};
  for (const k of tool.parameters.required || []) if (k !== key && props[k]) extra[k] = props[k].type === 'string' ? '向负责人交回回执' : props[k].type === 'boolean' ? false : props[k].type === 'number' || props[k].type === 'integer' ? 60000 : undefined;
  return key ? { name: tool.name, key, extra, powershell: /powershell|pwsh/i.test(`${tool.name} ${tool.description || ''} ${props[key]?.description || ''}`) } : null;
}

function plan(body, state) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const all = messages.map(m => textOf(m.content)).join('\n');
  const toolDone = messages.some(m => m.role === 'tool');
  const cmdPath = (all.match(/"([^"\n]*hub-team\.cmd)"/) || [])[1];
  const token = (all.match(/R58B-MIX-[A-Z-]+-[a-z0-9]+/i) || [])[0];
  const tool = pickTool(body.tools);
  if (!toolDone && cmdPath && token && tool && state.calls < 2) {
    const quoted = `"${cmdPath.replace(/\\/g, '/')}"`;
    const command = `${tool.powershell ? '& ' : ''}${quoted} send --to lead --deliver --message "${token} 已收到开工任务"`;
    state.calls++;
    return { tool: tool.name, args: { ...tool.extra, [tool.key]: command } };
  }
  return { text: toolDone ? '已按开工任务交回负责人。' : '收到。' };
}

function chunk(model, delta, finish = null, usage) {
  return `data: ${JSON.stringify({ id: 'r58b', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
}

function startScriptedModel({ log = () => {} } = {}) {
  const state = { calls: 0, requests: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      if (req.method === 'GET' && /\/models$/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'scripted-model', object: 'model' }] })); return;
      }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      const step = plan(body, state);
      const shape = { url: req.url, stream: !!body.stream, roles: (body.messages || []).map(m => m.role),
        tools: (body.tools || []).map(t => (t.function || t).name), reply: step.tool ? `tool:${step.tool}` : 'text',
        ...(step.args ? { args: step.args } : {}),
        // 工具结果只留前 400 字，方便看命令有没有跑成；这里只有命令输出，没有密钥。
        toolResult: (body.messages || []).filter(m => m.role === 'tool').map(m => textOf(m.content).slice(0, 400)) };
      state.requests.push(shape); log(shape);
      const model = body.model || 'scripted-model';
      const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        if (step.tool) {
          res.write(chunk(model, { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_r58b_${state.calls}`, type: 'function',
            function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }));
          res.write(chunk(model, {}, 'tool_calls', usage));
        } else {
          res.write(chunk(model, { role: 'assistant', content: step.text }));
          res.write(chunk(model, {}, 'stop', usage));
        }
        res.end('data: [DONE]\n\n'); return;
      }
      const message = step.tool
        ? { role: 'assistant', content: null, tool_calls: [{ id: `call_r58b_${state.calls}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }
        : { role: 'assistant', content: step.text };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'r58b', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message, finish_reason: step.tool ? 'tool_calls' : 'stop' }], usage }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    baseURL: `http://127.0.0.1:${server.address().port}/v1`, state, close: () => new Promise(r => server.close(() => r())) })));
}

module.exports = { startScriptedModel, pickTool };
