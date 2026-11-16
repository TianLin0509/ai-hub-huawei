'use strict';
// UI choice values may include a route. The CLI model argument always remains
// the raw ID, while provider identity travels in separate session metadata.
function routeFields(value = {}) {
  const provider = value.codeagentModelProvider || value.provider;
  if (typeof provider !== 'string' || !provider.trim() || provider.length > 150 || /[\x00-\x1f\x7f]/.test(provider)) return {};
  return { codeagentModelProvider: provider.trim(),
    codeagentModelProviderLabel: String(value.codeagentModelProviderLabel || value.providerLabel || provider).slice(0, 150),
    codeagentModelMenuLabel: String(value.codeagentModelMenuLabel || value.menuLabel || '').slice(0, 164) };
}
function choiceValue(option = {}) {
  return option.provider ? JSON.stringify([option.id, option.provider, option.providerLabel || option.provider, option.menuLabel || option.id]) : option.id || '';
}
function decodeChoice(value = '') {
  try {
    const [id, provider, providerLabel, menuLabel] = JSON.parse(value);
    if (require('./model-id').isSafeModelId(id) && typeof provider === 'string') return { id, ...routeFields({ provider, providerLabel, menuLabel }) };
  } catch { /* Legacy choices are raw model IDs. */ }
  return { id: value };
}
module.exports = { routeFields, choiceValue, decodeChoice };
