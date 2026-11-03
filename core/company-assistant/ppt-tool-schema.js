'use strict';
const string = { type: 'string', minLength: 1 };
const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const array = (items, maxItems) => ({ type: 'array', items, maxItems });
const evidence = object({ id: string, quote: { type: 'string', minLength: 4 } }, ['id', 'quote']);
const condition = object({ id: string, text: string, required: { type: 'boolean' } }, ['id', 'text', 'required']);
const assessment = object({ condition_id: string, status: { enum: ['满足', '冲突', '未证实'] }, reason: string,
  evidence: { ...array(evidence, 10), description: '满足/冲突必须引用已读同文稿连续原文；未证实可为空数组。' } }, ['condition_id', 'status', 'reason', 'evidence']);
const row = object({ id: { ...string, description: '原样复制本轮ppt_read完整id' }, label: string, relevance: { enum: ['直接适用', '相关背景', '待核查', '暂不推荐'] },
  use: string, reason: string, quote: { type: 'string', minLength: 4 }, conditions: string, assessments: array(assessment, 12) }, ['id', 'relevance', 'use', 'reason', 'quote', 'conditions', 'assessments']);
const PPT_DECISION_SCHEMA = object({ title: string, summary: string, task: object({ purpose: string, conditions: array(condition, 12) }, ['purpose', 'conditions']),
  results: array(row, 20), gaps: array(string, 20), search_note: string, answer_status: { enum: ['supported', 'partial', 'insufficient'] } }, ['task', 'results']);
PPT_DECISION_SCHEMA.description = 'report决策。每条推荐必须完整读过；无需复传evidence，Hub使用本轮真实读取记录。schema规定字段，工具生成报告表格。无必需条件时task.conditions与assessments使用空数组。';
const PPT_OPS_SCHEMA = { type: 'object', description: 'flash差异对象，字号由Doctor决定。d:[行号]删除、x:[行号]保留图内字、fix:{行号:正确文字}、bbox:{行号:[x0,y0,x1,y1]}、confirm:[行号]、b:[粗体行号]、attr:{行号:{bold,color,align}}、merge:[[行号,...]]、t:[[x0,y0,x1,y1,文字,bold?,color?]]、c:[[x0,y0,x1,y1,radius?]]、g:[[x0,y0,x1,y1,说明?,alpha?]]、p:{子元素id:父元素id}、font:string。行号1或s1，坐标是原图像素。看不了图用空对象。' };
module.exports = { PPT_DECISION_SCHEMA, PPT_OPS_SCHEMA };
