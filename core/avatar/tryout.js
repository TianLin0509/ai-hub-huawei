'use strict';
// 独立试答：自己的会话、任务目录和历史，不进入正式事项、游标或发送链。
const fs = require('node:fs'), path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const F = require('./fleet-rules'), R = require('./rules');
const { AgentSessions, normalizeFailure } = require('./agent-session');
const DAY = 86400000;
const QUESTION = /[?？]|怎么|如何|哪里|哪个|能不能|可不可以|有没有|是否|报错|失败|打不开|用不了/;
const EXAMPLES = {
  watch: ['明天下午前需要确认会议安排，应该提醒我看哪一项？', '有人在等我确认材料版本，怎样提醒更清楚？', '这条消息只是通知时间变化，需要我回复吗？'],
  draft: ['会议纪要怎么导出成可编辑文档？', '暂时不能确认完成时间，应该怎样回复同事？', '同事问材料放在哪个目录，资料里没有位置时怎么回复？'],
  qa: ['会议纪要怎么导出成可编辑文档？', '历史问答里没有相关依据，应该如何回应？', '同事问如何保留批注，应该先查哪些说明？'],
  blank: ['这份材料应该怎么处理？', '资料没有给出明确结论时，应该如何回复？', '同事询问进展但我还没有确认，应该怎样回应？'],
};
const invalid = (message, code = 'tryout_input') => Object.assign(new Error(message), { tryoutInput: true, code });
const safe = (text, n = 1200) => F.safeText(String(text ?? ''), n);

