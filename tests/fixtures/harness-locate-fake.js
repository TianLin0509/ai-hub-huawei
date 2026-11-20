'use strict';
// 定位中心结论的假数据（2026-11-20，按接口合同 contract/20261120-定位结论接口.md 的 LocateResult 造）。
// 单测和诊断界面 GUI 走查共用；覆盖五种结论、多候选、手动路径、借用 Node。路径一律是打码后的形式。
const AT = 1795170000000;
const node24 = { kind: 'node', node: '%LOCALAPPDATA%\\Programs\\CodeAgent\\node\\node.exe', nodeVersion: '24.12.0', nodeSource: '借用 CodeAgent 自带的 Node' };
const node22 = { kind: 'node', node: 'C:\\Program Files\\nodejs\\node.exe', nodeVersion: '22.11.0', nodeSource: '本机 PATH 上的 Node' };
const native = { kind: 'native', node: null, nodeVersion: null, nodeSource: null };

function results() {
  const dshDesktop = { path: '%APPDATA%\\DSH Desktop\\resources\\bin\\dsh.exe', source: 'dsh-desktop', sourceLabel: 'DSH 桌面版自带命令', version: '0.2.2', minVersion: '0.2.0',
    runtime: native, verdict: 'ok', reasonCode: null, reason: '试跑通过', verifyMs: 820 };
  const dshNpm = { path: 'D:\\nodejs\\global\\node_modules\\@dsh\\cli\\bin\\dsh.js', source: 'npmrc-prefix', sourceLabel: 'npm 全局目录（.npmrc 里的 prefix）', version: '0.2.1', minVersion: '0.2.0',
    runtime: node22, verdict: 'broken', reasonCode: 'missing-tui', reason: '只装了核心包，缺界面包 @dsh/tui，补齐后才能用', verifyMs: 410 };
  return {
    claude: { id: 'claude', label: 'Claude Code', verdict: 'ok', reasonCode: null, reason: '试跑通过，Hub 会用这一份',
      chosen: { path: '%USERPROFILE%\\.local\\bin\\claude.exe', source: 'official', sourceLabel: '官方安装位置', version: '2.1.40', minVersion: null, runtime: native, verdict: 'ok', reasonCode: null, reason: '试跑通过', verifyMs: 640 },
      candidates: [], checked: [
        { label: '你手动指定的路径', path: '', result: 'skipped', note: '没设' },
        { label: '系统 PATH', path: '', result: 'missing', note: '' },
        { label: '官方安装位置', path: '%USERPROFILE%\\.local\\bin\\claude.exe', result: 'found', note: '' }],
      fixes: [], lastOk: null, checkedAt: AT, durationMs: 700, reasonTrigger: 'open' },
    codex: { id: 'codex', label: 'Codex', verdict: 'too-old', reasonCode: null, reason: '找到的 Codex 是 0.30，Hub 需要 0.40 以上，升级后再用',
      chosen: { path: '%APPDATA%\\npm\\codex.cmd', source: 'npm-prefix', sourceLabel: 'npm 全局目录', version: '0.30.0', minVersion: '0.40.0', runtime: node22, verdict: 'too-old', reasonCode: null, reason: '版本太低', verifyMs: 900 },
      candidates: [], checked: [{ label: 'npm 全局目录', path: '%APPDATA%\\npm', result: 'found', note: '' }],
      fixes: [{ label: '重新检测', act: 'recheck' }], lastOk: null, checkedAt: AT, durationMs: 950, reasonTrigger: 'open' },
    dsh: { id: 'dsh', label: 'DSH', verdict: 'ok', reasonCode: null, reason: 'DSH 桌面版自带命令试跑通过',
      chosen: dshDesktop, candidates: [dshDesktop, dshNpm], checked: [
        { label: '你手动指定的路径', path: '', result: 'skipped', note: '没设' },
        { label: 'DSH 桌面版', path: '%APPDATA%\\DSH Desktop', result: 'found', note: '' },
        { label: 'npm 全局目录（.npmrc 里的 prefix）', path: 'D:\\nodejs\\global', result: 'found', note: '缺界面包' },
        { label: 'Hub 自管目录', path: '%LOCALAPPDATA%\\AI Hub\\cli\\dsh', result: 'missing', note: '' }],
      fixes: [], lastOk: null, checkedAt: AT, durationMs: 1830, reasonTrigger: 'open' },
    pi: { id: 'pi', label: 'pi', verdict: 'not-found', reasonCode: null, reason: '查了 6 处都没找到 pi；可以一键安装，或指定你装在别处的那份',
      chosen: null, candidates: [], checked: [
        { label: '系统 PATH', path: '', result: 'missing', note: '' },
        { label: 'npm 全局目录', path: '%APPDATA%\\npm', result: 'missing', note: '' },
        { label: 'npm 全局目录（.npmrc 里的 prefix）', path: '', result: 'skipped', note: '没有 .npmrc' },
        { label: 'pnpm 全局目录', path: '%LOCALAPPDATA%\\pnpm', result: 'missing', note: '' },
        { label: 'Volta', path: '', result: 'skipped', note: '没装 Volta' },
        { label: 'Hub 自管目录', path: '%LOCALAPPDATA%\\AI Hub\\cli\\pi', result: 'missing', note: '' }],
      fixes: [{ label: '一键安装', act: 'pi-install' }, { label: '我装在别处，选择文件', act: 'harness-pick', id: 'pi' }], lastOk: null, checkedAt: AT, durationMs: 120, reasonTrigger: 'open' },
    codeagent: { id: 'codeagent', label: 'CodeAgent', verdict: 'unavailable', reasonCode: 'timeout', reason: 'CodeAgent 这次试跑 15 秒没回应，可能电脑正忙',
      chosen: { path: '%LOCALAPPDATA%\\Programs\\CodeAgent\\codeagent.exe', source: 'manual', sourceLabel: '你手动指定的', version: '3.1.0', minVersion: null, runtime: native, verdict: 'unavailable', reasonCode: 'timeout', reason: '试跑超时', verifyMs: 15000 },
      candidates: [], checked: [{ label: '你手动指定的路径', path: '%LOCALAPPDATA%\\Programs\\CodeAgent\\codeagent.exe', result: 'found', note: '' }],
      fixes: [{ label: '重新检测', act: 'recheck' }], lastOk: { version: '3.1.0', path: '%LOCALAPPDATA%\\Programs\\CodeAgent\\codeagent.exe', at: AT - 3600e3 }, checkedAt: AT, durationMs: 15010, reasonTrigger: 'open' },
    kimi: { id: 'kimi', label: 'Kimi', verdict: 'broken', reasonCode: 'node-too-old', reason: '本机 Node 是 22.11，Kimi 要 24 以上；可以借用 CodeAgent 自带的 Node 24',
      chosen: { path: '%APPDATA%\\npm\\kimi.cmd', source: 'npm-prefix', sourceLabel: 'npm 全局目录', version: '1.4.0', minVersion: null, runtime: node22, verdict: 'broken', reasonCode: 'node-too-old', reason: 'Node 太旧', verifyMs: 300 },
      candidates: [], checked: [{ label: 'npm 全局目录', path: '%APPDATA%\\npm', result: 'found', note: '' }],
      fixes: [{ label: '借用 CodeAgent 自带的 Node', act: 'harness-borrow-node', id: 'kimi', node: node24.node }], lastOk: null, checkedAt: AT, durationMs: 320, reasonTrigger: 'open' },
  };
}

// 手动选路径的两种结果：成功（试跑通过并保存）、失败（如实返回，不保存）。
function pickOk(id = 'pi') {
  const chosen = { path: 'E:\\tools\\pi\\pi.cmd', source: 'manual', sourceLabel: '你手动指定的', version: '0.9.3', minVersion: null, runtime: node24, verdict: 'ok', reasonCode: null, reason: '试跑通过', verifyMs: 700 };
  return { ...results()[id], verdict: 'ok', reasonCode: null, reason: '你选的 pi 试跑通过，以后就用它', chosen, candidates: [chosen],
    fixes: [], checked: [{ label: '你手动指定的路径', path: chosen.path, result: 'found', note: '' }] };
}
function pickFail(id = 'pi') {
  return { ...results()[id], reasonCode: 'manual-path-failed', reason: '你选的 notepad.exe 不是 pi，试跑输出看不出版本号' };
}

module.exports = { results, pickOk, pickFail, AT };
