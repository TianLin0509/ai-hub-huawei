'use strict';
const fs = require('node:fs');
const API_VERSION = 1;
// The mirror has manifests and versioned archives, not a landing/latest page.
// The download handler resolves this entry to an existing archive before opening.
const DOWNLOAD_URL = 'https://me.lt-stockpartner.tech/pptutor/manifest.json';
const GITHUB_DOWNLOAD_URL = 'https://github.com/TianLin0509/PPTutor/releases/latest';
const READ_ONLY = new Set(['status', 'catalog', 'search', 'read', 'report']);
const failure = (code, message, fields = {}) => Object.assign(new Error(message), { code, ...fields });
const retryRead = fn => process.platform === 'win32' ? require('../fs-rename-retry').wrapSync(fn) : fn;
const statResult = retryRead(file => fs.statSync(file));
const readResult = retryRead(file => fs.readFileSync(file, 'utf8'));

function readJson(file, limit = 24 * 1024 * 1024) {
  if (statResult(file).size > limit) throw failure('DOCTOR_RESULT_TOO_LARGE', 'PPT Doctor 结果过大，请减少读取页数；未截断交付');
  try { return JSON.parse(readResult(file).replace(/^\uFEFF/, '')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw failure('DOCTOR_INVALID_RESPONSE', 'PPT Doctor 返回的结果文件不完整，请重试');
  }
}
function matchEnvelope(result, requestId, action) {
  if (!result || result.apiVersion !== API_VERSION) throw failure('DOCTOR_UPGRADE_REQUIRED', 'Hub 与 PPT Doctor 联动协议不兼容，请更新后重试', { downloadUrl: DOWNLOAD_URL });
  if (result.requestId !== requestId || result.action !== action) throw failure('DOCTOR_WRONG_RESPONSE', 'PPT Doctor 返回的结果不属于本次请求，请重试');
}
function validateResult(result, requestId, action, exitCode) {
  matchEnvelope(result, requestId, action);
  if (result.ok === false || (exitCode !== undefined && exitCode !== 0)) {
    throw failure(result.code || result.error?.code || 'DOCTOR_FAILED', typeof result.error === 'string' ? result.error : result.error?.message || `PPT Doctor 操作失败${exitCode === undefined ? '' : `（退出码 ${exitCode}）`}`, {
      ...(exitCode !== undefined ? { exitCode } : {}), retryable: result.retryable === true, resultMayBePartial: result.resultMayBePartial === true,
    });
  }
  if (result.ok !== true) throw failure('DOCTOR_INVALID_RESPONSE', 'PPT Doctor 没有明确确认操作成功，请重试');
  return result;
}
module.exports = { API_VERSION, DOWNLOAD_URL, GITHUB_DOWNLOAD_URL, READ_ONLY, failure, readJson, matchEnvelope, validateResult };
