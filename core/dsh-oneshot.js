'use strict';
// 后台单次功能（问答、摘要等）选了 DSH 外壳时：按所选来源起一个只读的卡片 ACP 进程，问一句、收齐回答就关。
// 和启动中心同一条建会话路径（core/dsh-cli-profile.js → core/acp-profiles.js），线路、Key、模型口径一致。
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');

const OWN_MISSING = 'DSH 还没填自有接口：请到「设置 → 自有 API → DSH → 自有接口」填写地址、Key 和模型';
const SOURCES = ['gateway', 'company', 'own'];

function defaultOwnConnection(kind) {
  return require('./company-api-config').ownConnection(require('./hub-config').readConfigJsonForUpdate(), kind);
}
function routeOverrides({ source, model }, ownConnection) {
  if (source !== 'own') return { dshBackend: 'proxy', dshUpstream: source, dshApiModel: model };
  const own = ownConnection('deepseek-acp');
  if (!own) throw new Error(OWN_MISSING);
  if (own.apiKeyNeedsInput) throw new Error(require('./own-api-secrets').KEY_NEEDED);
  return { dshBackend: 'api', dshUpstream: '', dshApiModel: model || own.model, dshApiBaseUrl: own.baseURL, dshApiKey: own.apiKey };
}
function redact(text) {
  try { return require('./hub-feedback').redact(text); } catch { return text; }
}
const failure = reason => new Error('所选模型未能回答：' + redact(String(reason || '没有返回内容')).replace(/\s+/g, ' ').slice(0, 200));
// 权限请求一律拒：后台功能只读，不能让模型改文件或跑命令；没有拒绝选项就按取消回。
function rejectPermission(params) {
  const reject = (params?.options || []).find(o => o.kind === 'reject_once') || (params?.options || []).find(o => o.kind === 'reject_always');
  return { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } };
}
// 每次一个独立目录，用完删掉；遇到链接只摘链接，不穿进目标目录。
function removeLinkSafe(target) {
  let st;
  try { st = fs.lstatSync(target); } catch { return; }
  if (st.isSymbolicLink()) { try { fs.unlinkSync(target); } catch { try { fs.rmdirSync(target); } catch { /* 留给下次 */ } } return; }
  if (!st.isDirectory()) { try { fs.unlinkSync(target); } catch { /* 留给下次 */ } return; }
  let names = [];
  try { names = fs.readdirSync(target); } catch { /* 读不了就只试删空目录 */ }
  for (const name of names) removeLinkSafe(path.join(target, name));
  try { fs.rmdirSync(target); } catch { /* 留给下次 */ }
}

async function run(selected, prompt, options = {}) {
  const {
    dataDir = require('./data-dir').getHubDataDir(), cwd, signal, timeoutMs = 60000, env = process.env, onActivity = () => {},
    getConfig = () => require('./hub-config').getConfig(),
    ensureProxy = async source => require('./feature-agent-choice').ensureProxy(source),
    ownConnection = defaultOwnConnection,
    AcpClient = require('../main/acp-client').AcpClient,
    buildOptions = (kind, opts, config, dir, e) => require('./dsh-cli-profile').buildDshCliOptions(kind, opts, config, dir, e),
  } = options;
  if (selected?.kind !== 'deepseek-acp' || !SOURCES.includes(selected.source)) throw new Error('DSH 单次任务的外壳或模型来源无效');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('问题不能为空');
  if (signal?.aborted) throw new Error('已取消');
  if (selected.source !== 'own') await ensureProxy(selected.source);
  const config = { ...getConfig(), companyCli: true, ...routeOverrides(selected, ownConnection) };
  // 不给 dshCardScope：会话目录按本次 id 单独建（dataDir/acp/<hash>），不和交互会话共用的卡片进程目录相撞。
  const tag = 'feature-' + crypto.randomBytes(4).toString('hex');
  const workDir = cwd || path.join(os.tmpdir(), 'hub-dsh-oneshot-' + tag);
  fs.mkdirSync(workDir, { recursive: true });
  let built = null, client = null, sessionId = null, timer = null, onAbort = null;
  const stop = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('所选模型回答超时'), { timedOut: true })), timeoutMs);
    onAbort = () => reject(Object.assign(new Error('已取消'), { cancelled: true }));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  stop.catch(() => {});
  const work = async () => {
    built = buildOptions('deepseek-acp', { id: tag, cwd: workDir, dshCardAcp: true, dshCardKeyTag: tag,
      permissionMode: 'plan', model: config.dshApiModel }, config, dataDir, env);
    client = new AcpClient({ ...built.launch, cwd: built.home || built.launch.cwd });
    let text = '';
    client.on('notification', message => {
      const update = message?.method === 'session/update' ? message.params?.update : null;
      // 只收正文；思考过程（agent_thought_chunk）不进结果。
      if (update?.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text' || typeof update.content.text !== 'string') return;
      text += update.content.text;
      try { onActivity(update.content.text); } catch { /* 进度回调出错不影响回答 */ }
    });
    client.on('request', message => {
      const reply = message.method === 'session/request_permission'
        ? client.respond(message.id, rejectPermission(message.params))
        : client.respond(message.id, null, { code: -32601, message: 'Unsupported ACP client method: ' + message.method });
      Promise.resolve(reply).catch(() => {});
    });
    client.on('diagnostic', () => {});
    try {
      await client.start();
      const created = await client.request('session/new', { cwd: workDir, mcpServers: [] });
      sessionId = created?.sessionId;
      if (!sessionId) throw new Error('DSH 没有建好会话');
      // 外壳提供权限档时切到只读档；不提供就靠启动时的 DSH_PERMISSION_MODE（只读沙箱）。
      const mode = (created.configOptions || []).find(o => o.category === 'mode');
      const offered = mode && (mode.options || []).flatMap(o => o.options || [o]).some(o => o.value === built.defaultMode);
      if (offered && mode.currentValue !== built.defaultMode) {
        await client.request('session/set_config_option', { sessionId, configId: mode.id, value: built.defaultMode });
      }
      const result = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, 0);
      if (result?.stopReason !== 'end_turn') throw new Error('结束原因 ' + (result?.stopReason || '未知'));
      if (!text.trim()) throw new Error('没有返回内容');
      return text.trim();
    } catch (error) { throw failure(error?.message); }
  };
  try {
    return await Promise.race([work(), stop]);
  } catch (error) {
    // 取消或超时：先告诉外壳停下这一轮（最多等半秒），再关进程。
    if ((error.cancelled || error.timedOut) && client && sessionId) {
      await Promise.race([Promise.resolve(client.notify('session/cancel', { sessionId })).catch(() => {}), new Promise(r => setTimeout(r, 500))]);
    }
    if (error.cancelled) throw new Error('已取消');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    try { client?.close(); } catch { /* 已关 */ }
    const root = built?.home ? path.dirname(built.home) : null;
    if (root && path.dirname(root) === path.join(dataDir, 'acp') && !path.basename(root).startsWith('card-')) removeLinkSafe(root);
    if (!cwd) removeLinkSafe(workDir);
  }
}

module.exports = { run, rejectPermission, OWN_MISSING };
