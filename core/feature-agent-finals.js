'use strict';
// 后台功能按实际后端读终态；ACP 使用已有原生记录，Claude/Codex 使用绑定过身份的落盘记录。
function read(meta, manager, live) {
  if (!meta) return [];
  const id = meta.id || meta.hubId;
  const native = manager.getNativeSession?.(id) || manager.getNativeCodex?.(id);
  if (native?.readTranscript) {
    return native.readTranscript({ limit: 40 }).filter(card => card.role === 'assistant' && card.stopReason === 'completed')
      .map(card => ({ ...card, text: card.text || (card.blocks || []).filter(b => b.type === 'text').map(b => b.text).join('\n') }));
  }
  const kind = /^codex/.test(meta.kind || '') ? 'codex' : 'claude';
  const result = live.read({ ...meta, id, kind });
  return result?.available ? result.records : [];
}
module.exports = { read };
