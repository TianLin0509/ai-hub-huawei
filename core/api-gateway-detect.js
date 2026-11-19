'use strict';
// 自动识别「这台电脑的人是 API 用户」（2026-11-19）：同事多半已经在别的工具里配过部门 API key
// （Claude Code / Codex 的设置、环境变量、Continue、OpenCode、CC Switch 等）。在这些常见位置找
// 「API 网关地址 + 和它明确配对的 key」，找到就在 Hub 里给一键「用这个 key」，不用他再去翻 key。
// 只认明确配对（同一个配置对象、同前缀的环境变量、Codex 当前供应商），别家供应商的 key 不取。
// 只读本机小文件；key 只留在主进程内存里，界面只拿到来源和打码后的样子（sk-…abcd）。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY_RE = /\bsk-[A-Za-z0-9_-]{20,200}\b/g;
const MAX_BYTES = 2 * 1024 * 1024;

function hostOf(baseURL) { try { return new URL(baseURL).host.toLowerCase(); } catch { return ''; } }
function readSmall(file) {
  try { const st = fs.statSync(file); if (!st.isFile() || st.size > MAX_BYTES) return ''; return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}
function mask(key) { return key.length > 10 ? key.slice(0, 3) + '…' + key.slice(-4) : '…'; }

// 只认「明确配对」：同一个 JSON 对象里既有网关地址、又恰好只有一个 key（Continue 的模型条目、Claude Code 的 env、
// OpenCode 的 options 都是这样）；不是 JSON 的文件配不了对，不看。拿不准的一律不推荐（11-19 审查）。
const KEY_ONE = new RegExp('^' + KEY_RE.source + '$');
function pairedKeys(text, host) {
  if (!text || !text.toLowerCase().includes(host)) return [];
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  const out = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    const values = Object.values(node);
    const strings = values.filter(v => typeof v === 'string');
    if (strings.some(v => v.toLowerCase().includes(host))) {
      const keys = [...new Set(strings.filter(v => KEY_ONE.test(v.trim())).map(v => v.trim()))];
      if (keys.length === 1 && !out.includes(keys[0])) out.push(keys[0]);
    }
    for (const v of values) if (v && typeof v === 'object') walk(v);
  };
  walk(data);
  return out;
}

// Codex：只看当前选中的供应商（model_provider = "x"）且它的 base_url 指向网关；key 取它 env_key 指定的环境变量，
// 没写 env_key 才用 auth.json 的 OPENAI_API_KEY。
// TOML 字符串：双引号或单引号。
const tomlValue = (text, name) => { const m = new RegExp('^\\s*' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'm').exec(text); return m ? (m[1] ?? m[2]) : null; };
function codexKey(toml, authText, env, host) {
  const current = tomlValue(toml, 'model_provider');
  if (!current) return '';
  const section = new RegExp('^\\[model_providers\\.(?:"' + current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"|' + current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))', 'm').exec(toml)?.[1] || '';
  if (!(tomlValue(section, 'base_url') || '').toLowerCase().includes(host)) return '';
  // 写了 env_key 就只认那个环境变量（读不出、为空都不推荐）；没写 env_key 才用 auth.json。
  let key = '';
  if (/^\s*env_key\s*=/m.test(section)) {
    const envKey = tomlValue(section, 'env_key');
    if (!envKey) return '';
    key = String(env?.[envKey] || '');
  } else { try { key = String(JSON.parse(authText || '{}').OPENAI_API_KEY || ''); } catch { key = ''; } }
  return KEY_ONE.test(key.trim()) ? key.trim() : '';
}

// 文件组：地址和 key 在同一个文件里的直接配对；Codex 的地址在 config.toml、key 在 auth.json 单独处理。
function sources({ home = os.homedir(), appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming') } = {}) {
  return [
    { source: 'Claude Code 设置', files: [path.join(home, '.claude', 'settings.json'), path.join(home, '.claude', 'settings.local.json')] },
    { source: 'Continue 插件', files: [path.join(home, '.continue', 'config.json')] },
    { source: 'OpenCode', files: [path.join(home, '.config', 'opencode', 'opencode.json')] },
    { source: 'CC Switch', files: [path.join(home, '.cc-switch', 'config.json')] },
    { source: 'VS Code 设置', files: [path.join(appData, 'Code', 'User', 'settings.json')] },
  ];
}

const found = new Map(); // id -> { key, baseURL }（只在内存；id 不复用，最多留 30 个）

function detect(baseURL, { env = process.env, home = os.homedir(), appData } = {}) {
  const host = hostOf(baseURL);
  if (!host) return [];
  const out = [], seen = new Set();
  const add = (source, key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const id = crypto.randomUUID();
    found.set(id, { key, baseURL });
    while (found.size > 30) found.delete(found.keys().next().value);
    out.push({ id, source, masked: mask(key) });
  };
  // 环境变量：值里有网关地址的变量（如 OPENAI_BASE_URL），只取同前缀（OPENAI_）变量里的 key。
  const entries = Object.entries(env || {}).map(([k, v]) => [String(k), String(v || '')]);
  for (const [name, value] of entries) {
    if (!value.toLowerCase().includes(host)) continue;
    const prefix = name.split('_')[0].toUpperCase() + '_';
    for (const [other, v] of entries) if (other.toUpperCase().startsWith(prefix)) for (const k of v.match(KEY_RE) || []) add('环境变量', k);
  }
  for (const group of sources({ home, appData })) for (const file of group.files) for (const k of pairedKeys(readSmall(file), host)) add(group.source, k);
  // Codex：当前供应商指向网关时才取。
  const ck = codexKey(readSmall(path.join(home, '.codex', 'config.toml')), readSmall(path.join(home, '.codex', 'auth.json')), env, host);
  if (ck) add('Codex 设置', ck);
  return out;
}

// 采用时用检测当时的网关地址；id 过期（Hub 重启或被挤出）返回空，界面提示重新检测。
function take(id) { return found.get(String(id)) || null; }

module.exports = { detect, take, pairedKeys, codexKey, mask };
