'use strict';

// Keep one short explanation in the overview, table and session picker.
function pauseReason(avoid, now = Date.now()) {
  if (!avoid) return '';
  if (avoid.kind === 'model-config') return avoid.label || '模型配置待核对';
  const reason = avoid.source === 'manual' ? '手动暂停' : avoid.kind === 'rate-limit' ? '请求过于频繁' : '额度用完';
  const today = new Date(Number(now) + 8 * 3600000).toISOString().slice(0, 10);
  if (avoid.until != null && Number.isFinite(Number(avoid.until))) {
    const target = new Date(Number(avoid.until) + 8 * 3600000).toISOString();
    const when = target.slice(0, 10) === today ? target.slice(11, 16) : target.slice(5, 16).replace('T', ' ');
    return `${reason} · 约 ${when} 恢复`;
  }
  if (avoid.until === null) return `${reason} · 直到手动恢复`;
  return String(avoid.label || avoid.reason || reason)
    .replace(/[（(]\s*(?:quota|error|credit|manual|Credit\s*读数|报错|手动暂停)\s*[）)]/gi, '')
    .replace(/额度上限|余额不足/g, '额度用完').replace(/预计\s*/g, '约 ')
    .replace(/\s*[，,·]\s*/g, ' · ').replace(/\s{2,}/g, ' ').trim()
    .replace(/约 (\d{2}-\d{2}) (\d{2}:\d{2}) 恢复/g, (text, date, time) => date === today.slice(5) ? `约 ${time} 恢复` : text);
}

// Health is shared by the page and picker. Pool entries need known-ready status;
// personal credentials are ultimately interpreted by the CLI, not this reader.
function accountState(account = {}, { personal = false } = {}) {
  const state = account.state || (personal && account.present ? 'ready' : 'login-required');
  if (state !== 'ready') return { usable: false, tone: 'warn', label: '需登录', detail: {
    expired: '登录已过期', 'login-required': personal ? '个人账号尚未登录' : '等待账号主人登录', unreadable: '登录凭证无法读取'
  }[state] || '请检查登录状态' };
  if (account.sameAsPersonal || account.duplicateOf) return { usable: false, tone: 'muted', label: '重复账号',
    detail: account.sameAsPersonal ? '与个人账号相同，不参与选号' : '与号池中的其他账号相同，不参与选号' };
  if (account.avoid) return { usable: false, tone: 'warn', label: account.avoid.source === 'manual' ? '暂停中（手动）' : '暂停中（额度）',
    detail: pauseReason(account.avoid) };
  return { usable: true, tone: 'ok', label: '可用', detail: '' };
}

function accountOptionLabel(account = {}, options) {
  const state = accountState(account, options);
  const name = account.note || account.accountLabel || (options?.personal ? '个人账号' : '未备注账号');
  const label = account.note && account.accountLabel ? `${name} · ${account.accountLabel}` : name;
  return `${label} · ${state.label} · ${Number(account.activeSessions) || 0} 个进行中会话`;
}

const usableAccounts = accounts => (accounts || []).filter(account => accountState(account).usable);
const canStartAccount = (account, options = {}) => options.personal || accountState(account, options).usable;

function accountChoiceValue(mode, pick = '') {
  return mode === 'pool-manual' ? `account:${pick}` : mode === 'pool' ? 'pool' : 'personal';
}

function accountChoiceSelection(value) {
  return String(value).startsWith('account:')
    ? { mode: 'pool-manual', pick: String(value).slice(8) }
    : { mode: value === 'pool' ? 'pool' : 'personal', pick: '' };
}

module.exports = { accountState, accountOptionLabel, usableAccounts, canStartAccount, pauseReason, accountChoiceValue, accountChoiceSelection };
