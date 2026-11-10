'use strict';

// Message identities are not session/file identities. Keep this module pure so
// the renderer and Main use exactly the same acceptance rule.
const MAX_RECORD_ID_LENGTH = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isNativeSessionId(value) {
  return typeof value === 'string' && value.length === 36 && UUID.test(value);
}

function isNativeRecordId(value) {
  return typeof value === 'string' && value.length <= MAX_RECORD_ID_LENGTH
    && !/[^A-Za-z0-9_-]/.test(value)
    && (isNativeSessionId(value) || value.startsWith('msg_') && value.length > 4);
}

module.exports = { isNativeRecordId, isNativeSessionId, MAX_RECORD_ID_LENGTH };
