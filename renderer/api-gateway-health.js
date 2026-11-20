'use strict';

// 设置 → 自有 API → API 网关 右栏（2026-11-20 B 线）：网关分组说明、一键体检能力表、上手说明。
// 数据来自主进程（core/api-gateway.js 的 healthView / catalogSummary，IPC api-gateway:healthcheck / api-gateway:catalog），
// 这里只负责画和接按钮。报错按钮的 id 与 core/api-gateway-errors.js 的 ACTIONS 一致。
const { ACTIONS, TUTORIAL_URL } = require('../core/api-gateway-errors');

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const GROUP_NAMES = { free: '免费分组', default: '默认分组', max: '高速分组', vip: 'VIP 分组' };
const sec = ms => (Number(ms) > 0 ? (ms / 1000).toFixed(1) + ' 秒' : '—');
const ctxText = n => (Number(n) > 0 ? Math.round(n / 1000) + 'K' : '—');
// 「不调用工具」不是故障（只是只适合聊天），用中性色，红色只留给不能用。
const yesNo = (v, yes, no) => (v === true ? `<span class="api-gw-yes">${yes}</span>` : v === false ? `<span class="api-gw-dim">${no}</span>` : '<span class="api-gw-dim">没测出</span>');
const endpointText = list => (Array.isArray(list) && list.length ? list.filter(e => e === 'openai' || e === 'anthropic').map(e => (e === 'openai' ? 'OpenAI' : 'Anthropic')).join(' + ') || list.join(' + ') : 'OpenAI');

function ensureStyle() {
  if (document.querySelector('link[data-api-gw-health]')) return;
  const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'styles/api-gateway-health.css' });
  link.dataset.apiGwHealth = '1';
  document.head.append(link);
}

// 分组卡：你的 key 在哪个分组、这个分组是什么意思、看不到的模型开给谁。
function groupHtml(catalog, gateway) {
  const group = catalog?.group || gateway?.group || '';
  if (!catalog && !group) {
    return '<section class="api-gw-group" data-api-gw-group><h3>分组</h3><p>保存 key 后，Hub 会对照网关的公开目录告诉你这把 key 在哪个分组、能用哪些模型。</p></section>';
  }
  const info = catalog?.groups?.[group] || {};
  const ratio = catalog?.groupRatio ?? info.ratio;
  const hidden = (catalog?.hidden || []).map(h => `${esc(h.id)}（只开给 ${h.groups.map(g => esc(g)).join(' / ') || '其他分组'}）`);
  const others = Object.entries(catalog?.groups || {}).filter(([name]) => name !== group)
    .map(([name, g]) => `<li><strong>${esc(name)}</strong>${g.ratio !== undefined ? ` · 倍率 ${esc(g.ratio)}` : ''}${g.desc ? ` · ${esc(g.desc)}` : ''}</li>`).join('');
  return '<section class="api-gw-group" data-api-gw-group>'
    + `<h3>${group ? `你的 key 在 <strong>${esc(group)}</strong> 分组${GROUP_NAMES[group] ? `（${GROUP_NAMES[group]}）` : ''}` : '还没推断出分组'}${group && catalog && !catalog.groupExact ? ' <small>（按模型表推断，可能不准）</small>' : ''}</h3>`
    + `<p>${esc(info.desc || '')}${ratio !== undefined && ratio !== null ? ` · 倍率 ${esc(ratio)}` : ''}</p>`
    + (hidden.length ? `<p class="api-gw-dim">这把 key 看不到：${hidden.join('，')}。要用它们需要换对应分组的 key。</p>` : '')
    + (catalog?.nonChat?.length ? `<p class="api-gw-dim">${catalog.nonChat.map(esc).join('、')} 是生图 / 语音类模型，不进会话模型表。</p>` : '')
    + (others ? `<details data-api-gw-groups><summary>分组说明</summary><ul>${others}</ul></details>` : '')
    + '</section>';
}

function actionButtons(actions = []) {
  return actions.filter(a => ACTIONS[a] && a !== 'compact').map(a => `<button type="button" data-api-gw-act="${esc(a)}">${esc(ACTIONS[a])}</button>`).join('');
}

