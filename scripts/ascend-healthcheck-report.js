#!/usr/bin/env node
'use strict';
// 部门 API 网关体检（给公司黄区真机验收用，2026-11-20）：不依赖 Electron，Node 直接跑；只读，不写任何文件。
//   node scripts/ascend-healthcheck-report.js --key-file <本人受保护的 key 文件> [--base <网关地址，默认用 Hub 预填的那个>] [--models a,b] [--concurrency 3] [--no-think a,b]
// --no-think：这些模型试跑时关掉思考（chat_template_kwargs.enable_thinking=false），用来对比开关思考的首字。
// key 只从 --key-file 读进内存，用来发请求，不打印、不进输出；输出是打码后的能力表 JSON（stdout）：
//   目录（模型、分组、接口类型、上下文）→ 这把 key 能用的模型 → 推断分组 → 逐个对话模型流式试跑一句（带一个工具）。
// 和 Hub 里「一键体检」是同一套代码（core/api-gateway-catalog.js、core/api-gateway-healthcheck.js、core/api-gateway-errors.js）。
const fs = require('node:fs');
const path = require('node:path');
const catalogLib = require('../core/api-gateway-catalog');
const health = require('../core/api-gateway-healthcheck');
const errors = require('../core/api-gateway-errors');
const { DEFAULT_BASE_URL, normalizeBaseUrl, probe } = require('../core/api-gateway');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, inline] = a.slice(2).split('=');
    out[k] = inline !== undefined ? inline : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

async function main() {
  const opt = args(process.argv.slice(2));
  if (!opt['key-file']) {
    process.stderr.write('用法：node scripts/ascend-healthcheck-report.js --key-file <key 文件> [--base <网关地址>] [--models a,b] [--concurrency 3]\n');
    process.exitCode = 2; return;
  }
  const key = fs.readFileSync(path.resolve(opt['key-file']), 'utf8').replace(/^\uFEFF/, '').replace(/^\s*Authorization:\s*Bearer\s*/i, '').trim();
  if (!key) throw new Error('key 文件是空的');
  const baseURL = normalizeBaseUrl(opt.base || DEFAULT_BASE_URL);
  const started = Date.now();
  const report = { tool: 'ascend-healthcheck-report 1.0', at: new Date().toISOString(), baseURL, node: process.version };

  // 1 公开目录（不用 key）
  const priced = await catalogLib.fetchPricing({ baseURL });
  const catalog = priced.ok ? priced.catalog : null;
  report.catalog = priced.ok
    ? { models: catalog.models.map(m => ({ id: m.id, chat: m.chat, groups: m.groups, endpoints: m.endpoints, tags: m.tags, context: m.context || null })), groups: catalog.groups }
    : { error: priced.code };

  // 2 这把 key 能用的模型
  const listed = await probe({ baseURL, apiKey: key });
  if (!listed.ok) {
    report.keyModels = { error: listed.code, message: listed.message };
    report.ms = Date.now() - started;
    process.stdout.write(redactAll(JSON.stringify(report, null, 2), key) + '\n');
    process.exitCode = 1; return;
  }
  report.keyModels = listed.models;
  const summary = catalog ? catalogLib.summarize(catalog, listed.models) : null;
  report.group = summary ? { group: summary.group, exact: summary.groupExact, desc: summary.groupDesc, ratio: summary.groupRatio, hidden: summary.hidden, nonChat: summary.nonChat } : null;

  // 3 逐个对话模型试跑
  const chat = opt.models ? opt.models.split(',').map(s => s.trim()).filter(Boolean)
    : listed.models.filter(id => (catalog?.models.find(m => m.id === id)?.chat ?? catalogLib.isChatModel({ id, endpoints: [], tags: [] })));
  const rows = await health.run({ baseURL, apiKey: key, models: chat, catalog, group: summary?.group || '',
    concurrency: Number(opt.concurrency) > 0 ? Number(opt.concurrency) : health.CONCURRENCY,
    noThinking: opt['no-think'] ? opt['no-think'].split(',').map(x => x.trim()).filter(Boolean) : [],
    onProgress: r => process.stderr.write(`${r.id}: ${r.ok ? `ok 首字 ${r.firstMs}ms 工具 ${r.tools} 思考 ${r.thinking}` : `失败 ${r.error?.code}`}\n`) });
  report.table = rows.map(r => ({ model: r.id, ok: r.ok, firstMs: r.firstMs, firstThinkMs: r.firstThinkMs ?? null, firstTextMs: r.firstTextMs ?? null, thinkOnly: !!r.thinkOnly, noThinking: !!r.noThinking, totalMs: r.totalMs, tools: r.tools, thinking: r.thinking,
    context: r.context || catalogLib.DEFAULT_CONTEXT, contextFromCatalog: !!r.context, endpoints: r.endpoints,
    firstTokenTimeoutMs: r.ok ? health.firstTokenTimeoutMs(r.firstMs) : null,
    ...(r.emptyToolCalls ? { emptyToolCallChunks: r.emptyToolCalls } : {}), ...(r.finish ? { finish: r.finish } : {}),
    ...(r.ok ? {} : { error: { code: r.error?.code, title: r.error?.title, message: r.error?.message, detail: r.error?.detail } }), note: health.note(r) }));
  report.ms = Date.now() - started;
  process.stdout.write(redactAll(JSON.stringify(report, null, 2), key) + '\n');
}

// 输出前再整体打一遍码：key 原文、sk- 开头的串。
function redactAll(text, key) {
  return (key ? text.split(key).join('<KEY>') : text).replace(/\bsk-[A-Za-z0-9_-]{4,}/g, 'sk-<已隐去>');
}

main().catch(error => { process.stderr.write('体检没跑完：' + errors.redact(error?.message || String(error)) + '\n'); process.exitCode = 1; });
