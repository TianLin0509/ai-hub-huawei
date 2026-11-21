'use strict';
// Reproduce production's port=0 automation flag without exposing a test window.
const { app, WebContentsView, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const dataDir = process.env.CLAUDE_HUB_DATA_DIR;
app.setPath('userData', path.join(dataDir, 'electron-userdata'));
app.commandLine.appendSwitch('remote-debugging-port', '0');
const timeout = setTimeout(() => app.exit(2), 45000);
app.whenReady().then(async () => {
  let web, baseline;
  try {
    baseline = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await baseline.webContents.loadURL(process.env.HUB_WEB_SESSIONS_FIXTURE_URL);
    const before = await baseline.webContents.executeJavaScript('navigator.webdriver');
    web = require('../../main/web-sessions').createWebSessions({ dataDir, getWindow: () => null,
      WebContentsView, session, app, shell: { openExternal: async () => {} } });
    const item = web.create({ site: 'deepseek' });
    const { wc } = await web.pageFor(item.id);
    const after = await wc.executeJavaScript('navigator.webdriver');
    fs.writeFileSync(path.join(dataDir, 'automation-probe.json'), JSON.stringify({ before, after, chrome: process.versions.chrome }));
    web.dispose(); baseline.webContents.close(); clearTimeout(timeout); app.exit(0);
  } catch (error) { console.error(error.stack); web?.dispose(); baseline?.webContents.close(); clearTimeout(timeout); app.exit(1); }
});
