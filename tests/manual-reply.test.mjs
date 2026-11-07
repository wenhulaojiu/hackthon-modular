import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
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
  assert.equal((await f.engine.getJob(source.jobId)).status, 'cancelled');
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
  const seed = await createReplyEngine({ directory, now: () => time }); await seed.syncConfig(configuration()); const source = await seed.ingest(incoming()); await seed.close();
  const saved = { state: { customers: structuredClone(configuration().customers) }, revision: 7 }; const sent = [], synced = []; const hooks = {}; let starts = 0, service;
  const adapter = { status: async () => ({ canReceive: true, canSend: false, canManualSend: options.manualCapability !== false }), start: async () => { starts++; }, syncConfig: async config => { synced.push(structuredClone(config)); }, pause: () => {}, fail: () => {}, poll: async () => [], send: async () => { assert.fail('暂停状态不可使用自动发送'); }, sendManual: async input => { sent.push(input); return options.result || { status: 'sent', messageId: '20001' }; } };
  const server = http.createServer((request, response) => { void service.handle(request, response).then(handled => { if (!handled) { response.statusCode = 404; response.end(); } }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  service = await createLocalReplyService({ root, origin, adapter, workspace, currentWorkspace: () => current, pollMs: 60_000, generate: async () => { assert.fail('手动服务不得调用模型'); }, fetch: async (url, input) => { assert.equal(url, `${origin}/api/state`); assert.equal(input.method, undefined); assert.equal(input.headers['X-Kexu-Workspace'], workspace.workspaceToken); await hooks.state?.(); return Response.json(saved); } });
  t.after(async () => { await service.close(); await new Promise(resolve => server.close(resolve)); });
  const call = async (route, body, headers = {}) => { const r = await fetch(`${origin}/__local-wechat/replies${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Kexu-Local': '1', 'X-Kexu-Workspace': workspace.workspaceToken, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() }; };
  return { call, service, sent, synced, saved, hooks, starts: () => starts, changeWorkspace: () => { current = 'acct-bbbbbbbbbbbbbbbbbbbb@2'; }, request: extra => ({ jobId: source.jobId, requestId: randomUUID(), text: '人工为您回复：可按999元方案沟通。', ...extra }) };
}

test('manual服务只读持久客户快照、暂停也可发送，并返回可按requestId恢复的独立任务', async t => {
  const f = await serviceFixture(t); const before = structuredClone(f.saved); const request = f.request();
  const accepted = await f.call('/manual', request); assert.equal(accepted.status, 200); const id = accepted.data.job.id;
  const result = await until(async () => (await f.call(`/jobs/${id}`)).data.job, job => job.status === 'sent');
  assert.equal(result.kind, 'manual'); assert.equal(result.sourceJobId, request.jobId); assert.equal(result.requestId, request.requestId); assert.equal(result.reply, request.text); assert.equal(f.sent.length, 1);
  assert.equal(f.starts(), 0); assert.equal((await f.service.status()).running, false); assert.deepEqual((await f.service.status()).takeovers, ['c1']); assert.deepEqual(f.saved, before);
  assert.equal(f.synced.at(-1).customers[0].humanTakeover, true);
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
