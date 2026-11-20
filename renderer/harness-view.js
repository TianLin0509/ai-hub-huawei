'use strict';
// 本机 CLI 定位结论的界面画法（2026-11-20，HUB-H 第一期 A 线）：体检里的结论卡、启动中心徽标共用这里的文字和配色语义。
// 数据来自主进程定位中心（core/harness-locator，经 harness:* IPC），格式见接口合同 LocateResult；这里只把它画成 HTML 字符串，不碰 IPC。
// 纯函数，方便在 node 里直接单测。

// 五种结论：同事看到的叫法、配色语义（ok 绿 / warn 黄 / bad 红）、启动中心徽标文字（能用时不出徽标）。
const VERDICT = {
  ok: { label: '能用', tone: 'ok', badge: '' },
  unavailable: { label: '暂时不可用', tone: 'warn', badge: '暂时不可用' },
  'too-old': { label: '版本太低', tone: 'warn', badge: '版本太低' },
  broken: { label: '跑不起来', tone: 'bad', badge: '跑不起来' },
  'not-found': { label: '没找到', tone: 'bad', badge: '未安装' },
};
const CHECK_RESULT = { found: '找到', missing: '没有', skipped: '跳过', error: '出错' };
const SOURCE = {
  manual: '你手动指定的', 'env-override': '环境变量指定的', path: '系统 PATH', 'registry-path': '注册表里最新的 PATH', 'dsh-desktop': 'DSH 桌面版自带',
  'npm-prefix': 'npm 全局目录', 'npmrc-prefix': 'npm 全局目录（.npmrc 设置）', pnpm: 'pnpm 全局目录', volta: 'Volta', nvm: 'nvm', fnm: 'fnm',
  official: '官方安装位置', 'hub-managed': 'Hub 自管目录', 'app-paths': '系统登记的程序路径', 'uninstall-key': '系统已安装程序列表', 'known-dir': '常用安装目录',
};
// 启动中心卡片的 data-kind → 定位中心的 id。
const KIND_TO_ID = { claude: 'claude', codex: 'codex', deepseek: 'dsh', pi: 'pi', codeagent: 'codeagent', kimi: 'kimi', gemini: 'antigravity' };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const verdictOf = v => VERDICT[v] || VERDICT['not-found'];
const versionText = v => (v ? 'v' + String(v).replace(/^v/i, '') : '');
const sourceText = c => (c && (c.sourceLabel || SOURCE[c.source] || c.source)) || '';
function runtimeText(c) {
  const rt = c && c.runtime;
  if (!rt || rt.kind !== 'node') return '';
  const v = rt.nodeVersion ? `Node ${String(rt.nodeVersion).replace(/^v/i, '')}` : 'Node';
  return rt.nodeSource ? `用 ${v}（${rt.nodeSource}）` : `用 ${v}`;
}
// 首行的小字：来源 · 版本 · 用哪份 Node 跑。
function metaText(c) { return [sourceText(c), versionText(c && c.version), runtimeText(c)].filter(Boolean).join(' · '); }

function badge(result) {
  if (!result || !result.verdict) return { text: '', tone: '', title: '' };
  const v = verdictOf(result.verdict);
  return { text: v.badge, tone: v.tone, title: result.reason || '' };
}

// 多个候选时的一句概括：「找到 2 处，1 处能用」。
function candidateSummary(result) {
  const list = (result && result.candidates) || [];
  if (list.length < 2) return '';
  return `找到 ${list.length} 处，${list.filter(c => c.verdict === 'ok').length} 处能用`;
}
const isManual = result => !!(result && result.chosen && result.chosen.source === 'manual');
const sameCandidate = (a, b) => !!(a && b && a.path && a.path === b.path);

// 行内首行：结论标签 + 来源/版本/Node。
function headHtml(result) {
  const v = verdictOf(result.verdict);
  const meta = metaText(result.chosen || (result.lastOk ? { version: result.lastOk.version } : null));
  return `<span class="hx-verdict hx-${v.tone}">${esc(v.label)}</span>${meta ? `<span class="hx-meta" title="${esc(meta)}">${esc(meta)}</span>` : ''}`;
}
// 行内第二行：一句人话（reason），多候选时加一句概括。
function reasonText(result) {
  const sum = candidateSummary(result);
  const last = result.verdict === 'unavailable' && result.lastOk && result.lastOk.version ? `先沿用上次能用的 ${versionText(result.lastOk.version)}` : '';
  return [result.reason || verdictOf(result.verdict).label, last, sum].filter(Boolean).join('；');
}

function candidatesHtml(result) {
  const list = (result && result.candidates) || [];
  if (!list.length) return '';
  return `<div class="hx-sub">找到的位置</div><ul class="hx-cands">${list.map(c => {
    const v = verdictOf(c.verdict); const use = sameCandidate(c, result.chosen);
    return `<li class="hx-cand${use ? ' hx-chosen' : ''}"><span class="hx-verdict hx-${v.tone}">${esc(v.label)}</span>`
      + (use ? '<span class="hx-use">Hub 将用这个</span>' : '')
      + `<span class="hx-cand-meta">${esc(metaText(c))}</span>`
      + `<div class="hx-path" title="${esc(c.path)}">${esc(c.path)}</div>`
      + (c.verdict !== 'ok' && c.reason ? `<div class="hx-cand-reason">${esc(c.reason)}</div>` : '') + '</li>';
  }).join('')}</ul>`;
}

