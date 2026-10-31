'use strict';
// 群场景仅追加读文件提示；不调用单会话的 clean launch 或切换工具。
const path = require('node:path');
const Scenes = require('./session-scenes');

function sceneHintFields(value) {
  return typeof value === 'string' && (value === '' || (value !== 'coding' && /^[a-z][a-z0-9-]{1,31}$/.test(value)))
    ? { sceneHint: value } : {};
}

function sceneHintInstruction(value, opts = {}) {
  const id = sceneHintFields(value).sceneHint;
  if (!id) return '';
  const scene = Scenes.listScenes(opts).find(s => s.id === id && s.file);
  if (!scene) return '';
  let text = `本群场景：${scene.label}，开始前先读场景文件 ${path.resolve(scene.file)}`;
  const root = Scenes.knowledgeRoot(opts.env, opts.dataDir);
  if (root && /^[a-z0-9][a-z0-9_-]*$/i.test(scene.knowledge || '')) {
    text += `；再读知识库索引 ${path.join(root, scene.knowledge, 'INDEX.md')}`;
  }
  return text + '。';
}

module.exports = { sceneHintFields, sceneHintInstruction };
