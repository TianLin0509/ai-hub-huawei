'use strict';
// 在公司门户首页里执行的只读查询（2026-11-12 公司真机摸清，全部是首页自己会发的同源查询，带页面的登录态）：
//   账号信息 → 待办按系统计数 → 每个系统的待办明细 → 我的申请计数与明细 → 任务数 → 公司文件各栏目。
// 只查不改：不点审批、不提交表单。返回原始形状，由 model.js 整理。
// 注意：这段代码在浏览器页面里跑，写成字符串；不引用外面的变量，只用 LIST_MAX 一个数字。
function collectScript({ listMax = 30 } = {}) {
  const n = Math.max(1, Math.min(100, Number(listMax) || 30));
  return `(async () => {
  const H = { 'X-Requested-With': 'XMLHttpRequest' };
  const R = { calls: {} };
  const get = async (key, url) => {
    const s = performance.now();
    try {
      const r = await fetch(url, { headers: H, credentials: 'include' });
      const txt = await r.text();
      R.calls[key] = { status: r.status, ms: Math.round(performance.now() - s) };
      try { return JSON.parse(txt); } catch (e) { return null; }
    } catch (e) { R.calls[key] = { status: 0, error: String(e).slice(0, 80) }; return null; }
  };
  const ts = () => Date.now();
  const enc = (s) => encodeURIComponent(encodeURIComponent(s));
  const acc = await get('account', '/next/service/rest/my/w3account/v1/account/zh?profile=1&version=1&usergroup=1');
  if (!acc || !acc.uid) { R.login = false; return R; }
  R.login = true;
  const p = acc.profile || {};
  R.me = { uid: acc.uid, email: acc.email || '', name: p.lname || '', nameEn: p.userName || '', employeeNumber: acc.employeeNumber || '', deptCode: p.departmentCode || '', area: p.areaCode || '', isManager: p.isManager ? 1 : 0 };
  const [todo, apply, task, docs] = await Promise.all([
    get('todoCount', '/service/rest/task/getappinfocount?lan=cn&type=2&timestamp=' + ts()),
    get('applyApps', '/service/rest/task/appinfo?lan=cn&type=2&timestamp=' + ts()),
    get('taskCount', '/next/proxyw3/p/plinkunitask/w3/tasks/find/count'),
    get('docs', '/service/rest/info/common/docs?lan=cn&version=1&user=' + encodeURIComponent(acc.uid)),
  ]);
  const lists = async (kind, apps) => {
    const out = [];
    for (const a of apps) {
      const d = await get(kind + ':' + a.appName, '/service/rest/task/' + (kind === 'todo' ? 'tasklists' : 'applists') + '/' + enc(a.appName) + '?type=2&curpage=1&num=' + Math.min(100, Math.max(${n}, Number(a.appNum) || 0)) + '&lan=cn&timestamp=' + ts());
      out.push({ app: a.appName, count: Number(a.appNum) || 0, listed: d ? Number(d.count) || 0 : null, items: (d && Array.isArray(d.data) ? d.data : []) });
    }
    return out;
  };
  R.serverTime = (todo && todo.serverTime) || '';
  R.todo = todo ? { count: Number(todo.todoCount) || 0, apps: await lists('todo', Array.isArray(todo.todoData) ? todo.todoData : []) } : null;
  R.apply = Array.isArray(apply) ? { apps: await lists('apply', apply) } : null;
  R.task = task && task.data ? { count: Number(task.data.count) || 0 } : null;
  R.docs = docs && typeof docs === 'object' ? docs : null;
  return R;
})()`;
}

module.exports = { collectScript };
