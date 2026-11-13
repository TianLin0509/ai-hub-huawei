'use strict';

// Union of the existing CLI identifier characters and longest supported ID
// (160 characters plus Claude's [1m] suffix). IDs are one argument: prose,
// whitespace, controls, quotes and shell expansion characters are rejected.
const MAX_MODEL_ID_LENGTH = 164;
const MODEL_ID_SOURCE = `[A-Za-z0-9][A-Za-z0-9._:/@+\\[\\]()-]{0,${MAX_MODEL_ID_LENGTH - 1}}`;
const MODEL_ID_RE = new RegExp(`^(?:${MODEL_ID_SOURCE})$`);

function isSafeModelId(value) {
  return typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value)
    && MODEL_ID_RE.test(value.trim());
}

module.exports = { isSafeModelId, MODEL_ID_SOURCE, MAX_MODEL_ID_LENGTH };
