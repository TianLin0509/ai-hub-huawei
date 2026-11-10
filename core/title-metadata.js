'use strict';

const TITLE_FIELDS = ['title', 'titleRevision', 'userRenamed', 'autoTitlePending', 'autoTitleGenerated', 'branchAutoTitlePending'];
function titleMetadata(record) {
  return Object.fromEntries(TITLE_FIELDS.filter(key => Object.hasOwn(record || {}, key)).map(key => [key, record[key]]));
}
function titleRevision(record) { return Number(record?.titleRevision) || 0; }
function preserveTitleMetadata(record, previous) {
  return titleRevision(previous) > titleRevision(record) ? { ...record, ...titleMetadata(previous) } : record;
}
function validateUserTitle(value, maxLength = 120) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength || /[\r\n\x00-\x1f]/.test(value)) throw new Error(`名称须为 1–${maxLength} 个字符，不能换行`);
  return value.trim();
}
module.exports = { TITLE_FIELDS, titleMetadata, titleRevision, preserveTitleMetadata, validateUserTitle };
