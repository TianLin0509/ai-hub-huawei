'use strict';
// 号池额度栏的位置（2026-11-05 用户定）：右侧栏或底部状态栏二选一，默认右侧栏，存在本机。
const STORAGE_KEY = 'hub.codeagentQuotaPlacement';
const PLACEMENTS = ['right', 'bottom'];

function createQuotaPlacement({ storage = null } = {}) {
  const listeners = new Set();
  let value = 'right';
  try { if (PLACEMENTS.includes(storage?.getItem(STORAGE_KEY))) value = storage.getItem(STORAGE_KEY); } catch { /* 读不了按默认 */ }
  return {
    get: () => value,
    set(next) {
      if (!PLACEMENTS.includes(next) || next === value) return;
      value = next;
      try { storage?.setItem(STORAGE_KEY, next); } catch { /* 存不了只影响重启后的选择 */ }
      for (const listener of listeners) listener(next);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    // 设置页的下拉：选了立刻生效，不等「保存」；额度栏上的「移到底栏 / 移回右侧」改了位置，下拉跟着变。
    bindSelect(field, select) {
      if (!field || !select) return;
      field.hidden = false;
      select.value = value;
      select.addEventListener('change', () => this.set(select.value));
      listeners.add(next => { if (select.value !== next) select.value = next; });
    },
  };
}

module.exports = { createQuotaPlacement, STORAGE_KEY, PLACEMENTS };
