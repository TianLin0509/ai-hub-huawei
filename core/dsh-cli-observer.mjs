// Native DSH observation only. The TUI owns stdin, tools and human decisions.
// No ACP server, transport or execution proxy is loaded by this extension.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const name = 'hub-dsh-cli-observer';
export const inject = ['agents', 'sessions'];
export function apply(ctx) {
  const file = process.env.AI_HUB_DSH_EVENT_LOG;
  if (!file) throw new Error('Missing Hub native DSH event log');
  const append = row => fs.appendFileSync(file, JSON.stringify(row) + '\n');
  let root;
  const isRoot = agent => ctx.agents.roots().includes(agent);
  // /fork creates a detached root; only the TUI's foreground discovery record
  // can change Hub's binding. /new and /resume publish that record themselves.
  const bindForeground = () => {
    let entries; try { entries = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.dsh-tui/inject/servers.json'), 'utf8')); } catch { return; }
    const id = Array.isArray(entries) && entries.find(e => e.pid === process.pid)?.sessionId;
    const agent = id && ctx.agents.get(id);
    if (!agent || agent === root || !isRoot(agent)) return;
    root = agent;
    append({ type: 'bound', sessionId: String(agent.id), cwd: agent.session.header.cwd,
      model: agent.options.model, effort: agent.options.reasoningEffort, status: agent.status, events: agent.session.snapshotEvents() });
  };
  const timer = setInterval(bindForeground, 50);
  ctx.effect(() => () => clearInterval(timer));
  ctx.on('session/event', (session, event) => {
    if (root?.session === session) append({ type: 'event', sessionId: String(session.id), event });
  });
  ctx.on('agent/status', ({ agent, status }) => {
    if (root === agent) append({ type: 'status', sessionId: String(agent.id), status });
  });
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (root === agent) append({ type: 'stream', sessionId: String(agent.id), frame });
  });
  ctx.on('agent/error', ({ agent, error }) => {
    if (root === agent) append({ type: 'error', sessionId: String(agent.id), message: error.message });
  });
  ctx.on('user-questions/request', async (request, next) => {
    if (request.agent !== root) return next();
    const sessionId = String(root.id);
    append({ type: 'waiting', sessionId });
    try { return await next(); }
    finally { append({ type: 'status', sessionId, status: 'running' }); }
  });
  askAside(ctx, () => root, append);
  ctx.provide('hubCliObserver', true);
}

// 「问一下」：Hub 把问题写成 <id>.ask.json 放进 AI_HUB_DSH_ASK_DIR。这里照 DSH 自带 /btw
// （dsh-tui dsh-adapter/channel/session-metadata.js 的 sideQuestion）作答：重放主会话已派生
// 的历史、去掉还在执行的工具调用、单轮无工具，作为主会话的旁支发起（共享前缀缓存）。
// 回答只写进事件日志，不进会话记录，也不碰 TUI 输入框，主会话照常工作。
// 和 Claude 那条路一样要求简短作答；主会话正在长篇输出时，否则模型容易顺着主任务接着写。
const SHORT = '请简短回答（10 行以内）：';
function askAside(ctx, getRoot, append) {
  const dir = process.env.AI_HUB_DSH_ASK_DIR;
  if (!dir) return;
  // AI_HUB_DSH_CLI_ENTRY = <modules>/@deepseek-ai/dsh/lib/bin.js
  const modules = path.resolve(process.env.AI_HUB_DSH_CLI_ENTRY || '', '../../../..');
  const load = (rel) => import(pathToFileURL(path.join(modules, rel)).href);
  let lib;
  const libs = () => lib ||= Promise.all([
    load('@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/sideQuestion.js'),
    load('@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/compat/liveSession.js'),
    load('@deepseek-ai/dsh-llm/lib/index.js'),
  ]);
  const busy = new Set();
  const answer = async ({ id, question, timeoutMs }) => {
    const reply = row => append({ type: 'btw', id, ...row });
    try {
      const agent = getRoot();
      if (!agent) return reply({ error: 'DSH 会话还没就绪，请等首轮开始后再问' });
      const llm = ctx.get('llm');
      if (typeof llm?.stream !== 'function') return reply({ error: 'DSH 模型服务不可用' });
      const [side, live, dshLlm] = await libs();
      const session = agent.session;
      const derive = () => side.splitUnresolvedToolCalls(session.deriveMessages(), side.openStepToolCallIds(live.snapshotLiveSessionEvents(session)));
      let history = derive();
      // 主会话刚答完时，回答已经显示但可能还没进派生历史（2026-11-07 实测：紧接着问，模型只看到「请记住暗号」
      // 就答成了 OK）。主会话已经停下却还停在用户请求上，就最多等 3 秒让历史跟上。
      for (let i = 0; i < 30 && history.messages.at(-1)?.role === 'user' && agent.status !== 'running'; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        history = derive();
      }
      const header = session.requestHeader?.();
      const config = header?.config || {};
      // 主会话刚收到、还没答完的请求排在历史末尾时，旁问紧跟其后，模型容易把两条都当待办、顺着主任务往下写
      // （2026-11-07 真实 DSH 实测：主会话运行中旁问，答成了主任务的代码）。历史保持原样（刚答完时最后一条
      // 回答可能还没进历史，摘掉请求会丢上下文），只在旁问里点明那条请求不用管。
      const last = history.messages.at(-1);
      const note = last?.role === 'user' && agent.status === 'running'
        ? '（上面最后那条用户请求主会话还在处理，这里不要回答或继续它；只回答下面的旁支问题。）\n' : '';
      const messages = [...history.messages, dshLlm.createUserMessage({
        content: [{ type: 'text', text: side.wrapSideQuestion(note + SHORT + String(question), history.pending) }], source: { kind: 'dsh-tui-btw' } })];
      const signal = AbortSignal.timeout(Math.max(10000, Number(timeoutMs) || 180000));
      const options = {
        provider: config.provider ?? agent.options?.provider, model: config.model ?? agent.options?.model, messages,
        ...(!messages.some(m => m.role === 'system') && typeof header?.system === 'string' && { system: header.system }),
        ...(config.reasoningEffort !== undefined && { reasoningEffort: config.reasoningEffort }),
        ...(config.temperature !== undefined && { temperature: config.temperature }),
        ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
        sessionId: session.id, signal,
      };
      const once = () => side.runAsSideBranch(ctx.agents, agent,
        () => side.runSideQuestion({ stream: llm.stream.bind(llm), options, signal }));
      let outcome = await once();
      // 模型服务偶发超时或断连（2026-11-07 实测 10 秒报 Request timed out）：只对这类错误自动再问一次。
      if (!outcome.answer && !signal.aborted && /timed? ?out|ECONNRESET|socket hang up|fetch failed|network/i.test(outcome.error || '')) outcome = await once();
      reply(outcome.answer ? { answer: outcome.answer } : { error: signal.aborted ? 'DSH 超时没答完，已停止' : (outcome.error || 'DSH 没有给出回答') });
    } catch (error) { reply({ error: error?.message || String(error) }); }
  };
  const poll = setInterval(() => {
    let names; try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.ask.json') || busy.has(name)) continue;
      const file = path.join(dir, name);
      let request; try { request = JSON.parse(fs.readFileSync(file, 'utf8')); fs.unlinkSync(file); } catch { continue; }
      busy.add(name);
      answer(request).finally(() => busy.delete(name));
    }
  }, 150);
  ctx.effect(() => () => clearInterval(poll));
}
