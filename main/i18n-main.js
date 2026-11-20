'use strict';
// 主进程的界面语言（2026-11-20）：读写 config.json 的 ui.language（缺省即中文），
// 给界面进程同步取语言，切换时通知所有窗口；并把系统对话框、菜单、托盘提示、系统通知里的中文按词典翻译，
// 这样各处调用点不用逐个改。中文模式下这些包装直接放行原参数。

const i18n = require('../core/i18n');

function readSavedLanguage(hubConfig) {
  try { return i18n.normalizeLanguage(hubConfig.readConfigJsonForUpdate().ui?.language); } catch { return i18n.DEFAULT_LANGUAGE; }
}

function saveLanguage(hubConfig, language) {
  const config = hubConfig.readConfigJsonForUpdate();
  config.ui = { ...(config.ui || {}), language };
  hubConfig.saveConfig(config);
}

function tr(value) { return typeof value === 'string' ? i18n.translate(value) : value; }

function translateOptions(options) {
  if (!options || typeof options !== 'object' || !i18n.isEnglish()) return options;
  const out = { ...options };
  for (const key of ['title', 'message', 'detail', 'checkboxLabel', 'buttonLabel', 'nameFieldLabel']) {
    if (typeof out[key] === 'string') out[key] = tr(out[key]);
  }
  if (Array.isArray(out.buttons)) out.buttons = out.buttons.map(tr);
  if (Array.isArray(out.filters)) out.filters = out.filters.map(f => (f && typeof f.name === 'string' ? { ...f, name: tr(f.name) } : f));
  return out;
}

function translateMenuTemplate(items) {
  if (!Array.isArray(items) || !i18n.isEnglish()) return items;
  return items.map(item => {
    if (!item || typeof item !== 'object') return item;
    const out = { ...item };
    for (const key of ['label', 'sublabel', 'toolTip']) if (typeof out[key] === 'string') out[key] = tr(out[key]);
    if (Array.isArray(out.submenu)) out.submenu = translateMenuTemplate(out.submenu);
    return out;
  });
}

// 对话框的参数位置：showMessageBox([win], options)；showErrorBox(title, content)。
function patchElectron(electron) {
  const { dialog, Menu, Tray, Notification } = electron;
  if (dialog && !dialog.__i18n) {
    for (const name of ['showMessageBox', 'showMessageBoxSync', 'showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync']) {
      const original = dialog[name];
      if (typeof original !== 'function') continue;
      dialog[name] = function (...args) {
        const BW = electron.BrowserWindow;
        const idx = args.length > 1 && (args[0] == null || (typeof BW === 'function' && args[0] instanceof BW)) ? 1 : 0;
        args[idx] = translateOptions(args[idx]);
        return original.apply(this, args);
      };
    }
    const errorBox = dialog.showErrorBox;
    if (typeof errorBox === 'function') dialog.showErrorBox = function (title, content) { return errorBox.call(this, tr(title), tr(content)); };
    dialog.__i18n = true;
  }
  if (Menu && !Menu.__i18n) {
    const build = Menu.buildFromTemplate;
    Menu.buildFromTemplate = function (template) { return build.call(this, translateMenuTemplate(template)); };
    Menu.__i18n = true;
  }
  if (Tray && Tray.prototype && !Tray.prototype.__i18n) {
    const setToolTip = Tray.prototype.setToolTip;
    Tray.prototype.setToolTip = function (text) { return setToolTip.call(this, tr(text)); };
    Tray.prototype.__i18n = true;
  }
  if (Notification && Notification.prototype && !Notification.prototype.__i18n) {
    const show = Notification.prototype.show;
    Notification.prototype.show = function (...args) {
      if (i18n.isEnglish()) {
        try { if (typeof this.title === 'string') this.title = tr(this.title); if (typeof this.body === 'string') this.body = tr(this.body); } catch (_) {}
      }
      return show.apply(this, args);
    };
    Notification.prototype.__i18n = true;
  }
}

// main.js 在建窗口之前调用一次。
function installMainI18n({ electron, ipcMain, hubConfig, getWindows, onChange }) {
  i18n.setLanguage(readSavedLanguage(hubConfig));
  patchElectron(electron);
  ipcMain.on('i18n:get-language', event => { event.returnValue = i18n.getLanguage(); });
  ipcMain.handle('i18n:set-language', (_event, value) => {
    const language = i18n.normalizeLanguage(value);
    saveLanguage(hubConfig, language);
    i18n.setLanguage(language);
    for (const win of getWindows()) {
      try { if (win && !win.isDestroyed()) win.webContents.send('i18n:language-changed', language); } catch (_) {}
    }
    try { onChange && onChange(language); } catch (error) { console.warn('[i18n] 切换后刷新失败', error && error.message); }
    return { ok: true, language };
  });
  return i18n;
}

module.exports = { installMainI18n, patchElectron, translateOptions, translateMenuTemplate, readSavedLanguage, saveLanguage };
