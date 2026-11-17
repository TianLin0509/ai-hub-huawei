// Hub 观察扩展：随 pi 终端（-e 加载）运行，把会话身份、轮次状态和消息写进 Hub 指定的事件日志。
// 只观察、不改 pi 的行为；Hub 读这份日志驱动卡片、状态和发送回执（core/pi-cli-session.js）。
import fs from 'node:fs';

const LOG = process.env.AI_HUB_PI_EVENT_LOG;
const write = row => {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...row }) + '\n'); } catch {}
};
const modelOf = ctx => ctx?.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
const textOf = content => typeof content === 'string' ? content
  : (content || []).filter(b => b?.type === 'text').map(b => b.text || '').join('\n');

export default function hubObserver(pi) {
  // Hub 已有钥匙的模型线路（Token Plan、公司模型）：配置由 Hub 经环境变量给，钥匙写成 $变量名，不落盘。
  try {
    const providers = JSON.parse(process.env.AI_HUB_PI_PROVIDERS || '{}');
    for (const [name, config] of Object.entries(providers)) pi.registerProvider(name, config);
  } catch (error) { write({ type: 'error', message: 'Hub 模型线路注册失败：' + error.message }); }
  let sessionId = null, lastPartial = 0;
  const bind = (ctx, reason) => {
    const sm = ctx.sessionManager;
    sessionId = sm?.getSessionId?.() || null;
    write({ type: 'bound', reason, sessionId, sessionFile: sm?.getSessionFile?.() || null,
      cwd: ctx.cwd, model: modelOf(ctx), thinking: pi.getThinkingLevel?.() || null, pid: process.pid });
  };
  pi.on('session_start', async (event, ctx) => bind(ctx, event.reason));
  pi.on('agent_start', async () => write({ type: 'status', sessionId, status: 'running' }));
  pi.on('agent_settled', async event => write({ type: 'settled', sessionId, aborted: event?.aborted === true }));
  pi.on('ui_prompt_start', async event => write({ type: 'waiting', sessionId, title: String(event?.title || '') }));
  pi.on('ui_prompt_end', async () => write({ type: 'status', sessionId, status: 'running' }));
  pi.on('model_select', async event => write({ type: 'model', sessionId,
    model: event?.model ? { provider: event.model.provider, id: event.model.id } : null }));
  pi.on('thinking_level_select', async event => write({ type: 'thinking', sessionId, level: event?.level || null }));
  pi.on('message_update', async event => {
    const now = Date.now();
    if (now - lastPartial < 250 || event?.message?.role !== 'assistant') return;
    lastPartial = now;
    write({ type: 'partial', sessionId, text: textOf(event.message.content) });
  });
  pi.on('message_end', async event => {
    const message = event?.message;
    if (!message || !['user', 'assistant', 'toolResult'].includes(message.role)) return;
    write({ type: 'message', sessionId, message });
  });
}
