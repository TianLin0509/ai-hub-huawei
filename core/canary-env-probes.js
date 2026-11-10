'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// These probes use the existing environment check scheduler and timeout.
function probes(ctx) {
  const row = (id, name, run) => ({ id, name, area: 'env-check', run });
  const item = (status, detail, fingerprint) => ({ status, detail, fingerprint });
  return [
    row('codeagent-trust', 'CodeAgent 目录信任位置', async () => {
      const config = ctx.codeagentConfig ? ctx.codeagentConfig() : require('./codeagent-config').resolveCodeAgentConfig(ctx.env || process.env);
      const version = await (ctx.codeagentVersion || require('./codeagent-version-probe').codeagentVersion)(config.command || 'codeagent');
      const parts = String(version).split(/[.+-]/).slice(0, 4).map(Number);
      const rootRequired = parts.join('.') === '1.2615.2.2';
      const locations = [path.join(ctx.homeDir || os.homedir(), '.cac.json'), path.join(config.configDir, '.cac.json')];
      const layout = locations.map(file => {
        try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return { path: file, valid: !!s && typeof s === 'object', projects: Object.keys(s?.projects || {}).length }; }
        catch (e) { return { path: file, valid: false, error: e.code || 'invalid-json' }; }
      });
      // Exercise the actual writer in a private scratch home; never alter CLI user state.
      const scratch = fs.mkdtempSync(path.join(ctx.dataDir, '.preview-trust-'));
      let writeOk = false;
      try {
        const cfg = path.join(scratch, 'config'); fs.mkdirSync(cfg);
        fs.writeFileSync(path.join(scratch, '.cac.json'), '{}'); fs.writeFileSync(path.join(cfg, '.cac.json'), '{}');
        const project = path.join(scratch, 'project'); fs.mkdirSync(project);
        const trust = require('./claude-project-trust');
        trust.ensureCodeAgentProjectTrusted(project, { configDir: cfg, homeDir: scratch, stateFileName: '.cac.json' });
        const state = JSON.parse(fs.readFileSync(path.join(scratch, '.cac.json'), 'utf8'));
        writeOk = state.projects?.[trust.toClaudeProjectKey(project)]?.hasTrustDialogAccepted === true;
      } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
      if (!writeOk) return item('bad', '目录信任写入自检没有写到用户目录根下', { layout, writeOk });
      const valid = rootRequired ? layout[0].valid : layout.some(p => p.valid);
      return item(valid ? 'ok' : 'warn', valid ? '与当前 CLI 版本兼容的 .cac.json 可读取' : rootRequired ? '用户目录根下缺少有效的 .cac.json，旧版 CLI 可能重复询问信任' : '没有可读取的 .cac.json 信任文件', { version, rootRequired, layout, trustPrompt: '未新启交互会话，未采集信任框' });
    }),
    row('company-model-config', '公司模型适配配置', async () => {
      const c = ctx.getConfig?.() || {}, proxy = require('./company-model-proxy');
      const routes = ['claude', 'codex', 'deepseek-acp'].filter(k => proxy.usesProxy(k, c));
      const p = ctx.proxy?.(), zone = proxy.chosenZone(ctx.dataDir);
      const invalid = routes.length && (!p || p.status?.state !== 'running');
      return item(invalid ? 'bad' : 'ok', routes.length ? `${routes.join('、')} 使用公司模型；${p?.status?.message || p?.status?.state || '尚未就绪'}` : '当前没有工具选择公司模型', { zone: zone.zone || '自动', routes, state: p?.status?.state || 'unused' });
    }),
    row('codeagent-signer', 'CodeAgent 签名运行库位置', async () => {
      const dir = ctx.codeagentInstallDir ? ctx.codeagentInstallDir() : require('./codeagent-config').codeagentInstallDir(ctx.env || process.env);
      if (!dir) return item('bad', '没有找到 CodeAgent 安装目录', { installLocation: '未找到', runtimeLocation: '未找到' });
      const { findNativeRuntime } = await import('./company-proxy/native-signer.mjs');
      const config = ctx.codeagentConfig ? ctx.codeagentConfig() : require('./codeagent-config').resolveCodeAgentConfig(ctx.env || process.env);
      const version = await (ctx.codeagentVersion || require('./codeagent-version-probe').codeagentVersion)(config.command || 'codeagent');
      const managed = path.join(ctx.dataDir, 'company-model-proxy', 'native-runtime', version);
      const runtime = await findNativeRuntime({ codeagentDir: dir, runtimeDir: managed, tempDir: (ctx.env || process.env).TEMP || os.tmpdir() });
      const normalized = p => path.resolve(p).replace(/\\/g, '/').toLowerCase();
      const location = !runtime ? '未找到' : normalized(path.dirname(runtime.dll)) === normalized(managed) ? '配置目录'
        : normalized(path.dirname(runtime.dll)) === normalized(path.join(dir, 'bin')) ? '安装目录' : 'TEMP';
      return item(runtime ? 'ok' : 'warn', runtime ? '发现签名运行库与 FFI 配对文件' : '没有发现签名运行库配对文件，首次初始化可能尚未完成', { installLocation: '安装目录', runtimeLocation: location });
    }),
    row('attendance-domain', '考勤域名自动发现', async () => {
      const known = await (ctx.discoverAttendanceDomain ? ctx.discoverAttendanceDomain() : require('./company-domain').knownDomain(ctx.dataDir));
      const domain = typeof known === 'string' ? known : known?.domain;
      return item(domain ? 'ok' : 'bad', domain ? `已发现考勤域名 · ${domain}` : '没有自动找到考勤域名', { domain: domain || '', source: known?.from || 'shared' });
    }),
    row('canary-pages', '关键页面资源', async () => {
      const root = ctx.appRoot || path.resolve(__dirname, '..');
      const files = ['renderer/index.html', 'renderer/app-update.js', 'renderer/env-check.js'];
      const missing = files.filter(f => !fs.existsSync(path.join(root, f)));
      return item(missing.length ? 'bad' : 'ok', missing.length ? `缺少 ${missing.join('、')}` : '主页面、更新页和体检页资源齐全', { files, scope: '资源检查，未打开可见窗口' });
    }),
    ...(ctx.probeAttendancePage ? [row('attendance-page', '考勤网络与登录跳转', ctx.probeAttendancePage)] : []),
  ];
}
module.exports = { probes };