function rowHtml(r, running) {
  if (!r || r.pending) {
    return `<tr data-api-gw-row="${esc(r?.id)}"><th>${esc(r?.id)}</th><td colspan="5" class="api-gw-dim">${running ? '体检中…' : '还没体检'}</td><td>${ctxText(r?.context)}</td></tr>`;
  }
  if (!r.ok) {
    const e = r.error || {};
    return `<tr data-api-gw-row="${esc(r.id)}" data-api-gw-state="fail"><th>${esc(r.id)}</th><td colspan="6"><span class="api-gw-no">✗ ${esc(e.title || '暂不可用')}</span>`
      + `<p>${esc(e.message || '')}</p><div class="api-gw-acts">${actionButtons(e.actions)}</div>`
      + (e.detail ? `<details><summary>网关原话</summary><code>${esc(e.detail)}</code></details>` : '') + '</td></tr>';
  }
  // 首字分两个数（11-20 黄区实测首思考与首正文能差 7 秒）：「思考 / 正文」秒数；没正文的标「没出」。
  const s1 = ms => (Number(ms) >= 0 && ms !== null ? (ms / 1000).toFixed(1) : '—');
  const first = r.firstThinkMs != null
    ? `<span title="首个思考字 / 首个正文字（秒）">${s1(r.firstThinkMs)} / ${r.firstTextMs != null ? s1(r.firstTextMs) : '<span class="api-gw-warn">没出</span>'}</span>`
    : `<span title="首个正文字（秒）">— / ${s1(r.firstTextMs ?? r.firstMs)}</span>`;
  const thinkCell = r.noThinking ? '<span class="api-gw-dim">已关</span><button type="button" data-api-gw-act="think">恢复</button>'
    : r.thinking ? '<span class="api-gw-yes">有</span><button type="button" data-api-gw-act="no-think" title="本机代理给这个模型的请求关掉思考，直接回答">关闭思考</button>' : '无';
  // 只出思考、到上限没正文：会话里会像「没反应」（同事说的「选 Qwen 没反应」），就地提示并给「关闭思考」。
  const state = r.thinkOnly
    ? '<span class="api-gw-warn" title="试跑时只出了思考、到上限还没正文，会话里会像「没反应」。点「关闭思考」让它直接回答。">⚠ 想太久没回答</span>'
    : '<span class="api-gw-yes">✓ 能用</span>';
  return `<tr data-api-gw-row="${esc(r.id)}" data-api-gw-state="${r.thinkOnly ? 'slow' : 'ok'}"><th>${esc(r.id)}</th><td>${state}</td>`
    + `<td class="api-gw-nowrap">${first}</td><td>${yesNo(r.tools, '会', '不调用')}</td><td class="api-gw-nowrap">${thinkCell}</td>`
    + `<td>${esc(endpointText(r.endpoints))}</td><td>${ctxText(r.context)}</td></tr>`;
}

function tableHtml(payload, running) {
  const rows = payload?.health?.rows || (payload?.gateway?.models || []).map(id => ({ id, pending: true }));
  const at = payload?.health?.at ? new Date(payload.health.at) : null;
  const when = at ? `上次体检 ${at.getMonth() + 1}-${at.getDate()} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : '还没体检';
  return '<section class="api-gw-health" data-api-gw-health>'
    + `<header><h3>模型能力表</h3><span class="api-gw-dim" data-api-gw-when>${running ? '体检中：每个模型发一句极短的话，约 10–60 秒' : esc(when)}</span></header>`
    + (rows.length ? '<table><thead><tr><th>模型</th><th>能不能用</th><th title="首个思考字 / 首个正文字，单位秒">首字 思考/正文</th><th>工具调用</th><th>思考</th><th>接口</th><th>上下文</th></tr></thead>'
      + `<tbody>${rows.map(r => rowHtml(r, running)).join('')}</tbody></table>`
      : '<p class="api-gw-dim">保存 key 后自动体检一次，这里列出每个模型能不能用、首字多快、会不会调用工具。</p>')
    + '</section>';
}

function guideHtml() {
  return '<details class="api-gw-guide" data-api-gw-guide><summary>上手说明</summary><ol>'
    + '<li>在网关模型服务网页的「令牌」页复制 key（以 sk- 开头），粘到左边，点「保存配置」。地址已预填，不用改。</li>'
    + '<li>保存后自动体检：看表里哪些模型能用、首字快不快、会不会调用工具。写代码选「会」调用工具的模型。</li>'
    + '<li>新建会话时在启动中心选模型。报错时这里会说原因，并给「换个模型」「重新填 key」等按钮。</li>'
    + '<li>free 分组签到可无限用但不保障速度；要更快可以申请 max 分组的 key。</li>'
    + `</ol>${TUTORIAL_URL ? '<button type="button" data-api-gw-act="tutorial">打开模型使用指南</button>' : ''}</details>`;
}

function asideHtml(payload, running = false) {
  return `<aside class="api-gw-aside" data-api-gw-aside>${groupHtml(payload?.catalog, payload?.gateway)}${tableHtml(payload, running)}${guideHtml()}</aside>`;
}

// 接按钮。hooks：{ shell, pickModel(id) 换模型, focusKey(), rerun(), setThinking(id, enabled) }。
function bind(target, payload, hooks) {
  target.querySelectorAll('[data-api-gw-act]').forEach(button => {
    button.onclick = () => {
      const act = button.dataset.apiGwAct;
      const row = button.closest('[data-api-gw-row]')?.dataset.apiGwRow || '';
      if (act === 'tutorial') return void (TUTORIAL_URL && hooks.shell?.openExternal(TUTORIAL_URL));
      if (act === 'rekey') return hooks.focusKey?.();
      if (act === 'retry') return hooks.rerun?.();
      if (act === 'no-think' || act === 'think') return hooks.setThinking?.(row, act === 'think');
      if (act === 'group-help') {
        const details = target.querySelector('[data-api-gw-groups]');
        if (details) details.open = true;
        target.querySelector('[data-api-gw-group]')?.classList.add('api-gw-flash');
        setTimeout(() => target.querySelector('[data-api-gw-group]')?.classList.remove('api-gw-flash'), 1200);
        return;
      }
      if (act === 'switch-model') {
        const ok = (payload?.health?.rows || []).filter(r => r.ok && r.id !== row);
        const best = ok.find(r => r.tools === true) || ok[0];
        hooks.pickModel?.(best?.id || '', row);
      }
    };
  });
}

// 体检进度：测完一个模型就地换掉那一行。
function updateRow(target, row) {
  const tr = target.querySelector(`[data-api-gw-row="${CSS.escape(row.id)}"]`);
  if (!tr) return;
  tr.outerHTML = rowHtml(row, true);
}

module.exports = { ensureStyle, asideHtml, bind, updateRow, rowHtml, groupHtml, tableHtml };
