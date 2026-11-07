'use strict';

// 公司版启动中心：Claude Code / Codex / DSH 选「公司模型」时的账号选择（2026-11-07 用户：「和 CodeAgent 一致，
// 本质上就是选账号选模型」）。选项和 CodeAgent 的账号下拉同一套：自动挑号 / 个人账号 / 号池里的号，
// 数据也是同一份（IPC codeagent-pool:list）。选定的号整段会话固定用（恢复、分支沿用），反代不给它换号。
// 取值：'auto' | 'personal' | 号池账号 id；下拉框的 value 沿用 CodeAgent 的写法（pool / personal / account:<id>）。
const { accountState, accountOptionLabel, usableAccounts, accountChoiceValue, accountChoiceSelection } = require('./codeagent-account-state');
const { accountHasModel } = require('../core/company-proxy-account');

const STORAGE_KEY = 'hub.companyProxy.account';
const ID = /^(?:[a-z0-9]{6,16}|personal)$/;

function normalizeChoice(value) {
  const text = String(value || '').trim();
  return text === 'personal' || (ID.test(text) && text !== 'auto') ? text : 'auto';
}
// 下拉框的 value -> 取值
function choiceFromSelect(value) {
  const choice = accountChoiceSelection(value);
  return choice.mode === 'pool-manual' ? normalizeChoice(choice.pick) : choice.mode === 'pool' ? 'auto' : 'personal';
}
function selectValue(choice) {
  return choice === 'auto' ? accountChoiceValue('pool') : choice === 'personal' ? accountChoiceValue('personal') : accountChoiceValue('pool-manual', choice);
}

const blockedReason = (account, model) => (accountState(account).usable && !accountHasModel(account, model) ? `没有 ${model} 的权限` : '');

/**
 * 画账号下拉需要的一切。pool 是 codeagent-pool:list 的结果；model 是选中的公司模型。
 * -> { html, value, control: { type, account, available }, note, unavailable }
 */
function describe({ pool = {}, model = '', choice = 'auto', escapeHtml }) {
  const esc = escapeHtml || (v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const accounts = Array.isArray(pool.accounts) ? pool.accounts : [];
  const personal = pool.personal || {};
  const fits = accounts.filter(a => !blockedReason(a, model));
  // 自动挑号的候选：能用、有这个模型权限的号，再加个人账号（反代在其他号都不可用时才用它）。
  const available = usableAccounts(fits).length + (personal.state === 'ready' ? 1 : 0);
  const meta = (type, account = {}, blocked = '') => ` data-account-info="${esc(JSON.stringify({ type, account, available, ...(blocked ? { blocked } : {}) }))}"`;
  let html = `<option value="${selectValue('auto')}"${meta('auto')}>${esc(`自动挑号（${available} 个可用号，优先没有会话的号，个人账号最后用）`)}</option>`;
  html += `<option value="${selectValue('personal')}" data-account-section="指定账号"${meta('personal', personal)}>${esc('个人账号 · ' + accountOptionLabel(personal, { personal: true }))}</option>`;
  const picked = choice !== 'auto' && choice !== 'personal' ? accounts.find(a => a.id === choice) : null;
  const missing = choice !== 'auto' && choice !== 'personal' && !picked;
  if (missing) html += `<option value="${esc(selectValue(choice))}" disabled>原账号不可用，请重新选择</option>`;
  html += accounts.map(a => {
    const blocked = blockedReason(a, model);
    const usable = accountState(a).usable && !blocked;
    return `<option value="${esc(selectValue(a.id))}"${meta('account', a, blocked)}${usable ? '' : ' disabled'}>${esc(accountOptionLabel(a) + (blocked ? ' · ' + blocked : ''))}</option>`;
  }).join('');
  html += `<option value="manage-accounts" data-account-divider="1"${meta('manage')}>管理账号…</option>`;
  const pickedBlocked = picked ? blockedReason(picked, model) : '';
  const unavailable = missing || (picked && (!accountState(picked).usable || !!pickedBlocked));
  const type = choice === 'auto' ? 'auto' : choice === 'personal' ? 'personal' : 'account';
  const control = { type, account: type === 'personal' ? personal : picked || { note: '原账号不可用', state: 'login-required' }, available };
  const note = unavailable
    ? (pickedBlocked ? `所选的号${pickedBlocked}：请换一个号，或换一个模型。` : '所选的号当前不可用，请到「账号」页登录、恢复使用，或换一个号。')
    : type === 'auto' ? '自动挑号：反代按各号的会话数分配，号被限流时自动换号，其他号都不可用时才用个人账号。'
      : type === 'personal' ? '个人账号：整段会话固定用你自己登录的 CodeAgent 账号（恢复、分支也是），不换号。'
        : '指定账号：整段会话固定用这个号（恢复、分支也是）；这个号被限流时会话等它恢复，不自动换号。';
  return { html, value: selectValue(choice), control, note, unavailable: !!unavailable };
}

// 发给主进程的取值：自动不传（反代照旧自动分配）。
function launchOpts(choice) {
  const value = normalizeChoice(choice);
  return value === 'auto' ? {} : { companyProxyPick: value };
}

module.exports = { STORAGE_KEY, normalizeChoice, choiceFromSelect, selectValue, describe, launchOpts };
