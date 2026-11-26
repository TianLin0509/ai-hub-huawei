'use strict';
// 单次纯文字任务复用答疑的只读参数和隐藏进程，不把功能任务变成编码权限。
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
async function run(selected, prompt, { dataDir, signal, timeoutMs = 60000, env = process.env,
  runOnce = require('./company-assistant/ppt-map-model').runOnce,
  findCommand = require('./community-setup').findCommand, onActivity = () => {} } = {}) {
  const engine = require('./help-ask/engine'), kind = selected.kind;
  const launchEnv = engine.childEnv(env), cwd = path.join(dataDir, 'feature-agent-cwd');
  fs.mkdirSync(cwd, { recursive: true });
  let command = findCommand(kind, env), providerFile = '';
  if (!command) throw new Error('所选后端当前不可用，请恢复默认');
  if (kind === 'codeagent') {
    const config = require('./codeagent-config').resolveCodeAgentConfig(env);
    command = config.command || command;
    require('./codeagent-launch-env').applyAccountEnv(launchEnv, { configDirEnv: config.configDirEnv, configDir: config.configDir });
  }
  if (kind === 'claude') launchEnv.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  // 公司版外壳（core/feature-agent-choice.js）：Claude Code / Codex 只当外壳，模型经本机反代走部门 API key 或公司模型，
  // 和启动中心同一条线路（company-model-proxy applyClaudeEnv / applyCodexEnv）。不读 CLI 自己的登录。
  const source = (kind === 'claude' || kind === 'codex') ? selected.source : '';
  if (source) {
    if (!['gateway', 'company'].includes(source)) throw new Error('所选模型来源不可用，请恢复默认');
    const gateway = source === 'gateway', proxy = require('./company-model-proxy');
    await require('./feature-agent-choice').ensureProxy(source);
    const tag = `feature-${crypto.randomUUID().slice(0, 8)}`;
    if (kind === 'claude') proxy.applyClaudeEnv(launchEnv, { dataDir, sessionId: tag, model: selected.model, gateway });
    else proxy.applyCodexEnv(launchEnv, { dataDir, sessionId: tag, model: selected.model, projectDir: cwd, gateway });
  }
  if (kind === 'codex' && !launchEnv.CODEX_HOME) launchEnv.CODEX_HOME = require('./codex-usage-scope')
    .resolveCodexUsageScope(require('./hub-config').getConfig(), { hubDataDir: dataDir }).home;
  const helpResult = await runOnce({ command, args: kind === 'codex' ? ['exec', '--help'] : ['--help'], cwd, env: launchEnv, signal, timeoutMs, onActivity });
  if (helpResult.aborted || signal?.aborted) throw new Error('已取消');
  const help = String(helpResult.stdout || '') + String(helpResult.stderr || '');
  const out = path.join(cwd, `${crypto.randomUUID()}.txt`);
  try {
    let args;
    if (kind === 'codex') {
      const os = require('node:os');
      const names = require('./ask-aside-codex').configuredMcpNames([path.join(launchEnv.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml')]);
      args = engine.codexArgs(out, names);
      if (selected.model) args.splice(1, 0, '--model', selected.model);
    } else {
      if (!engine.readOnlyCapable(help)) throw new Error('所选后端不能关闭工具，请恢复默认');
      // CodeAgent 指定了模型、没指定供应商时走精简参数（--bare + 空 MCP 配置，core/codeagent-print-args.js）；指定供应商要读 --settings，不加 --bare。
      args = kind === 'codeagent' ? engine.codeAgentArgs(selected.model, help, { lean: !selected.codeagentModelProvider, mcpConfigFile: require('./codeagent-print-args').emptyMcpConfigFile(cwd) })
        : engine.claudeArgs(help, { model: selected.model });
      // 空模型表示沿用 CLI 当前默认，不能传一个空 --model。
      if (kind === 'codeagent' && !selected.model) args.splice(args.indexOf('--model'), 2);
      if (kind === 'codeagent' && selected.codeagentModelProvider) {
        if (!help.includes('--settings')) throw new Error('当前 CodeAgent 不支持单次指定供应商，请恢复默认');
        providerFile = path.join(cwd, `${crypto.randomUUID()}.json`);
        fs.writeFileSync(providerFile, JSON.stringify({ provider: selected.codeagentModelProvider, enterprise: { activeProvider: selected.codeagentModelProvider } }), { mode: 0o600 });
        args.push('--settings', providerFile);
      }
    }
    const r = await runOnce({ command, args, input: prompt, cwd, env: launchEnv, signal, timeoutMs, onActivity, ...(kind === 'codeagent' ? { lifecycle: 'feature-agent' } : {}) });
    if (r.aborted || signal?.aborted) throw new Error('已取消');
    if (r.timedOut) throw Object.assign(new Error('所选模型回答超时'), { timedOut: true });
    const raw = kind === 'codex' && fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : r.stdout;
    const text = kind === 'codeagent' ? require('./company-assistant/ppt-map-model').replyText(raw) : engine.cleanAnswer(raw);
    if (r.code !== 0 || !text.trim()) throw new Error('所选模型未能回答：' + require('./hub-feedback').redact(engine.cleanAnswer(r.stderr || raw)).slice(0, 200));
    return text;
  } finally {
    for (const file of [out, providerFile].filter(Boolean)) try { fs.unlinkSync(file); } catch { /* 尚未生成 */ }
  }
}
module.exports = { run };
