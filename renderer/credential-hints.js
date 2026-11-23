'use strict';
// 要输账号密码 / Key 的地方旁边的 ⓘ 说明（2026-11-23 N8：同事反馈「要输账号密码不放心」）。
// 只写实际怎么存：存在哪个目录、有没有加密、发给谁；没有加密就写明没有加密，不夸大。
// 依据（改存储方式时同步改这里，tests/unit-credential-hints.test.js 会对照）：
//   考勤：登录窗口是 Hub 自己的浏览器窗口，分区 persist:company-forum（main/company-forum-browser.js），Cookie 由 Electron
//         存在程序的浏览器数据目录 Partitions\company-forum；没开 Cookie 加密开关，未另外加密。拿不到时复制 Edge 登录状态到临时目录（main/company-attendance-edge.js）。
//   会议室：组件用 Edge / Chrome 打开登录页，登录状态在 <会议室数据目录>\browser_profile（room-component/engine.py），Cookie 由浏览器按 Windows 账户加密。
//   邮箱密码：Electron safeStorage（Windows 即 DPAPI）密文写在 <Hub 数据目录>\claude-mailboxes.json（core/claude-mailbox-vault.js）。
//   API 网关 key：safeStorage 密文写在 <Hub 数据目录>\api-gateway\gateway.json，明文只在主进程内存、经环境变量交给本机反代（core/api-gateway.js）。
//   自有 API Key：config.json 与 connection.json 用 safeStorage 加密；Codex 的 auth.json 由原生 CLI 读取，仍为明文。
const path = require('path');

function hubDataDir() {
  try { return require('../core/data-dir').getHubDataDir(); } catch { return 'AI Hub 数据目录'; }
}

function attendanceLogin() {
  return ['登录考勤：密码存在哪',
    '账号密码只在弹出的公司登录页里输入、直接交给公司认证服务；AI Hub 不读取、不保存、不外传密码。',
    '登录后的状态（Cookie）存在本机 AI Hub 自带浏览器的数据目录（Partitions\\company-forum，和论坛共用），没有另外加密，只在本机读考勤用。',
    '这个窗口读不到时，会临时复制本机 Edge 的登录状态，在后台 Edge 里读一次。'].join('\n');
}

function roomLogin(home = '') {
  const where = home ? path.join(home, 'browser_profile') : '会议室数据目录下的 browser_profile';
  return ['登录会议室：密码存在哪',
    '账号密码只在会议室组件打开的 Edge / Chrome 登录页里输入、直接交给公司认证服务；AI Hub 不读取、不保存、不外传密码。',
    `登录状态由这个浏览器存在本机 ${where}，Cookie 由浏览器按 Windows 账户加密。`].join('\n');
}

function mailboxSecret(dataDir = hubDataDir()) {
  return ['邮箱密码存在哪',
    `用 Windows 账户加密（DPAPI）后只存在本机 ${path.join(dataDir, 'claude-mailboxes.json')}；换 Windows 账户或换电脑都解不开。`,
    '界面和 AI 看不到明文，AI Hub 不外传；只在你点复制时解密。'].join('\n');
}

function gatewayKey(dataDir = hubDataDir()) {
  return ['API key 存在哪',
    `用 Windows 账户加密（DPAPI）后只存在本机 ${path.join(dataDir, 'api-gateway', 'gateway.json')}。`,
    '明文只在 AI Hub 主程序内存里，只发给上面的网关地址用来调用模型，不发往别处。'].join('\n');
}

function ownApiKey(dataDir = hubDataDir()) {
  return ['API Key 存在哪',
    `用 Electron safeStorage 按 Windows 账户加密（DPAPI），保存在本机 ${path.join(dataDir, 'config.json')}（备份为 config.json.bak）；cli-api-profiles 下 connection.json 同样加密。`,
    '旧配置及备份在加密与保存成功后清除明文字段；旧快照按读取迁移，未读取的历史快照保留原状。',
    '内网共享池切换前备份位于 lan-pool/settings.json，其中的自有接口 Key 同样加密，断开时恢复。旧明文快照迁移失败仍可恢复，下次再迁；新建快照加密失败则停止启动并提示。',
    'Codex CLI 必须读取的 auth.json 仍存明文 Key（cli-api-profiles 或 codex-api-profile 目录）；Claude Code 和 DSH 通过进程环境变量接收 Key。',
    '换电脑、换 Windows 账户或密文损坏导致解不开时，请在此处补填 Key，点「保存并继续」。',
    '只发给上面填的接口地址，AI Hub 不发往别处。'].join('\n');
}

module.exports = { attendanceLogin, roomLogin, mailboxSecret, gatewayKey, ownApiKey };
