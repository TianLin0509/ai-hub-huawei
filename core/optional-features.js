'use strict';
// 可选功能（2026-10-30 用户）：公司版的助理、论坛、桌宠默认都关，用户在设置菜单「可选功能」里自己开。
// 起因：同事反馈电脑卡、鼠标漂移；这些功能不用也一直在后台取数、开隐藏浏览器窗口、挂鼠标钩子，不想用的人白付开销。
// 助理、论坛的开关记在数据目录 optional-features.json；桌宠沿用自己的 hub-pet.json（main.js 把三者拼成一张清单）。
// 文件不存在 = 第一次用这一版：一律关（老用户原来是被默认打开的，不是自己选的，同样关一次）。
const fs = require('fs');
const path = require('path');

const FILE = 'optional-features.json';

// 设置菜单「可选功能」里每一项的说明：用来做什么、开着有什么开销。
const CATALOG = Object.freeze({
  assistant: { name: '助理', desc: '每日简报、WeLink 消息提醒、对话问答、会议与会议室', cost: '开着时工作日每 10 分钟后台读一次 WeLink，每分钟检查一次登录' },
  forum: { name: '论坛', desc: '稼先社区、心声社区今天的热帖与 AI 摘要', cost: '开着时工作日早上在后台打开一个隐藏的浏览器窗口取帖子，没登录会每 30 分钟重试' },
  pet: { name: '桌宠', desc: '桌面角落的小猫，提醒会话进度', cost: '开着时一直有一个置顶的小窗口，每 0.1 秒看一次光标是否碰到它' },
});

// defaults 只给隔离测试用（main.js 在用环境变量强开助理/论坛的隔离实例里传 true，老的端到端测试照旧能直接用）。
function createOptionalFeatures({ dataDir, logger = console, defaults = {} } = {}) {
  const file = path.join(dataDir, FILE);
  let value = { assistant: defaults.assistant === true, forum: defaults.forum === true };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const k of Object.keys(value)) if (typeof raw?.[k] === 'boolean') value[k] = raw[k];
  } catch (error) { if (error.code !== 'ENOENT') logger.warn?.('[optional-features] unreadable, all off:', error.message); }

  function save() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(value, null, 1) + '\n', 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) { logger.warn?.('[optional-features] save failed:', error.message); }
  }

  return {
    file,
    get: id => value[id] === true,
    set(id, on) {
      if (!(id in value)) throw new Error('未知的可选功能：' + id);
      value = { ...value, [id]: !!on };
      save();
      return value[id];
    },
  };
}

module.exports = { CATALOG, FILE, createOptionalFeatures };
