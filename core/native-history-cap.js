'use strict';
// 原生 / 卡片会话在内存里的对话记录上限（2026-11-23 开销优化）。
// 卡片会话（ACP、DSH、千问、pi）把每一轮的问答和工具块都留在内存里，长时间挂着的会话只增不减。
// 原文仍在各自的记录文件或历史库里，这里只限制内存里留多少：保留最近 KEEP 轮，正在进行的轮次一律不动。
// 为了不在每一轮都搬数组，超出 KEEP 一截（SLACK）后才一次裁回 KEEP。
const KEEP = 300;
const SLACK = 30;

// 卡片记录数组（DSH、千问、pi）：从最老的开始丢，碰到属于最新一轮的记录（含插话）就停，返回丢了几条。
// 不按 status 判断：没等到结束信号的旧记录可能一直停在 running，按它停会一条都裁不掉。
function trimRecords(list, keep = KEEP, slack = SLACK) {
  if (!Array.isArray(list) || list.length <= keep + slack) return 0;
  const want = list.length - keep, last = list[list.length - 1], lastTurn = last && last.turnId;
  let n = 0;
  while (n < want && list[n] !== last && !(lastTurn && list[n] && list[n].turnId === lastTurn)) n++;
  if (n) list.splice(0, n);
  return n;
}

// 普通数组（如千问的提交钩子轮次）：只留最近 keep 条，返回丢了几条。
function trimTail(list, keep = KEEP, slack = SLACK) {
  if (!Array.isArray(list) || list.length <= keep + slack) return 0;
  const n = list.length - keep;
  list.splice(0, n);
  return n;
}

// ACP 的轮次表（Map，按插入顺序就是时间顺序）：丢最老的已结束轮次，跳过进行中和 skip 指定的轮次，返回丢了几轮。
function trimTurnMap(map, { keep = KEEP, slack = SLACK, skip = null } = {}) {
  if (!(map instanceof Map) || map.size <= keep + slack) return 0;
  let n = 0;
  const want = map.size - keep;
  for (const [id, turn] of map) {
    if (n >= want) break;
    if (id === skip || turn?.status === 'inProgress') continue;
    map.delete(id); n++;
  }
  return n;
}

module.exports = { KEEP, SLACK, trimRecords, trimTail, trimTurnMap };