function checkedHtml(result, open) {
  const list = (result && result.checked) || [];
  const head = `<button type="button" class="hx-toggle" data-hx-checked="${esc(result.id)}" aria-expanded="${!!open}">${open ? '收起' : '展开'}查过的 ${list.length} 处</button>`;
  if (!open) return head;
  return head + `<ol class="hx-checked">${list.map(c => `<li class="hx-r-${esc(c.result)}"><span class="hx-r">${esc(CHECK_RESULT[c.result] || c.result || '')}</span>`
    + `<span class="hx-c-label">${esc(c.label)}</span>${c.path ? `<span class="hx-path" title="${esc(c.path)}">${esc(c.path)}</span>` : ''}`
    + (c.note ? `<span class="hx-note">${esc(c.note)}</span>` : '') + '</li>').join('')}</ol>`;
}

// 展开后的结论卡正文：候选列表、查过的位置、手动路径和复制诊断。
// rowActs：行右侧实际画出来的按钮（fixes 的 act）。组件中心对 Claude/Codex/DSH 只画安装按钮，fixes 里的「选择文件」「改回自动查找」
// 并没出现在界面上（2026-11-21 审查第 3 条），所以这里按实际画出来的去重，保证每张 CLI 卡都有这两个按钮。
function panelHtml(result, { checkedOpen = false, rowActs = [] } = {}) {
  if (!result) return '';
  const shown = new Set(rowActs);
  const clearFix = (result.fixes || []).find(f => f.act === 'harness-clear-manual');
  const manual = isManual(result) || !!clearFix;
  const buttons = [
    shown.has('harness-pick') ? '' : `<button type="button" class="ec-btn" data-hx-act="pick" data-hx-id="${esc(result.id)}">我装在别处，选择文件</button>`,
    shown.has('harness-clear-manual') ? ''
      : manual ? `<button type="button" class="ec-btn" data-hx-act="clear" data-hx-id="${esc(result.id)}" title="清掉你手动指定的路径，Hub 重新自动查找">改回自动查找</button>`
        : `<button type="button" class="ec-btn" data-hx-act="clear" data-hx-id="${esc(result.id)}" disabled title="现在用的就是自动查找到的，没有手动指定的路径">改回自动查找</button>`,
    `<button type="button" class="ec-btn" data-hx-act="copy" data-hx-id="${esc(result.id)}" title="复制这一项查过的位置和结论，用户名已打码">复制诊断</button>`,
  ].join('');
  const when = result.checkedAt ? new Date(result.checkedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  return `<div class="hx-panel" data-hx-panel="${esc(result.id)}">${candidatesHtml(result)}`
    + `<div class="hx-tools">${checkedHtml(result, checkedOpen)}<span class="hx-grow"></span>${when ? `<span class="hx-when">${esc(when)} 检测${result.durationMs != null ? `，用时 ${(result.durationMs / 1000).toFixed(1)} 秒` : ''}</span>` : ''}${buttons}</div></div>`;
}

// 选完文件后的一句提示：只有试跑结论是「能用」才算用上了（v1.2 起定位中心也只在能用时保存）；
// 其他结论（含版本太低、跑不起来）一律按失败报，原设置没变（2026-11-21 审查第 1 条）。
const pickSucceeded = result => !!(result && result.verdict === 'ok' && isManual(result));
function pickMessage(result) {
  if (!result) return { text: '', bad: false };
  if (pickSucceeded(result)) {
    const c = result.chosen;
    return { text: `已改用你选的文件${c.version ? '（' + versionText(c.version) + '）' : ''}：${String(result.reason || '试跑通过').replace(/[。.]$/, '')}`, bad: false };
  }
  const why = String(result.reason || (result.chosen && result.chosen.reason) || '试跑没通过').replace(/[。.]$/, '');
  return { text: `没用上你选的文件：${why}。原来的设置没有改动。`, bad: true };
}

// 安装或补齐失败的原话在界面上显示前再打一次码：用户目录里的用户名换成 <user>（主进程的原话可能带路径）。
function maskUser(text) {
  return String(text || '').replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"'<>]+/gi, '$1<user>');
}

// 一键反馈附带诊断：接在同事写的描述后面（描述超长被裁时先裁掉的是诊断，不是同事的话）。只附定位中心打码后的文本。
const FEEDBACK_HEAD = '## 本机 CLI 识别诊断（已打码）';
function appendDiagnosis(description, diagnosis) {
  const text = String(diagnosis || '').trim();
  if (!text) return description;
  return [String(description || '').trimEnd(), '', FEEDBACK_HEAD, text].join('\n');
}

module.exports = { FEEDBACK_HEAD, appendDiagnosis, VERDICT, CHECK_RESULT, SOURCE, KIND_TO_ID, esc, verdictOf, metaText, badge, candidateSummary, headHtml, reasonText, panelHtml, candidatesHtml, checkedHtml, pickMessage, pickSucceeded, isManual, maskUser };
