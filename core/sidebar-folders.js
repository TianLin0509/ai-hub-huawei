'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { acquireLockAsync, releaseLockAsync } = require('./file-lock');
const { writeFileAtomic } = require('./atomic-write');

const ENTITY_KEY = /^(?:session|meeting):[\w-]{1,128}$/;
const FOLDER_ID = /^folder-[\w-]{1,80}$/;
const emptyState = () => ({ version: 1, folders: [], assignments: {} });

function cleanName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 40 || /[\r\n\x00-\x1f]/.test(name)) throw new Error('目录名称须为 1–40 个字符，不能换行');
  const result = name.trim();
  if (result === '未分类') throw new Error('“未分类”是内建目录，请换一个名称');
  return result;
}

function validateState(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.folders) || !state.assignments || typeof state.assignments !== 'object' || Array.isArray(state.assignments)) throw new Error('目录数据格式或版本无效；请保留原文件并检查');
  const ids = new Set(), names = new Set();
  for (const folder of state.folders) {
    if (!folder || typeof folder.id !== 'string' || !FOLDER_ID.test(folder.id) || ids.has(folder.id) || cleanName(folder.name) !== folder.name || names.has(folder.name)) throw new Error('目录数据包含无效或重复目录');
    ids.add(folder.id); names.add(folder.name);
  }
  for (const [key, id] of Object.entries(state.assignments)) if (!ENTITY_KEY.test(key) || !ids.has(id)) throw new Error('目录数据包含无效归属；请保留原文件并检查');
  return state;
}

function createSidebarFolderStore({ dataDir = require('./data-dir').getHubDataDir(), fsModule = fs } = {}) {
  const file = path.join(dataDir, 'sidebar-folders.json'), lock = file + '.lock';
  function read() {
    let text;
    try { text = fsModule.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return emptyState(); throw new Error(`目录数据无法读取：${error.message}`); }
    try { return validateState(JSON.parse(text)); }
    catch (error) { throw new Error(`目录数据无法读取，原文件已保留：${error.message}`); }
  }
  async function mutate(change) {
    fsModule.mkdirSync(dataDir, { recursive: true });
    const handle = await acquireLockAsync(lock);
    if (!handle) throw new Error('目录正在由其他窗口保存或存储不可写，请稍后重试');
    try {
      const state = read();
      change(state);
      validateState(state);
      writeFileAtomic(fsModule, file, JSON.stringify(state));
      return state;
    } finally { await releaseLockAsync(handle, lock); }
  }
  function folder(state, id) {
    const found = state.folders.find(item => item.id === id);
    if (!found) throw new Error('目录不存在；“未分类”不能改名或删除');
    return found;
  }
  function uniqueName(state, name, except = null) {
    const clean = cleanName(name);
    if (state.folders.some(item => item.id !== except && item.name === clean)) throw new Error('已有同名目录，请换一个名称');
    return clean;
  }
  return {
    list: async () => read(),
    create: name => mutate(state => { state.folders.push({ id: 'folder-' + randomUUID(), name: uniqueName(state, name), createdAt: Date.now() }); }),
    rename: (id, name) => mutate(state => { folder(state, id).name = uniqueName(state, name, id); }),
    remove: id => mutate(state => {
      folder(state, id);
      state.folders = state.folders.filter(item => item.id !== id);
      for (const key of Object.keys(state.assignments)) if (state.assignments[key] === id) delete state.assignments[key];
    }),
    assign: (key, id) => mutate(state => {
      if (typeof key !== 'string' || !ENTITY_KEY.test(key)) throw new Error('会话或群聊标识无效');
      if (id === null) delete state.assignments[key];
      else { folder(state, id); state.assignments[key] = id; }
    }),
  };
}

module.exports = { createSidebarFolderStore, emptyState };
