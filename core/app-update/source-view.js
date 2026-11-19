'use strict';

// 内源只提供程序附件，不提供更新清单；展示状态不参与外网清单的选择。
// r56（2026-11-19）起成员版程序包也走内源（member-v<版本>），不再显示固定说明；保留常量供旧调用方。
const MEMBER_NOTE = '成员版程序包走内源 member-v<版本>';
function sourceText(row) {
  if (row.status === 'off') return row.reason || '未启用';
  if (row.status === 'missing') return `没有该版本${row.version ? ' v' + row.version : ''}`;
  if (row.status === 'unknown') return row.reason || '等待检查';
  return row.ok ? `可用，最新 v${row.version}` : `连不上：${row.reason || '连接失败'}`;
}

module.exports = { MEMBER_NOTE, sourceText };
