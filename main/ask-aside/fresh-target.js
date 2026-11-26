'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { isSafeModelId } = require('../../core/model-id');
const harness = value => value === 'codeagent-lite' ? 'codeagent' : value === 'api-gateway' ? 'claude' : value;
function freshTarget({ session = {}, entry, selection = '', model = '', cwd = '', resolveConfig, accountDir,
  findCommand = () => '', hubDataDir, baseEnv = process.env, resolveClaudeProfile, gatewayRoute = false, featureChoice = null, inheritModel = true,
  applyGatewayEnv = (env, options) => require('../../core/company-model-proxy').applyClaudeEnv(env, options) } = {}) {
  const sourceKind = String(session.kind || '').replace(/-resume$/, '');
  const [wanted, selectedModel] = String(selection || sourceKind || 'codeagent').split('|');
  const engine = harness(wanted), gateway = engine === 'claude' && (gatewayRoute || wanted === 'api-gateway' || require('../../core/assistant-gateway-route').isGatewaySession(session));
  if (!['codeagent', 'claude', 'codex'].includes(engine)) throw Object.assign(Error('所选会议问答引擎不可用'), { errorKind: 'engine-not-ready' });
  const same = harness(sourceKind) === engine;
  let env = same && entry?.askAsideEnv ? { ...entry.askAsideEnv } : { ...baseEnv };
  if (same && !entry?.askAsideEnv) Object.assign(env, session.claudeNetworkEnv || session.claudeSharedNetworkEnv || {});
  let pickedModel = [selectedModel, model, same && inheritModel ? session.currentModel?.id : ''].find(isSafeModelId) || '';
  const work = cwd || session.cwd;
  if (!work || !fs.existsSync(work)) throw Object.assign(Error('会议问答工作目录不存在'), { errorKind: 'spawn-failed' });
  if (engine === 'codeagent') {
    let config = resolveConfig();
    if (same && session.codeagentPoolAccount) config = { ...config, configDir: accountDir(session.codeagentPoolAccount) };
    if (!config.configDir || !fs.existsSync(config.configDir)) throw Object.assign(Error('原会议账号目录已不可用'), { errorKind: 'spawn-failed' });
    const knownModel = pickedModel;
    return { supported: true, engine, config, cwd: work, env, model: isSafeModelId(knownModel) ? knownModel : '', mode: 'fresh' };
  }
  if (engine === 'codex') {
    return { supported: true, engine, env, cwd: work, model: pickedModel, mode: 'fresh',
      session: { ...(same ? session : {}), cwd: work, currentModel: { id: pickedModel } } };
  }
  let configDir = gateway ? path.join(hubDataDir, 'meeting-question-claude') : same ? entry?.askAsideEnv?.CLAUDE_CONFIG_DIR || session.claudeConfigDir || session.claudeRuntimeHome : '';
  if (gateway) {
    fs.mkdirSync(configDir, { recursive: true }); env = { ...baseEnv };
    // Reuse Hub's local proxy route, never the understanding process or the encrypted department key.
    try { const routed = applyGatewayEnv(env, { dataDir: hubDataDir, sessionId: 'meeting-question-' + require('node:crypto').randomUUID(), model: pickedModel, gateway: true }); if (isSafeModelId(routed)) pickedModel = routed; }
    catch (error) { throw Object.assign(Error('会议网关连接未就绪：' + error.message), { errorKind: 'engine-not-ready', errorHint: '等待本机网关服务就绪后重试，或换引擎重答。' }); }
  }
  // 功能固定线路（公司模型 / 自有接口 / 自有 API，11-27）：和部门 key 一样用独立账号目录，连接经 harness-route 注入并写进 --settings 覆盖层，
  // 理解会话没开、休眠或换过引擎都照样连得上，用户 settings.json 里的连接盖不掉它。
  const agRoute = require('../../core/assistant-gateway-route');
  const fixed = engine === 'claude' && !gateway ? agRoute.routeOf(featureChoice || (session.apiGatewayRoute ? session.featureAgentChoice : null)) : null;
  let fixedSettings = null;
  if (fixed && fixed.source !== 'gateway') {
    configDir = path.join(hubDataDir, 'meeting-question-claude'); fs.mkdirSync(configDir, { recursive: true }); env = { ...baseEnv };
    if (!pickedModel && isSafeModelId(fixed.model)) pickedModel = fixed.model;
    try { fixedSettings = require('../../core/harness-route').applyClaudeOnce(env, { ...fixed, model: pickedModel }, { dataDir: hubDataDir, tag: 'meeting-question-' + require('node:crypto').randomUUID() }); }
    catch (error) { throw Object.assign(Error('会议问答的模型来源用不了：' + error.message), { errorKind: 'engine-not-ready', errorHint: '到「设置 → 功能使用的 Agent」或「设置 → 自有 API」检查后重试，或换引擎重答。' }); }
  }
  if (!gateway && !fixedSettings && !inheritModel && !selectedModel && !model) {
    for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) delete env[name];
  }
  if (!configDir) {
    const profile = resolveClaudeProfile?.(same ? session : {});
    if (profile) { configDir = profile.home; env = { ...env, ...profile.networkEnv }; }
    else configDir = path.join(os.homedir(), '.claude');
  }
  if (!fs.existsSync(configDir)) throw Object.assign(Error('会议 Claude 账号目录已不可用'), { errorKind: 'spawn-failed' });
  env.CLAUDE_CONFIG_DIR = configDir;
  let command = ''; try { command = findCommand('claude', env) || ''; } catch {}
  const settingsEnv = gateway ? require('../../core/claude-connection-settings').connectionEnv({ COMPANY_CLI: true, CLAUDE_BACKEND: 'proxy' }, env, pickedModel) : fixedSettings;
  return { supported: true, engine, env, cwd: work, model: pickedModel, mode: 'fresh', config: {
    command: command || 'claude', flavor: 'claude', configDirEnv: 'CLAUDE_CONFIG_DIR', configDir,
    ...(settingsEnv ? { settingsEnv, settingsDir: path.join(hubDataDir, 'native-agent-settings') } : {}),
  } };
}
module.exports = { freshTarget, harness };
