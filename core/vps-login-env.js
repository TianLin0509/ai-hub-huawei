'use strict';
// Shared builds have no remote sign-in environment. This stand-in keeps the
// account page and the Claude launch path working: the feature reports itself
// unavailable everywhere, so no remote host, key or helper program is needed.
const path = require('path');

class UserError extends Error {}
const unavailable = () => { throw new UserError('此版本不包含远程登录环境'); };

class VpsLoginEnv {
  constructor() {}
  available() { return false; }
  status() { return Promise.reject(new UserError('此版本不包含远程登录环境')); }
  launcherNames() { return {}; }
  writeNames() {}
  create() { return Promise.reject(new UserError('此版本不包含远程登录环境')); }
  open() { return Promise.reject(new UserError('此版本不包含远程登录环境')); }
  stop() { return Promise.resolve({}); }
}

const ENV_ID = /^(?:[abcd]|u[0-9a-f]{8})$/;
const LEGACY = {};
const BUILT_IN_BINDING = {};

module.exports = {
  VpsLoginEnv, UserError, ENV_ID, LEGACY, BUILT_IN_BINDING,
  settings: () => ({}),
  available: () => false,
  loginBrowserPath: dataDir => path.join(dataDir, 'vps-login', 'unavailable.exe'),
  ensureLoginBrowser: unavailable,
  sshRemote: unavailable,
  viewerReady: () => false,
  authUrl: () => '',
  bindingFor: () => '',
  runIpFor: () => '',
  describe: () => ({ envs: [] }),
  routeTemplates: () => [],
};
