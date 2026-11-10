'use strict';
// Shared by legacy metadata migration and the sidebar task group.
const BACKGROUND_PURPOSES = new Set(['company-assistant', 'company-ai', 'company-forum']);
const isBackgroundPurpose = purpose => BACKGROUND_PURPOSES.has(purpose);
module.exports = { isBackgroundPurpose };
