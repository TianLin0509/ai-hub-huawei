'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanTomlStatements, samePath, simpleStringValue } = require('./toml-statements');

// Only the explicit local-CLI route uses these names. Subscription catalogs
// keep their own provider checks; model names never select credentials.
function isLocalCliModelId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}(?:\[1m\])?$/.test(value)
    && !require('./model-options').CODEX_NON_CONVERSATION_MODEL_RE.test(value);
}

function readLocalCliModels(kind, { configDir, env = process.env, fsModule = fs, homeDir = os.homedir() } = {}) {
  const base = String(kind || '').replace(/-resume$/, '');
  if (!['claude', 'codex'].includes(base)) throw new Error('这个工具不支持沿用本机模型目录');
  const userHome = env.USERPROFILE || env.HOME || homeDir;
  const home = configDir || env[base === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']
    || path.join(userHome, base === 'codex' ? '.codex' : '.claude');
  const models = [];
  const add = (id, label = id) => {
    if (!isLocalCliModelId(id) || models.some(model => model.id === id)) return;
    models.push({ id, label: String(label || id).replace(/[\0\r\n]/g, ' ').slice(0, 120), source: 'local-cli' });
  };
  const read = file => {
    try { return fsModule.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  };
  const json = file => { const text = read(file); return text ? JSON.parse(text) : {}; };
  let defaultModel = '';
  if (base === 'codex') {
    const { statements } = scanTomlStatements(read(path.join(home, 'config.toml')));
    const root = key => statements.find(item => item.kind === 'kv' && samePath(item.path, [key]));
    const profile = simpleStringValue(root('profile')?.valueText);
    const selected = profile && statements.find(item => item.kind === 'kv' && samePath(item.path, ['profiles', profile, 'model']));
    defaultModel = simpleStringValue((selected || root('model'))?.valueText) || '';
    add(defaultModel);
    const catalog = simpleStringValue(root('model_catalog_json')?.valueText);
    const cached = json(catalog ? path.resolve(home, catalog) : path.join(home, 'models_cache.json'));
    for (const model of Array.isArray(cached.models) ? cached.models : []) {
      if (!model || typeof model !== 'object' || model.hidden || model.visibility === 'hide') continue;
      add(model.slug || model.id || model.model, model.display_name || model.displayName);
    }
  } else {
    const settings = json(path.join(home, 'settings.json'));
    const modelEnv = { ...settings.env, ...env };
    defaultModel = modelEnv.ANTHROPIC_MODEL || settings.model || '';
    add(defaultModel);
    for (const key of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) add(modelEnv[key]);
    const state = json(path.resolve(home) === path.resolve(userHome, '.claude')
      ? path.join(userHome, '.claude.json') : path.join(home, '.claude.json'));
    const extra = state.additionalModelOptionsCache || [];
    const visit = (value, depth = 0) => {
      if (!value || depth > 5) return;
      if (Array.isArray(value)) return value.forEach(item => visit(item, depth + 1));
      if (typeof value !== 'object') return;
      const id = value.value || value.id || value.model;
      if (id) add(id, value.displayName || value.label);
      else Object.values(value).forEach(item => visit(item, depth + 1));
    };
    visit(extra);
  }
  return { ok: true, models, defaultModel: isLocalCliModelId(defaultModel) ? defaultModel : '' };
}

module.exports = { isLocalCliModelId, readLocalCliModels };
