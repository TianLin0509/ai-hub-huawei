// R49（2026-11-26 群里反馈）：经 API 网关时报「API Error:400 … 网关原话：System message must be at the beginning.」。
// Qwen 等模型的对话模板只认开头那一条 system。实测真实 CLI 发出的形态：Claude Code 2.1.322 是 system, user, system；
// Codex 0.171 是 system, system, user, user。反代发往网关前要把所有 system 合并成一条放最前面。
// 模拟网关照 Qwen 模板的规则：第一条以外出现 system 就回 400。撤掉 gateway-provider.mjs 的 systemFirst，这里的用例会失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../core/company-proxy/server.mjs';
import { gatewayBody, systemFirst } from '../core/company-proxy/gateway-provider.mjs';

const KEY = 'sk-r49-gateway';
const MODELS = ['qwen-aw-35b', 'deepseek-v4.1-flash'];

test('合并：中间的 system、开头连着的两条 system、developer 都并成第一条，顺序与正文不丢', () => {
  const claudeShape = gatewayBody({ model: 'm', messages: [
    { role: 'system', content: 'base prompt' },
    { role: 'user', content: 'hi' },
    { role: 'system', content: '# Environment\ncwd=D:/x' },
  ] });
  assert.deepEqual(claudeShape.messages.map(m => m.role), ['system', 'user']);
  assert.equal(claudeShape.messages[0].content, 'base prompt\n\n# Environment\ncwd=D:/x');
  assert.equal(claudeShape.messages[1].content, 'hi');

  const codexShape = gatewayBody({ model: 'm', messages: [
    { role: 'system', content: 'instructions' },
    { role: 'system', content: [{ type: 'text', text: '<permissions>' }] },
    { role: 'user', content: 'AGENTS.md' },
    { role: 'developer', content: 'model switched' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ] });
  assert.deepEqual(codexShape.messages.map(m => m.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(codexShape.messages[0].content, 'instructions\n\n<permissions>\n\nmodel switched');
  assert.equal(codexShape.messages[3].tool_call_id, 'c1');
});

test('只有开头一条 system、或没有 system：原样不动', () => {
  const one = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  assert.equal(systemFirst(one), one);
  const none = [{ role: 'user', content: 'u' }];
  assert.equal(systemFirst(none), none);
  assert.deepEqual(systemFirst([{ role: 'user', content: 'u' }, { role: 'system', content: '' }]), [{ role: 'user', content: 'u' }], '空的 system 不留一条空壳');
});

// ---------- 模拟网关（Qwen 模板规则）+ 真实反代进程逻辑 ----------
async function startStrictGateway() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.headers.authorization !== 'Bearer ' + KEY) { res.writeHead(401); return res.end(); }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: MODELS.map(id => ({ id })) })); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const roles = body.messages.map(m => m.role);
    seen.push(roles.join(','));
    if (roles.some((role, i) => role === 'system' && i > 0)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end('{"error":{"message":"System message must be at the beginning.","type":"BadRequestError","code":400}}');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const f of [{ id: 'c', model: 'q', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' } }] },
      { id: 'c', model: 'q', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: 'c', model: 'q', choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }]) res.write('data: ' + JSON.stringify(f) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, seen, origin: `http://127.0.0.1:${server.address().port}` };
}
async function startProxy(t, gatewayOrigin) {
  const dataDir = await mkdtemp(join(tmpdir(), 'r49-proxy-'));
  const key = 'b'.repeat(48);
  const running = main(['--data-dir', dataDir, '--port', '0', '--mock-upstream'], { env: { AI_HUB_COMPANY_PROXY_KEY: key,
    AI_HUB_API_GATEWAY_URL: gatewayOrigin + '/v1', AI_HUB_API_GATEWAY_KEY: KEY, AI_HUB_API_GATEWAY_MODELS: MODELS.join(','), AI_HUB_API_GATEWAY_MODEL: 'qwen-aw-35b' } });
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) { try { port = JSON.parse(await readFile(join(dataDir, 'company-model-proxy', 'proxy-state.json'), 'utf8')).port; } catch { await new Promise(r => setTimeout(r, 50)); } }
  assert.ok(port, 'proxy listening');
  const origin = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await fetch(origin + '/admin/shutdown', { method: 'POST', headers: { authorization: 'Bearer ' + key } }).catch(() => {});
    await running.catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  });
  return { origin, key };
}

test('真实反代：Claude Code 2.1.322 的 system, user, system 形态经网关不再 400', async t => {
  const gw = await startStrictGateway(); t.after(() => gw.server.close());
  const p = await startProxy(t, gw.origin);
  const res = await fetch(p.origin + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': `${p.key}.r49claude__gw`, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'qwen-aw-35b', max_tokens: 256, stream: false, system: [{ type: 'text', text: 'You are Claude Code.' }],
      messages: [{ role: 'user', content: 'say ok' }, { role: 'system', content: '# Environment\nPrimary working directory: D:/w' }] }) });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).content.find(b => b.type === 'text').text, 'OK');
  assert.deepEqual(gw.seen, ['system,user']);
});

test('真实反代：Codex 的 instructions + developer（两条 system）经网关不再 400', async t => {
  const gw = await startStrictGateway(); t.after(() => gw.server.close());
  const p = await startProxy(t, gw.origin);
  const res = await fetch(p.origin + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}.r49codex__gw` },
    body: JSON.stringify({ model: 'qwen-aw-35b', stream: true, instructions: 'You are Codex.',
      input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'say ok' }] }] }) });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /response\.completed/);
  assert.deepEqual(gw.seen, ['system,user']);
});
