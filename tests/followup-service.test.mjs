import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createLocalReplyService } from '../scripts/local-wechat/reply-service.mjs';
import { DEFAULT_REPLY_SETTINGS } from '../scripts/local-wechat/reply-engine.mjs';

async function fixture(t) {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'kexu-followup-service-'));
  const workspace = { id: 'acct-aaaaaaaaaaaaaaaaaaaa', workspaceToken: 'acct-aaaaaaaaaaaaaaaaaaaa@1' };
  const hooks = {}, sends = [], prepared = [];
  let service, active = false;
  const adapter = { status: async () => ({ canReceive: true, canSend: true }), start: async () => { active = true; }, syncConfig: async () => {}, pause: () => { active = false; }, fail: () => { active = false; }, poll: async () => [], send: async input => { assert.equal(active, true); sends.push(input); return { status: 'sent', messageId: '123456789' }; } };
  const server = http.createServer((request, response) => { void service.handle(request, response).then(handled => { if (!handled) { response.statusCode = 404; response.end(); } }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  service = await createLocalReplyService({ root, origin, adapter, workspace, currentWorkspace: () => workspace.workspaceToken, pollMs: 60_000, generate: async () => { throw new Error('主动跟进不应调用模型'); }, fetch: async (url, input) => {
    assert.equal(url, `${origin}/api/followup`); assert.deepEqual(JSON.parse(input.body), { taskId: 'task-one' }); assert.equal(input.headers['X-Kexu-Local'], '1'); assert.equal(input.headers['X-Kexu-Workspace'], workspace.workspaceToken); prepared.push(input.body); await hooks.prepare?.(); return Response.json({ taskId: 'task-one', customerId: 'c1', text: '您好，最近使用体验怎么样？' });
  } });
  t.after(async () => { await service.close(); await new Promise(resolve => server.close(resolve)); const resolved = await realpath(root); assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase()); assert.ok(path.basename(resolved).startsWith('kexu-followup-service-')); await rm(resolved, { recursive: true, force: true }); });
  const call = async (route, body) => { const response = await fetch(`${origin}/__local-wechat/replies${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Kexu-Local': '1', 'X-Kexu-Workspace': workspace.workspaceToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() }; };
  const config = { settings: { ...structuredClone(DEFAULT_REPLY_SETTINGS), enabled: true, mode: 'review', autoEnrollNewContacts: false, selectedCustomerIds: ['c1'], businessHours: { enabled: false, start: '09:00', end: '18:00', days: [1] }, cooldownSeconds: 0 }, customers: [{ id: 'c1', wechatId: 'wxid_synthetic', name: '合成客户', autoReplyEnabled: true }], products: [], storeName: '合成门店', industry: '零售' };
  assert.equal((await call('/config', config)).status, 200);
  return { service, call, hooks, sends, prepared };
}

test('本机一键跟进从API取已保存文字，review也直接发送，按job查询且同task不再发', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/followup', { taskId: 'task-one' })).status, 409); assert.equal(f.prepared.length, 0);
  await f.call('/start', {});
  assert.equal((await f.call('/followup', { taskId: 'task-one', text: '不允许任意正文' })).status, 400);
  const accepted = await f.call('/followup', { taskId: 'task-one' }); assert.equal(accepted.status, 200);
  const id = accepted.data.followup.jobId;
  let job;
  for (let count = 0; count < 300; count++) { job = (await f.call(`/jobs/${id}`)).data.job; if (job.status === 'sent') break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(job.status, 'sent'); assert.equal(job.kind, 'followup'); assert.equal(job.taskId, 'task-one'); assert.equal(job.reply, '您好，最近使用体验怎么样？'); assert.equal(f.sends.length, 1);
  const duplicate = await f.call('/followup', { taskId: 'task-one' }); assert.equal(duplicate.data.followup.duplicate, true); assert.equal(duplicate.data.followup.jobId, id); assert.equal(f.sends.length, 1);
});

test('读取已保存话术期间用户暂停，迟到准备结果不能入队或发送', async t => {
  const f = await fixture(t); await f.call('/start', {});
  let release; const entered = new Promise(resolve => { f.hooks.prepare = () => { resolve(); return new Promise(done => { release = done; }); }; });
  const sending = f.call('/followup', { taskId: 'task-one' }); await entered; await f.service.pause(); release();
  assert.equal((await sending).status, 409); assert.equal(f.sends.length, 0); assert.equal((await f.service.status()).jobs.length, 0);
});

test('批量预览摘要必须与准备API返回的UTF8正文完全一致，否则409且不创建发送任务', async t => {
  const f = await fixture(t); await f.call('/start', {});
  const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
  assert.equal((await f.call('/followup', { taskId: 'task-one', expectedTextSha256: 'BAD-HASH' })).status, 400);
  const changed = await f.call('/followup', { taskId: 'task-one', expectedTextSha256: digest('这是另一窗口修改前的旧话术。') });
  assert.equal(changed.status, 409); assert.equal(f.sends.length, 0); assert.equal((await f.service.status()).jobs.length, 0);
  const accepted = await f.call('/followup', { taskId: 'task-one', expectedTextSha256: digest('您好，最近使用体验怎么样？') }); assert.equal(accepted.status, 200);
  let job;
  for (let count = 0; count < 300; count++) { job = (await f.call(`/jobs/${accepted.data.job.id}`)).data.job; if (job.status === 'sent') break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(job.status, 'sent'); assert.equal(f.sends.length, 1);
});
