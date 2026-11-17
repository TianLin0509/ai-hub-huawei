'use strict';
// An entry point only for the isolated shutdown E2E. No production IPC is added.
const { app, ipcMain } = require('electron');
const { CompanyProxyService } = require('../../main/company-proxy-service');
let proxyStops = 0;
const stop = CompanyProxyService.prototype.stop;
CompanyProxyService.prototype.stop = function (...args) { proxyStops++; return stop.apply(this, args); };
const petModule = require('../../main/hub-pet-controller');
const createPet = petModule.createHubPetController;
let pet;
petModule.createHubPetController = function (...args) { pet = createPet(...args); return pet; };
ipcMain.on('test:shutdown-retry:quit', () => app.quit());
ipcMain.handle('test:shutdown-retry:state', () => ({ proxyStops, petActive: pet?.isActive() || false, petWindowId: pet?.getWindow()?.id || null }));
require('../../main-bootstrap');
