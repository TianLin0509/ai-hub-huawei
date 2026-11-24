'use strict';

// 内源只提供程序附件，不提供更新清单；展示状态不参与外网清单的选择。
// r56（2026-11-19）起成员版程序包也走内源（member-v<版本>），不再显示固定说明；保留常量供旧调用方。
const MEMBER_NOTE = '成员版程序包走内源 member-v<版本>';
const CONNECT_FAIL = /连不上|超时|秒内|没响应|HTTP|ENOTFOUND|ECONN|fetch failed|网络|DNS|证书|代理|被拦|未完成|中断|取消|失败/;
function sourceText(row) {
  if (row.status === 'off') return row.reason || '未启用';
  if (row.status === 'missing') return `没有该版本${row.version ? ' v' + row.version : ''}`;
  if (row.status === 'unknown') return row.reason || '等待检查';
  if (row.ok) return `可用，最新 v${row.version}`;
  // R29 审查 #3：连得上但清单没签名、签名不对、版本对不上时照原因说，不加「连不上」，免得和上一行「可用」打架。
  if (row.reason && !CONNECT_FAIL.test(row.reason)) return row.reason;
  return `连不上：${row.reason || '连接失败'}`;
}

// 更新窗里「公司内源」那一行（R35）：可用 / 缺包 / 连不上，不可用时写清原因和下一步。
function internalLine(row) {
  if (row.ok || row.status === 'unknown' || row.status === 'off') return sourceText(row);
  if (row.status === 'missing') return `缺包：内源上还没有${row.version ? ' v' + row.version + ' 的' : ''}更新包，可能还在同步，请过几分钟再试`;
  return require('./openx-source').userReason(row.reason);
}

module.exports = { MEMBER_NOTE, sourceText, internalLine };