class Tryouts {
  constructor(fleet) { this.f = fleet; this.samplesByAvatar = new Map(); this.running = new Map(); }
  context(id) {
    const owner = this.f.owner();
    if (!owner || !this.f.login().ok) throw Object.assign(new Error('WeLink 尚未登录，请先扫码登录'), { status: 401, source: 'welink' });
    return { owner, av: this.f.find(owner, id).av, epoch: this.f.accountEpoch, key: owner + '|' + id };
  }
  file(owner, id) { return path.join(this.f.home(owner, id), 'tryout-history.json'); }
  history(owner, id) {
    try { const rows = JSON.parse(fs.readFileSync(this.file(owner, id), 'utf8')); return Array.isArray(rows) ? rows.slice(-30) : []; } catch { return []; }
  }
  save(owner, id, rows) {
    const file = this.file(owner, id); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(rows.slice(-30), null, 1), 'utf8');
  }
  samples(id) {
    const { owner, av, key } = this.context(id), f = this.f, rows = [], seen = new Set();
    let snap = f.snapshot();
    if (snap?.login?.uid && snap.login.uid !== owner) snap = null;
    if (!snap?.conversations?.length && f.targetSnapshot?.login?.uid === owner) snap = f.targetSnapshot;
    let names = {}; try { names = f.assistant()?.archive?.loadIndex?.(owner)?.names || {}; } catch { /* 无人物目录 */ }
    for (const conv of f.conversationsOf(snap, { avatars: [av] })) {
      const messages = [...(snap?.login?.uid && snap.login.uid !== owner ? [] : snap?.messages?.[conv.id] || []), ...f.messages(conv.id)];
      try {
        for (const r of f.assistant()?.archive?.read?.(owner, conv.id, { since: f.now() - 14 * DAY }) || []) messages.push({ key: r.id, at: r.at, account: r.a, sender: names[r.a], text: r.t, mine: !!r.m, contentType: r.ct, atMe: r.at2?.includes(owner) });
      } catch { /* 无归档仍可使用近期快照 */ }
      for (const m of messages) {
        const question = String(m.text || '').trim(), fingerprint = conv.id + '|' + (m.key || m.at + '|' + question);
        if (seen.has(fingerprint) || m.mine || m.at < f.now() - 14 * DAY || !question || question.length < 6 || !QUESTION.test(question)
          || F.noise(question) || F.isOwnOutput(question) || R.sensitiveHit(question) || m.contentType && !/TEXT/i.test(m.contentType)) continue;
        if (!F.matchAvatar({ ...av, enabled: true }, { ...m, conv: conv.id, group: !!conv.group })) continue;
        seen.add(fingerprint);
        rows.push({ id: 's-' + createHash('sha256').update(owner + '|' + av.id + '|' + fingerprint).digest('hex').slice(0, 20),
          kind: conv.group ? 'group' : 'dm', convId: conv.id, convName: conv.name || '会话', sender: m.sender || (conv.group ? '群成员' : conv.name || '联系人'),
          at: m.at || 0, question: safe(question), requiresConsent: !conv.group, _account: m.account || conv.id, _atMe: !!m.atMe });
      }
    }
    const picked = rows.sort((a, b) => Number(b.kind === 'group') - Number(a.kind === 'group') || b.at - a.at).slice(0, 6);
    for (const [i, question] of (EXAMPLES[av.tpl] || EXAMPLES.blank).entries()) {
      if (picked.length >= 3) break;
      picked.push({ id: 'example-' + av.tpl + '-' + i, kind: 'example', convId: '', convName: '示例题（非真实消息）', sender: '示例', at: 0, question, requiresConsent: false });
    }
    this.samplesByAvatar.set(key, picked);
    return { ok: true, samples: picked.map(({ _account, _atMe, ...row }) => row), history: this.history(owner, av.id) };
  }
  failure(error) {
    const failure = normalizeFailure(error, { source: error.source || 'model', now: this.f.now() });
    if (error.tryoutInput) Object.assign(failure, { code: error.code, headline: error.message, retryable: false, actions: [] });
    return { ok: false, error: failure.headline, failure };
  }
  async run(id, opts = {}) {
    let ctx, session, sessionId, runner, dir, token;
    try {
      ctx = this.context(id); const { owner, av, epoch, key } = ctx, f = this.f;
      if (this.running.has(key)) throw invalid('这道试答还在处理中，请等它完成', 'tryout_busy');
      if (!this.samplesByAvatar.has(key)) this.samples(id);
      const samples = this.samplesByAvatar.get(key), selected = opts.sampleId ? samples.find(s => s.id === opts.sampleId) : null;
      if (opts.sampleId && !selected) throw invalid('这道试题已不可用，请重新选题');
      if (selected && selected.kind !== 'example' && !F.matchAvatar({ ...av, enabled: true }, { conv: selected.convId, group: selected.kind === 'group', account: selected._account, atMe: selected._atMe })) throw invalid('分身范围已变化，请重新选题');
      const question = String(opts.question ?? selected?.question ?? '').trim();
      if (!question || question.length > 1200) throw invalid('请填写一道不超过 1200 字的试题');
      const knownPrivate = samples.some(s => s.kind === 'dm' && s.question === question);
      if ((opts.kind === 'dm' || selected?.kind === 'dm' || knownPrivate) && opts.explicitPrivateConsent !== true) throw invalid('这是私聊消息，请先明确勾选允许本次试答使用，再开始', 'private_consent_required');
      if (R.sensitiveHit(question)) throw invalid('这道试题涉及敏感内容，请换一道题');
      const agent = f.preflight(owner, f.backends()).agent;
      if (!agent.ok) throw new Error(agent.label || '模型账号未就绪，请先选择可用账号');
      token = randomUUID(); this.running.set(key, token);
      const current = () => f.current(owner, epoch);
      const check = () => { if (!current()) throw invalid('账号已切换，这次试答结果已丢弃', 'avatar_stale_owner'); if (!f.exists(owner, av.id)) throw invalid('分身已删除，这次试答已停止'); };
      check();
      const item = { id: 'tryout-' + token, conv: selected?.convId || '', convName: selected?.convName || String(opts.convName || '自填试题'),
        group: selected ? selected.kind !== 'dm' : opts.kind !== 'dm', account: selected?._account || 'tryout-question', who: selected?.sender || '试题',
        text: question, at: selected?.at || f.now(), atMe: !!selected?._atMe, action: av.tpl === 'watch' ? 'remind' : av.action || 'draft' };
      const hit = selected && F.matchAvatar({ ...av, enabled: true }, { ...item }); if (hit) item.action = hit.action;
      Object.assign(item, F.gate(item, f.legacy.roster(owner)));
      dir = path.join(f.work(owner, av.id), 'tryout-' + token); fs.mkdirSync(dir);
      const material = f.material(owner, av, [item]); material.tryout = true; material.notice = '[试答，不发送]，不得读取任务外聊天或发送任何消息';
      if (!selected || selected.kind === 'example') material.items[0].where = selected ? '示例题（非真实消息）' : '用户自填试题';
      const related = material.items[0].related || [];
      fs.writeFileSync(path.join(dir, 'rules.md'), F.rulesMarkdown(av, { sources: av.sources, memoryLines: related.length }) + '\n\n[试答，不发送]：本题只输出判断和草稿；题目没有给出的事实不得编造。资料片段已在任务 related 中。', 'utf8');
      // 使用同一筛选后的依据，避免隔离目录里的 memory/examples 指向正式工作目录。
      fs.writeFileSync(path.join(dir, 'memory.md'), related.join('\n'), 'utf8');
      fs.writeFileSync(path.join(dir, 'examples.md'), related.join('\n'), 'utf8');
      const file = 'task-' + token + '.json'; fs.writeFileSync(path.join(dir, file), JSON.stringify(material, null, 1), 'utf8');
      const deps = f.sessions.d;
      runner = new AgentSessions({ ...deps, createSession: (kind, options) => { sessionId = options.id; return deps.createSession(kind, options); } });
      session = await runner.ensure({ ...av, id: av.id + ':tryout:' + token, name: av.name + ' [试答，不发送]' }, null, dir);
      check();
      const started = f.now(), raw = await runner.ask(session, file, { isCurrent: current }); check();
      if ((f.find(owner, av.id).av.rulesVersion || 0) !== (av.rulesVersion || 0)) throw invalid('纠错口径已更新，请用新口径再试答一次');
      const result = F.parseResults(raw).get(item.id);
      if (!result || !['draft', 'remind', 'skip'].includes(result.action)) throw new Error('模型没有返回有效试答，请重试或检查模型');
      const basis = (Array.isArray(result.basis) ? result.basis : [result.basis]).filter(v => typeof v === 'string' && v.trim() && !R.sensitiveHit(v)).map(v => safe(v, 300));
      const applied = F.applyResult(item, { ...result, basis: basis.join('；') }, av);
      if (applied.confidence <= 0 && !basis.length) Object.assign(applied, { state: 'remind', draft: '', lowConfidenceFallback: true, why: '依据不足，转你处理' });
      if (R.sensitiveHit(applied.draft)) Object.assign(applied, { state: 'remind', draft: '', why: '试答涉及敏感内容，请本人处理' });
      const meta = f.d.getSession?.(session.id) || {}, model = meta.currentModel?.id || meta.featureAgentChoice?.model || meta.fixedModel || av.backend?.model;
      const modelLabel = model ? `${require('../assistant-gateway-route').isGatewaySession(meta) ? '部门 API key（网关）' : meta.apiGatewayRoute ? 'Claude Code' : meta.kind === 'codeagent-lite' ? 'CodeAgent-Lite' : 'CodeAgent'} · ${model}` : agent.label;
      const entry = { id: 'tr-' + token, at: f.now(), question: safe(question), answer: safe(applied.draft || '', 800),
        action: applied.state === 'ready' ? 'draft' : applied.state === 'skipped' ? 'skip' : 'remind', confidence: applied.confidence, basis,
        why: safe(applied.why || '', 300), durationMs: Math.max(0, f.now() - started), modelLabel,
        lowConfidenceFallback: !!applied.lowConfidenceFallback, verdict: '', note: '' };
      check(); this.save(owner, av.id, [...this.history(owner, av.id), entry]);
      return { ok: true, result: entry };
    } catch (error) { return this.failure(error); }
    finally {
      const closed = sessionId ? await runner.close(sessionId) : true;
      if (closed && dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 任务目录占用时保留 */ }
      if (ctx && this.running.get(ctx.key) === token) this.running.delete(ctx.key);
    }
  }
  rate(id, { tryoutId, verdict, note = '' } = {}) {
    const { owner, av } = this.context(id);
    if (!['like', 'unlike', 'issue'].includes(verdict)) throw invalid('请选择像、不像或有问题');
    const rows = this.history(owner, id), entry = rows.find(row => row.id === tryoutId);
    if (!entry) throw invalid('这条试答已不在最近历史里，请重新试答');
    entry.verdict = verdict; entry.note = safe(String(note).trim(), 600);
    this.save(owner, av.id, rows);
    const file = path.join(this.f.work(owner, av.id), 'examples.md'), tag = '[试答:' + entry.id + ']';
    let lines = []; try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); } catch { /* 没有范例 */ }
    lines = lines.filter(line => !line.startsWith('- ' + tag + ' '));
    if (!R.sensitiveHit(entry.question) && !R.sensitiveHit(entry.answer) && !R.sensitiveHit(note)
      && (verdict === 'like' && entry.answer || String(note).trim().length >= 4)) {
      const one = value => safe(R.clean(value), 800).replace(/[\r\n]+/g, ' ');
      lines.push(`- ${tag} 收到：${one(entry.question)} ｜ ${verdict === 'like' ? '认可草稿：' + one(entry.answer) : '原草稿仅供对照：' + one(entry.answer)}${entry.note ? ' ｜ 本人纠正：' + one(entry.note) : ''}`);
    }
    fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
    return { ok: true, entry, examples: lines.length };
  }
}
module.exports = { Tryouts };
