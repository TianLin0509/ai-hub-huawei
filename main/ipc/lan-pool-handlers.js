'use strict';
function registerLanPoolIpc(ipcMain, { service, readConfig, saveConfig, clearConfig, changed, proxyService }) {
  const pool = require('../../core/lan-pool');
  const api = require('../../core/company-api-config');
  const handle = (name, fn) => ipcMain.handle('lan-pool:' + name, async (_event, payload = {}) => {
    try { return await fn(payload); } catch (error) { return { ok: false, error: error.message }; }
  });
  handle('settings', () => service.settings());
  handle('snapshot', async payload => await service.snapshot({ force: payload.refresh === true }) || { ok: true, shared: false });
  handle('host', payload => service.configureHost(payload));
  handle('add-member', payload => service.add(payload));
  handle('revoke-member', payload => service.revoke(payload.id));
  handle('connect', async payload => {
    const before = pool.read(service.dataDir), raw = readConfig();
    let next = raw;
    for (const kind of api.KINDS) next = api.withSettings(next, { kind, backend: 'proxy', model: require('../../core/company-model-proxy').launchModel(api.connection(raw, kind).model) });
    // Validate connectivity before changing any CLI route; the restore point is saved in the same write as the connection.
    await service.connect(payload, { previous: { claude: raw.providers?.claude || null, codex: raw.providers?.codex || null, dsh: raw.acp?.companyApi || null } });
    try {
      saveConfig(next); clearConfig(); changed(); void proxyService.syncWithConfig();
      return service.settings();
    } catch (error) { pool.write(service.dataDir, before); throw error; }
  });
  handle('refresh', async () => { await service.snapshot({ force: true }); return service.settings(); });
  handle('disconnect', async () => {
    const current = pool.read(service.dataDir), previous = current.client?.previous;
    const raw = readConfig(); const next = { ...raw, providers: { ...raw.providers }, acp: { ...raw.acp } };
    if (previous) {
      for (const kind of ['claude', 'codex']) if (next.providers[kind]?.backend === 'proxy') {
        if (previous[kind]) next.providers[kind] = previous[kind]; else delete next.providers[kind];
      }
      if (next.acp.companyApi?.backend === 'proxy') {
        if (previous.dsh) next.acp.companyApi = previous.dsh; else delete next.acp.companyApi;
      }
    }
    saveConfig(next); await service.disconnect(); clearConfig(); changed(); void proxyService.syncWithConfig();
    return service.settings();
  });
}
module.exports = { registerLanPoolIpc };
