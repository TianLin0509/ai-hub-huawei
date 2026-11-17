'use strict';
// pi 会话存的模型线路缺钥匙（r39 审查 P1）：Hub 不再悄悄换线路，唤醒失败页上就地给补 Key 的输入框，
// 点「保存并继续」存进 Hub 设置（和设置页同一处），再重新唤醒这个会话。公司模型线路没有 Key 可填，只说明去哪配置。

const isPiKind = kind => /^pi(?:-resume)?$/.test(String(kind || ''));

// 存钥匙：DeepSeek Key 和设置页「DeepSeek」同一字段；Token Plan Key 和 ACP 设置同一字段（千问 / DSH 共用）。
async function saveRouteKey(ipc, keyField, key) {
  if (keyField === 'deepseek') {
    const result = await ipc.invoke('save-hub-config', { deepseekApiKey: key });
    if (!result?.success) throw new Error(result?.error === 'config_read_failed' ? '现有设置读不出来，没有保存' : '保存没有成功');
    return;
  }
  if (keyField === 'tokenplan') {
    const result = await ipc.invoke('acp:settings:save', { apiKey: key });
    if (!result?.ok) throw new Error(result?.message || '保存没有成功');
    return;
  }
  throw new Error('这条线路没有可填的 Key');
}

// 返回是否挂上了补钥匙区；不是 pi、或线路其实可用时什么也不做。
// replaceEl：原来那行通用报错（带 Error invoking remote method… 前缀），挂上补钥匙区后藏起来，不重复说两遍。
async function mountPiRouteKeyFix(container, { session, modelId, ipc, document: doc = globalThis.document, onRetry = () => {}, replaceEl = null } = {}) {
  if (!container || !session || !isPiKind(session.kind) || !modelId) return false;
  let check;
  try { check = await ipc.invoke('pi:route-check', { model: modelId, profileId: session.acpProfileId || '' }); } catch { return false; }
  if (!check || check.ok || !container.isConnected) return false;
  const box = doc.createElement('div');
  box.className = 'pi-route-key-fix';
  const text = doc.createElement('p');
  text.textContent = check.message;
  box.append(text);
  if (check.keyField) {
    const row = doc.createElement('div');
    row.className = 'pi-route-key-fix-row';
    const input = doc.createElement('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = `粘贴${check.label} Key`;
    input.setAttribute('aria-label', `${check.label} Key`);
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'pi-route-key-fix-save';
    button.textContent = '保存并继续';
    const status = doc.createElement('span');
    status.className = 'pi-route-key-fix-status';
    const submit = async () => {
      const key = input.value.trim();
      if (!key) { status.textContent = '先粘贴 Key'; input.focus(); return; }
      button.disabled = true; input.disabled = true; status.textContent = '正在保存…';
      try {
        await saveRouteKey(ipc, check.keyField, key);
        status.textContent = '已保存，正在重新打开会话…';
        await onRetry();
      } catch (error) {
        status.textContent = `没有保存成功：${error.message}`;
        button.disabled = false; input.disabled = false;
      }
    };
    button.addEventListener('click', () => { void submit(); });
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void submit(); } });
    row.append(input, button);
    box.append(row, status);
  }
  container.append(box);
  if (replaceEl) replaceEl.hidden = true;
  return true;
}

module.exports = { mountPiRouteKeyFix, saveRouteKey, isPiKind };
