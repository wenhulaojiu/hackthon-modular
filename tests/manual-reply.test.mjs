import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createReplyEngine, DEFAULT_REPLY_SETTINGS } from '../scripts/local-wechat/reply-engine.mjs';
import { createReplyAdapter } from '../scripts/local-wechat/reply-adapter.mjs';
import { createLocalReplyService } from '../scripts/local-wechat/reply-service.mjs';

const time = Date.parse('2026-11-07T03:00:00.000Z');
const configuration = () => ({ settings: { ...structuredClone(DEFAULT_REPLY_SETTINGS), enabled: false, mode: 'review', selectedCustomerIds: [], autoEnrollNewContacts: false }, customers: [{ id: 'c1', wechatId: 'wxid_synthetic_manual', name: '合成客户', source: 'wechat', autoReplyEnabled: false, humanTakeover: false }], products: [], storeName: '合成门店', industry: '零售' });
const incoming = () => ({ id: randomUUID(), chatId: 'wxid_synthetic_manual', sender: 'customer', text: '请人工为我说明。', date: new Date(time).toISOString(), source: 'realtime', kind: 'text' });
async function temporary(t) {
  const parent = await realpath(os.tmpdir()); const directory = await mkdtemp(path.join(parent, 'kexu-manual-reply-'));
  t.after(async () => { const actual = await realpath(directory); assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase()); assert.ok(path.basename(actual).startsWith('kexu-manual-reply-')); await rm(actual, { recursive: true, force: true }); });
  return directory;
}
async function until(read, predicate) { for (let index = 0; index < 400; index++) { const state = await read(); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('合成手动回复未达到预期状态'); }
async function engineFixture(t, options = {}) {
  const directory = await temporary(t); const engines = [];
  const create = async () => { const value = await createReplyEngine({ directory, now: () => time, tickMs: 5, ...options }); engines.push(value); return value; };
  const engine = await create(); await engine.syncConfig(configuration()); const source = await engine.ingest(incoming());
  t.after(async () => { for (const value of engines) await value.close(); });
  return { engine, create, sourceId: source.jobId, request: extra => ({ jobId: source.jobId, requestId: randomUUID(), text: '这是人工填写的说明，报价999元。', ...extra }) };
}

test('自动关闭且暂停时仍可发送单次手动消息，不调用AI、grounding或自动启动', async t => {
  const sent = []; const f = await engineFixture(t, { generate: async () => { assert.fail('人工回复不得调用AI'); }, send: async () => { assert.fail('人工回复不得使用自动授权'); }, sendManual: async input => { sent.push(input); return { status: 'sent', messageId: '10001' }; } });
  const request = f.request({ text: '  人工确认报价999元。  ' });
  const prepared = await f.engine.prepareManual(request); assert.equal(prepared.job.status, 'draft'); assert.equal(prepared.job.reply, request.text.trim());
  assert.equal(sent.length, 0); assert.equal((await f.engine.status()).running, false);
  await assert.rejects(f.engine.approve(prepared.job.id), /手动回复/);
  await f.engine.dispatchManual(prepared.job.id);
  await until(() => f.engine.getJob(prepared.job.id), job => job.status === 'sent');
  assert.deepEqual(sent, [{ chatId: 'wxid_synthetic_manual', text: request.text.trim(), idempotencyKey: `manual:${request.requestId}` }]);
  const status = await f.engine.status(); assert.equal(status.running, false); assert.deepEqual(status.takeovers, ['c1']);
  const saved = await f.engine.getConfig(); assert.equal(saved.settings.enabled, false); assert.deepEqual(saved.settings.selectedCustomerIds, []); assert.equal(saved.customers[0].humanTakeover, true);
  assert.equal((await f.engine.prepareManual(request)).job.id, prepared.job.id); assert.equal(sent.length, 1);
  await assert.rejects(f.engine.prepareManual({ ...request, text: '不能偷换正文。' }), /不能更换/);
});

test('人工接待取消该客户未发送自动批次，生成中迟到结果不能再发送', async t => {
  const f = await engineFixture(t, { sendManual: async () => ({ status: 'sent', messageId: '10002' }), send: async () => { assert.fail('自动旧稿不得发送'); } });
  const next = configuration(); next.settings.enabled = true; next.settings.mode = 'auto'; next.settings.selectedCustomerIds = ['c1']; next.settings.debounceSeconds = 0; next.customers[0].autoReplyEnabled = true;
  await f.engine.syncConfig(next); await f.engine.start();
  const source = await f.engine.ingest(incoming()); const work = (await f.engine.claimWork()).jobs[0]; assert.ok(work);
  const manual = await f.engine.prepareManual(f.request({ jobId: source.jobId }));
  assert.equal((await f.engine.getJob(source.jobId)).status, 'handoff'); assert.equal((await f.engine.getJob(source.jobId)).resolvedAt, undefined);
  await assert.rejects(f.engine.completeWork({ jobId: work.id, leaseId: work.leaseId, result: { action: 'reply', reply: '旧稿', reason: '合成旧稿' } }), /已失效/);
  await f.engine.dispatchManual(manual.job.id); await until(() => f.engine.getJob(manual.job.id), job => job.status === 'sent');
  assert.equal((await f.engine.status()).running, true); assert.deepEqual((await f.engine.status()).takeovers, ['c1']);
});

for (const outcome of ['sent', 'unknown', 'failed']) test(`手动${outcome}跨重启保持原请求记录，不重复发送或释放人工接管`, async t => {
  let calls = 0; const f = await engineFixture(t, { sendManual: async () => { calls++; return { status: outcome, ...(outcome === 'sent' ? { messageId: '10003' } : {}) }; } });
  const request = f.request(), prepared = await f.engine.prepareManual(request); await f.engine.dispatchManual(prepared.job.id);
  await until(() => f.engine.getJob(prepared.job.id), job => job.status === outcome); await f.engine.close();
  const reopened = await f.create(); const repeated = await reopened.prepareManual(request);
  assert.equal(repeated.job.status, outcome); assert.equal(repeated.job.id, prepared.job.id); await reopened.dispatchManual(repeated.job.id);
  assert.equal(calls, 1); assert.deepEqual((await reopened.status()).takeovers, ['c1']); assert.equal((await reopened.status()).running, false);
});

test('重启前尚未授权派发的手动草稿转unknown，不能被普通审核或再次派发重放', async t => {
  let calls = 0; const f = await engineFixture(t, { sendManual: async () => { calls++; return { status: 'sent', messageId: '10004' }; } });
  const request = f.request(), prepared = await f.engine.prepareManual(request); await f.engine.close();
  const reopened = await f.create(); const duplicate = await reopened.prepareManual(request); assert.equal(duplicate.job.status, 'unknown');
  await reopened.dispatchManual(prepared.job.id); assert.equal(calls, 0);
});

async function serviceFixture(t, options = {}) {
  const root = await temporary(t); const workspace = { id: 'acct-aaaaaaaaaaaaaaaaaaaa', workspaceToken: 'acct-aaaaaaaaaaaaaaaaaaaa@1' }; let current = workspace.workspaceToken;
  const directory = path.join(root, '.local-wechat', 'replies', workspace.id);
  const seed = await createReplyEngine({ directory, now: () => time, ...(options.legacySent ? { sendManual: async () => ({ status: 'sent', messageId: '20001' }) } : {}) }); await seed.syncConfig(configuration()); const source = await seed.ingest(incoming());
  let legacyJobId;
  if (options.legacySent) { const prepared = await seed.prepareManual({ jobId: source.jobId, requestId: randomUUID(), text: '历史人工答复。' }); legacyJobId = prepared.job.id; await seed.dispatchManual(legacyJobId); await until(() => seed.getJob(legacyJobId), job => job.status === 'sent' && job.autoResumeStatus === 'blocked'); }
  await seed.close();
  if (options.legacySent) { const filename = path.join(directory, 'queue.json'), stored = JSON.parse(await readFile(filename, 'utf8')); delete stored.conversationVersions; for (const job of stored.jobs) if (job.kind === 'manual') delete job.autoResumeGuard; await writeFile(filename, JSON.stringify(stored), 'utf8'); }
  const saved = { state: { customers: structuredClone(configuration().customers) }, revision: 7 }; const sent = options.legacySent ? [{ text: '历史人工答复。' }] : [], synced = []; const hooks = {}; let starts = 0, service;
  const adapter = { status: async () => ({ canReceive: true, canSend: false, canManualSend: options.manualCapability !== false }), start: async () => { starts++; }, syncConfig: async config => { synced.push(structuredClone(config)); }, pause: () => {}, fail: () => {}, poll: async () => [], send: async () => { assert.fail('暂停状态不可使用自动发送'); }, sendManual: async input => { sent.push(input); return options.result || { status: 'sent', messageId: '20001' }; } };
  const server = http.createServer((request, response) => { void service.handle(request, response).then(handled => { if (!handled) { response.statusCode = 404; response.end(); } }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  const reader = { readForReplies: async () => { await hooks.read?.(); return [{metadata:{chat_type:'private',chat_username:'wxid_synthetic_manual'},messages:[...sent.map((item,index)=>({server_id:String(20001+index),local_type:'1',sender:'我',sender_username:'wxid_synthetic_self',content:item.text,timestamp:Math.floor(Date.now()/1000)})),...(typeof hooks.extraMessages==='function'?hooks.extraMessages():hooks.extraMessages||[])]}]; } };
  service = await createLocalReplyService({ root, origin, adapter, reader, workspace, currentWorkspace: () => current, pollMs: 60_000, generate: async () => { assert.fail('手动服务不得调用模型'); }, fetch: async (url, input) => { assert.equal(input.headers['X-Kexu-Workspace'], workspace.workspaceToken); if(url === `${origin}/api/reply/manual-resume`){ const body=JSON.parse(input.body); await hooks.resume?.(); if(body.expectedRevision!==saved.revision)return Response.json({error:'资料已变化'},{status:409}); const customer=saved.state.customers.find(c=>c.id===body.customerId);if(!customer||customer.wechatId!==body.wechatId||customer.source==='demo')return Response.json({error:'客户不匹配'},{status:409});if(customer.humanTakeover){customer.humanTakeover=false;saved.revision++;}return Response.json({revision:saved.revision,customerId:customer.id,wechatId:customer.wechatId,humanTakeover:false});} assert.equal(url, `${origin}/api/state`);assert.equal(input.method, undefined); await hooks.state?.(); return Response.json(saved); } });
  t.after(async () => { await service.close(); await new Promise(resolve => server.close(resolve)); });
  const call = async (route, body, headers = {}) => { const r = await fetch(`${origin}/__local-wechat/replies${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Kexu-Local': '1', 'X-Kexu-Workspace': workspace.workspaceToken, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() }; };
  return { call, service, sent, synced, saved, hooks, legacyJobId, starts: () => starts, changeWorkspace: () => { current = 'acct-bbbbbbbbbbbbbbbbbbbb@2'; }, request: extra => ({ jobId: source.jobId, requestId: randomUUID(), text: '人工为您回复：可按999元方案沟通。', ...extra }) };
}

test('manual服务只读持久客户快照、暂停也可发送，并返回可按requestId恢复的独立任务', async t => {
  const f = await serviceFixture(t); const before = structuredClone(f.saved); const request = f.request();
  const accepted = await f.call('/manual', request); assert.equal(accepted.status, 200); const id = accepted.data.job.id;
  const result = await until(async () => (await f.call(`/jobs/${id}`)).data.job, job => job.status === 'sent' && job.autoResumeStatus === 'restored');
  assert.equal(result.kind, 'manual'); assert.equal(result.sourceJobId, request.jobId); assert.equal(result.requestId, request.requestId); assert.equal(result.reply, request.text); assert.equal(f.sent.length, 1);
  assert.equal(f.starts(), 0); assert.equal((await f.service.status()).running, false); assert.deepEqual((await f.service.status()).takeovers, []); assert.deepEqual(f.saved, before);
  const resolved=(await f.call(`/jobs/${request.jobId}`)).data.job;assert.ok(resolved.resolvedAt);assert.equal(resolved.resolvedByManualJobId,id);
  assert.equal(f.synced.at(-1).customers[0].humanTakeover, false);
  assert.equal((await f.call('/manual', request)).data.job.id, id); assert.equal(f.sent.length, 1);
});

test('manual拒绝收件覆盖、示例/删除/歧义/换标识客户及旧工作区，拒绝不创建手动任务', async t => {
  const f = await serviceFixture(t); const original = structuredClone(f.saved.state.customers);
  for (const patch of [{ customerId: 'other' }, { chatId: 'wxid_other' }, { text: '' }, { text: '中'.repeat(301) }, { text: '\ud800' }, { text: 'a\0b' }, { requestId: 'not-uuid' }]) assert.equal((await f.call('/manual', f.request(patch))).status, 400);
  for (const customers of [[{ ...original[0], source: 'demo' }], [], [{ ...original[0], wechatId: 'wxid_changed' }], [...original, { ...original[0], id: 'c2' }]]) { f.saved.state.customers = customers; assert.equal((await f.call('/manual', f.request())).status, 409); }
  f.saved.state.customers = original;
  assert.equal((await f.call('/manual', f.request(), { 'X-Kexu-Workspace': 'acct-aaaaaaaaaaaaaaaaaaaa@2' })).status, 409);
  assert.equal(f.sent.length, 0); assert.equal((await f.service.status()).jobs.filter(job => job.kind === 'manual').length, 0);
});

test('旧HTTP能力明确不支持manual，核对期间换号也不会保留或发送手动任务', async t => {
  const missing = await serviceFixture(t, { manualCapability: false }); assert.equal((await missing.call('/manual', missing.request())).status, 409); assert.equal((await missing.service.status()).jobs.filter(job => job.kind === 'manual').length, 0);
  const changed = await serviceFixture(t); changed.hooks.state = () => changed.changeWorkspace(); assert.equal((await changed.call('/manual', changed.request())).status, 409); assert.equal(changed.sent.length, 0);
});

test('adapter原生手动授权独立于auto暂停，严格核对回执且不使用HTTP回退', async t => {
  const root = await temporary(t); const workspace = { id: 'acct-aaaaaaaaaaaaaaaaaaaa', workspaceToken: 'acct-aaaaaaaaaaaaaaaaaaaa@1' }; let calls = 0, pauses = 0;
  const nativeSender = { status: async () => ({ configured: true, canSend: true, mode: 'native-background', requiresForeground: false, workspaceToken: workspace.workspaceToken }), start: async () => { assert.fail('人工不得启动自动接待'); }, syncConfig: async () => {}, pause: async () => { pauses++; }, send: async () => { assert.fail('人工不得调用auto发送'); }, sendManual: async input => { calls++; return { status: 'sent', messageId: '30001', chatId: input.chatId, textSha256: createHash('sha256').update(input.text, 'utf8').digest('hex'), readback: true, workspaceToken: workspace.workspaceToken }; } };
  const adapter = createReplyAdapter({ root, workspace, currentWorkspace: () => workspace.workspaceToken, nativeSender, reader: { inspect: async () => ({ configured: true, pythonReady: true, exporterReady: true }) }, fetch: async () => { assert.fail('不得降级HTTP发送'); } });
  t.after(() => adapter.pause()); const input = { chatId: 'wxid_synthetic_manual', text: '人工填写999元。', idempotencyKey: `manual:${randomUUID()}` };
  assert.equal((await adapter.status({ probe: true })).canManualSend, true); await adapter.pause();
  assert.equal((await adapter.sendManual(input)).status, 'sent'); assert.equal((await adapter.sendManual(input)).status, 'sent'); assert.equal(calls, 1); assert.ok(pauses > 0);
  assert.equal((await adapter.sendManual({ ...input, text: '不能换正文' })).status, 'failed');
  nativeSender.sendManual = async () => ({ status: 'sent', messageId: '30002' });
  const invalid = { ...input, idempotencyKey: `manual:${randomUUID()}` }; assert.equal((await adapter.sendManual(invalid)).status, 'unknown'); assert.equal((await adapter.sendManual(invalid)).status, 'unknown');
});

test('严格sent并完成恢复钩子后只resolve本条源卡，恢复该客户且不启动全局接待', async t => {
  let restores = 0;
  const f = await engineFixture(t, { sendManual: async () => ({ status: 'sent', messageId: '40001' }), restoreManual: async ({ expectedRevision, config }) => { restores++; assert.equal(expectedRevision, 7); assert.equal(config.customers[0].humanTakeover, false); return { restored: true }; } });
  const cfg = configuration(); cfg.customers.push({ id: 'c2', wechatId: 'wxid_synthetic_other', name: '另一客户', source: 'wechat', humanTakeover: true }); await f.engine.syncConfig(cfg);
  const request = f.request(); const prepared = await f.engine.prepareManual(request, { persistedRevision: 7 }); await f.engine.dispatchManual(prepared.job.id);
  const job = await until(() => f.engine.getJob(prepared.job.id), item => item.autoResumeStatus === 'restored');
  const source = await f.engine.getJob(request.jobId); assert.ok(source.resolvedAt); assert.equal(source.resolvedByManualJobId, job.id);
  assert.deepEqual((await f.engine.status()).takeovers, ['c2']); assert.equal((await f.engine.status()).running, false); assert.equal((await f.engine.getConfig()).settings.enabled, false);
  await f.engine.dispatchManual(job.id); assert.equal(restores, 1);
});

test('原本运行的自动接待恢复该客户后，下一条新咨询确实能生成并发送', async t => {
  let autoSends = 0;
  const f = await engineFixture(t, { sendManual: async () => ({ status: 'sent', messageId: '41001' }), send: async () => { autoSends++; return { status: 'sent', messageId: '41002' }; }, restoreManual: async () => ({ restored: true }) });
  const cfg = configuration(); cfg.settings.enabled = true; cfg.settings.mode = 'auto'; cfg.settings.selectedCustomerIds = ['c1']; cfg.settings.debounceSeconds = 0; cfg.settings.cooldownSeconds = 0; cfg.settings.businessHours.enabled = false; cfg.customers[0].autoReplyEnabled = true;
  await f.engine.syncConfig(cfg); await f.engine.start();
  const prepared = await f.engine.prepareManual(f.request(), { persistedRevision: 7 }); await f.engine.dispatchManual(prepared.job.id);
  await until(() => f.engine.getJob(prepared.job.id), job => job.autoResumeStatus === 'restored');
  const incomingJob = await f.engine.ingest(incoming()); assert.equal(incomingJob.status, 'queued');
  const next = (await f.engine.claimWork()).jobs[0]; assert.ok(next); assert.equal(next.customerId, 'c1');
  await f.engine.completeWork({ jobId: next.id, leaseId: next.leaseId, result: { action: 'clarify', reply: '请问您想了解哪项服务？', reason: '合成明确后续咨询。' } });
  await until(() => f.engine.getJob(next.id), job => job.status === 'sent'); assert.equal(autoSends, 1); assert.equal((await f.engine.status()).running, true);
});

test('恢复接口在途时服务关闭，不会在迟到回执后解锁或resolve', async t => {
  let release, entered = false;
  const f = await engineFixture(t, { sendManual: async () => ({ status: 'sent', messageId: '41003' }), restoreManual: async () => { entered = true; return new Promise(resolve => { release = resolve; }); } });
  const prepared = await f.engine.prepareManual(f.request(), { persistedRevision: 7 }); await f.engine.dispatchManual(prepared.job.id); await until(() => f.engine.status(), () => entered);
  await f.engine.close(); release({ restored: true });
  await until(() => f.engine.getJob(prepared.job.id), job => job.autoResumeStatus === 'blocked'); assert.equal((await f.engine.getJob(f.sourceId)).resolvedAt, undefined); assert.deepEqual((await f.engine.status()).takeovers, ['c1']);
});

for (const change of ['message', 'takeover', 'rules']) test(`发送期间新增${change}不会释放保护或隐藏原卡`, async t => {
  let release, restores = 0;
  const f = await engineFixture(t, { sendManual: async () => new Promise(resolve => { release = resolve; }), restoreManual: async () => { restores++; return { restored: true }; } });
  const prepared = await f.engine.prepareManual(f.request(), { persistedRevision: 7 }); await f.engine.dispatchManual(prepared.job.id); await until(() => f.engine.getJob(prepared.job.id), job => job.status === 'sending');
  if (change === 'message') await f.engine.ingest(incoming());
  else if (change === 'takeover') await f.engine.takeover({ customerId: 'c1', enabled: true });
  else await f.engine.syncConfig({ ...await f.engine.getConfig(), storeName: '新规则门店' });
  assert.equal((await f.engine.getJob(f.sourceId)).resolvedAt, undefined);
  release({ status: 'sent', messageId: '40002' });
  const job = await until(() => f.engine.getJob(prepared.job.id), item => item.status === 'sent' && item.autoResumeStatus === 'blocked');
  assert.ok(job.autoResumeReason); assert.equal((await f.engine.getJob(f.sourceId)).resolvedAt, undefined); assert.deepEqual((await f.engine.status()).takeovers, ['c1']); assert.equal(restores, 0);
});

test('恢复钩子在途时再次接管，二次guard保留人工并补偿同步原生保护', async t => {
  let release, entered = false; const synced = [];
  const f = await engineFixture(t, { sendManual: async () => ({ status: 'sent', messageId: '40003' }), restoreManual: async () => { entered = true; return new Promise(resolve => { release = resolve; }); }, syncManualProtection: async config => { synced.push(config); } });
  const prepared = await f.engine.prepareManual(f.request(), { persistedRevision: 7 }); await f.engine.dispatchManual(prepared.job.id); await until(() => f.engine.status(), () => entered);
  assert.equal((await f.engine.getJob(prepared.job.id)).autoResumeStatus, 'pending'); assert.equal((await f.engine.getJob(f.sourceId)).resolvedAt, undefined);
  await f.engine.takeover({ customerId: 'c1', enabled: true }); release({ restored: true });
  await until(() => f.engine.getJob(prepared.job.id), job => job.autoResumeStatus === 'blocked');
  await until(async () => synced, items => items.length === 1); assert.equal(synced[0].customers[0].humanTakeover, true); assert.deepEqual((await f.engine.status()).takeovers, ['c1']);
});

for (const reason of ['state-revision', 'new-message', 'read-failed', 'new-takeover-state']) test(`恢复过程${reason}失败保留原卡且不伪造已恢复`, async t => {
  const f = await serviceFixture(t); const request = f.request();
  if (reason === 'state-revision') f.hooks.resume = () => { f.saved.revision++; };
  else if (reason === 'new-message') f.hooks.extraMessages = () => [{ server_id: '90001', local_type: '1', sender: '客户', sender_username: 'wxid_synthetic_manual', content: '还有一个新问题。', timestamp: Math.floor(Date.now() / 1000) }];
  else if (reason === 'read-failed') f.hooks.read = () => { throw Error('只读提取暂不可用'); };
  else f.hooks.read = () => { f.saved.state.customers[0].humanTakeover = true; f.saved.revision++; };
  const accepted = await f.call('/manual', request); assert.equal(accepted.status, 200);
  const job = await until(async () => (await f.call(`/jobs/${accepted.data.job.id}`)).data.job, item => item.status === 'sent' && item.autoResumeStatus === 'blocked');
  assert.ok(job.autoResumeReason); assert.equal((await f.call(`/jobs/${request.jobId}`)).data.job.resolvedAt, undefined); assert.deepEqual((await f.service.status()).takeovers, ['c1']); assert.equal(f.sent.length, 1);
});

test('持久humanTakeover=true通过窄CAS恢复，stateRevision回执与运行时均确认', async t => {
  const f = await serviceFixture(t); f.saved.state.customers[0].humanTakeover = true;
  const request = f.request(), accepted = await f.call('/manual', request);
  await until(async () => (await f.call(`/jobs/${accepted.data.job.id}`)).data.job, job => job.autoResumeStatus === 'restored');
  assert.equal(f.saved.revision, 8); assert.equal(f.saved.state.customers[0].humanTakeover, false); assert.equal((await f.service.status()).stateRevision, 8); assert.deepEqual((await f.service.status()).takeovers, []);
});

test('旧sent缺guard不自动迁移，明确恢复只读核验后resolve且不再发送', async t => {
  const f = await serviceFixture(t, { legacySent: true });
  assert.equal((await f.call(`/jobs/${f.legacyJobId}`)).data.job.autoResumeStatus, 'blocked');
  assert.equal((await f.call(`/jobs/${f.request().jobId}`)).data.job.resolvedAt, undefined);
  const result = await f.call('/manual-resume', { jobId: f.legacyJobId }); assert.equal(result.status, 200); assert.equal(result.data.job.autoResumeStatus, 'restored'); assert.equal(f.sent.length, 1);
  const source = (await f.call(`/jobs/${result.data.job.sourceJobId}`)).data.job; assert.ok(source.resolvedAt); assert.equal(source.resolvedByManualJobId, f.legacyJobId);
  assert.equal((await f.call('/manual-resume', { jobId: f.legacyJobId })).data.job.autoResumeStatus, 'restored'); assert.equal(f.sent.length, 1);
});

test('明确恢复旧sent发现后续新咨询时保留旧卡，不将新问题当旧回声忽略', async t => {
  const f = await serviceFixture(t, { legacySent: true }); f.hooks.extraMessages = () => [{ server_id: '90002', local_type: '1', sender: '客户', sender_username: 'wxid_synthetic_manual', content: '我现在有一个新问题。', timestamp: Math.floor(Date.now() / 1000) }];
  const result = await f.call('/manual-resume', { jobId: f.legacyJobId }); assert.equal(result.status, 200); assert.equal(result.data.job.autoResumeStatus, 'blocked'); assert.equal(f.sent.length, 1);
  assert.equal((await f.call(`/jobs/${result.data.job.sourceJobId}`)).data.job.resolvedAt, undefined); assert.deepEqual((await f.service.status()).takeovers, ['c1']);
});

for (const outcome of ['failed', 'unknown']) test(`${outcome}手动任务不能调用恢复接口绕过成功回执`, async t => {
  const f = await serviceFixture(t, { result: { status: outcome } }); const request = f.request(); const accepted = await f.call('/manual', request);
  await until(async () => (await f.call(`/jobs/${accepted.data.job.id}`)).data.job, job => job.status === outcome);
  const rejected = await f.call('/manual-resume', { jobId: accepted.data.job.id }); assert.equal(rejected.status, 409); assert.equal(f.sent.length, 1); assert.equal((await f.call(`/jobs/${request.jobId}`)).data.job.resolvedAt, undefined); assert.deepEqual((await f.service.status()).takeovers, ['c1']);
});

test('无有效numeric原生ID的伪sent不能自动resolve或恢复', async t => {
  let restores = 0;
  const f = await engineFixture(t, { sendManual: async () => ({ status: 'sent', messageId: 'not-a-native-id' }), restoreManual: async () => { restores++; return { restored: true }; } });
  const prepared = await f.engine.prepareManual(f.request(), { persistedRevision: 7 }); await f.engine.dispatchManual(prepared.job.id);
  await until(() => f.engine.getJob(prepared.job.id), job => job.status === 'sent' && job.autoResumeStatus === 'blocked');
  assert.equal(restores, 0); assert.equal((await f.engine.getJob(f.sourceId)).resolvedAt, undefined); assert.deepEqual((await f.engine.status()).takeovers, ['c1']);
});
