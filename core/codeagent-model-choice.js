'use strict';
// UI choice values may include a route. The CLI model argument always remains
// the raw ID, while provider identity travels in separate session metadata.
function routeFields(value = {}) {
  const model = value.currentModel && typeof value.currentModel === 'object' ? value.currentModel : {};
  const provider = value.codeagentModelProvider || value.provider || model.provider;
  if (typeof provider !== 'string' || !provider.trim() || provider.length > 150 || /[\x00-\x1f\x7f]/.test(provider)) return {};
  return { codeagentModelProvider: provider.trim(),
    codeagentModelProviderLabel: String(value.codeagentModelProviderLabel || value.providerLabel || model.providerLabel || provider).slice(0, 150),
    codeagentModelMenuLabel: String(value.codeagentModelMenuLabel || value.menuLabel || model.menuLabel || '').slice(0, 164) };
}
function providerDisplayLabel(provider, label) {
  const name = String(label || provider || '');
  const group = String(provider || '').split('/').pop().toLowerCase();
  if (group === 'max') return `${name}（高倍率分组）`;
  if (group === 'free') return `${name}（免费分组）`;
  return name;
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
module.exports = { routeFields, choiceValue, decodeChoice, providerDisplayLabel };
