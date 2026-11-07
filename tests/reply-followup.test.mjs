import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createReplyEngine, DEFAULT_REPLY_SETTINGS } from '../scripts/local-wechat/reply-engine.mjs';

const initialTime = Date.parse('2026-11-07T02:00:00.000Z');
const script = '您好，之前咨询的咖啡礼盒100元，有需要可以继续告诉我们。';
const config = (mode = 'review') => ({ settings: { ...structuredClone(DEFAULT_REPLY_SETTINGS), enabled: true, mode, selectedCustomerIds: ['c1'], cooldownSeconds: 0, businessHours: { enabled: false, start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5, 6] } }, customers: [{ id: 'c1', wechatId: 'wxid_c1', name: '合成客户', autoReplyEnabled: true, source: 'wechat' }], products: [{ id: 'coffee', name: '咖啡礼盒', type: 'product', price: 100, description: '', faq: [], enabled: true }], storeName: '合成门店', industry: '零售' });
const request = (extra = {}) => ({ taskId: 'task-1', customerId: 'c1', text: script, ...extra });
const incoming = (id, extra = {}) => ({ id, chatId: 'wxid_c1', sender: 'customer', text: '咖啡礼盒有货吗？', date: new Date(initialTime).toISOString(), source: 'realtime', kind: 'text', ...extra });
const goodReply = { action: 'reply', reply: '您好，咖啡礼盒100元。', reason: '已保存的价格。', productIds: ['coffee'] };

async function fixture(t, options = {}) {
  const parent = await realpath(os.tmpdir()); const directory = await mkdtemp(path.join(parent, 'kexu-followup-test-')); const engines = [];
  const create = async (overrides = {}) => { const engine = await createReplyEngine({ directory, now: () => initialTime, tickMs: 5, ...options, ...overrides }); engines.push(engine); return engine; };
  const engine = await create();
  t.after(async () => {
    for (const item of engines) await item.close();
    const actual = await realpath(directory); assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase()); assert.ok(path.basename(actual).startsWith('kexu-followup-test-'));
    // 只清理本次合成测试目录，不读取或操作实际微信和发送记录。
    await rm(actual, { recursive: true, force: true });
  });
  return { engine, create, directory, filename: path.join(directory, 'queue.json') };
}
async function until(engine, check) { for (let index = 0; index < 300; index++) { const state = await engine.status(); if (check(state)) return state; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('合成跟进任务未达到预期状态'); }

test('一键跟进在审阅模式也按明确批准直接发送保存文案，不调用AI', async t => {
  let generations = 0; const sent = [];
  const { engine } = await fixture(t, { generate: async () => { generations++; return goodReply; }, send: async input => { sent.push(input); return { status: 'sent', messageId: 'confirmed-followup' }; } });
  await engine.syncConfig(config()); await engine.start();
  const queued = await engine.enqueueFollowup(request()); assert.equal(queued.accepted, true); assert.equal(queued.status, 'ready');
  await until(engine, state => state.counts.sent === 1);
  const job = await engine.getJob(queued.jobId); assert.equal(job.kind, 'followup'); assert.equal(job.taskId, 'task-1'); assert.equal(job.status, 'sent'); assert.equal(job.sendMessageId, 'confirmed-followup');
  assert.deepEqual(sent, [{ chatId: 'wxid_c1', text: script, idempotencyKey: queued.jobId }]); assert.equal(generations, 0);
  assert.equal((await engine.enqueueFollowup(request())).duplicate, true); assert.equal(sent.length, 1);
  await assert.rejects(engine.enqueueFollowup(request({ text: '另一份跟进正文' })), /不能更换客户或正文/);
  await assert.rejects(engine.enqueueFollowup(request({ customerId: 'other-customer' })), /不能更换客户或正文/);
});

test('暂停、未启用或无发送函数时不自动启动，也不创建跟进防重记录', async t => {
  const f = await fixture(t);
  await f.engine.syncConfig(config());
  await assert.rejects(f.engine.enqueueFollowup(request()), /已暂停.*启动/);
  await f.engine.start(); await assert.rejects(f.engine.enqueueFollowup(request()), /发送组件尚未接通/);
  assert.equal((await f.engine.status()).jobs.length, 0); assert.equal((await f.engine.status()).running, true);
  assert.deepEqual(JSON.parse(await readFile(f.filename, 'utf8')).followupOnce, {});
  await f.engine.pause(); assert.equal((await f.engine.status()).running, false);
});

test('未选客户、明确关闭、人工接管、示例客户、系统群聊和闭店时不提交主动跟进', async t => {
  for (const [label, change] of [
    ['未选', value => { value.settings.selectedCustomerIds = []; }],
    ['关闭', value => { value.customers[0].autoReplyEnabled = false; }],
    ['人工', value => { value.customers[0].humanTakeover = true; }],
    ['示例', value => { value.customers[0].source = 'demo'; }],
    ['系统', value => { value.customers[0].wechatId = 'weixin'; }],
    ['群聊', value => { value.customers[0].wechatId = 'group@chatroom'; }],
    ['闭店', value => { value.settings.businessHours = { enabled: true, start: '23:00', end: '23:30', days: [6] }; }],
  ]) await t.test(label, async subtest => {
    const f = await fixture(subtest, { send: async () => { assert.fail('未授权场景不得发送'); } });
    const initial = config(); change(initial);
    await f.engine.syncConfig(initial);
    if (label === '群聊') { await assert.rejects(f.engine.start()); return; }
    await f.engine.start(); await assert.rejects(f.engine.enqueueFollowup(request()));
    assert.equal((await f.engine.status()).jobs.length, 0); assert.deepEqual(JSON.parse(await readFile(f.filename, 'utf8')).followupOnce, {});
  });
});

test('草稿长度、未知金额与越权承诺继续校验，拒绝后同task仍可修正文案', async t => {
  const { engine } = await fixture(t, { send: async () => ({ status: 'sent', messageId: 'valid-followup' }) });
  await engine.syncConfig(config()); await engine.start();
  for (const text of ['', ' ', '中'.repeat(301), '\ud800', 'bad\0text', '之前的套餐999元，要不要了解？', '已经退款，请查收。']) await assert.rejects(engine.enqueueFollowup(request({ text })));
  assert.equal((await engine.status()).jobs.length, 0);
  await engine.enqueueFollowup(request()); await until(engine, state => state.counts.sent === 1);
});

test('跟进与普通咨询独立，按同会话旧队列先后发送，不合并也不重置咨询10秒截止', async t => {
  let clock = initialTime; const sent = []; let generations = 0;
  const { engine } = await fixture(t, { now: () => clock, generate: async () => { generations++; return goodReply; }, send: async input => { sent.push(input.text); return { status: 'sent', messageId: `sent-${sent.length}` }; } });
  await engine.syncConfig(config('auto')); await engine.start();
  await engine.ingest(incoming('first-question')); const original = (await engine.status()).jobs[0];
  const queued = await engine.enqueueFollowup(request());
  assert.equal((await engine.status()).jobs.find(job => job.kind === 'reply').quietUntil, original.quietUntil);
  clock += 3000; await engine.ingest(incoming('second-question', { text: '需要简单包装。' }));
  const consultation = (await engine.status()).jobs.find(job => job.kind === 'reply');
  assert.equal(consultation.messages.length, 2); assert.equal((await engine.getJob(queued.jobId)).reply, script);
  assert.equal((await engine.getJob(queued.jobId)).messages.length, 1); assert.equal(sent.length, 0);
  clock += 10_000; await until(engine, state => state.counts.sent === 2);
  assert.deepEqual(sent, [goodReply.reply, script]); assert.equal(generations, 1);
});

for (const result of ['sent', 'unknown']) test(`跟进${result}后跨重启不再入队或重发，unknown保留人工接管`, async t => {
  let sends = 0;
  const f = await fixture(t, { send: async () => { sends++; return result === 'sent' ? { status: 'sent', messageId: 'only-once' } : { status: 'unknown' }; } });
  await f.engine.syncConfig(config()); await f.engine.start(); const queued = await f.engine.enqueueFollowup(request());
  await until(f.engine, state => state.counts[result] === 1); await f.engine.close();
  const reopened = await f.create(); await reopened.start(); const duplicate = await reopened.enqueueFollowup(request());
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.jobId, queued.jobId); assert.equal(duplicate.status, result);
  assert.equal((await reopened.getJob(queued.jobId)).status, result); assert.equal(sends, 1);
  if (result === 'unknown') assert.ok((await reopened.status()).takeovers.includes('c1'));
});

test('getJob可查询超过状态列表200条的已提交任务，旧队列缺省防重字段可迁移', async t => {
  const f = await fixture(t, { send: async () => ({ status: 'sent', messageId: 'old-job' }) });
  await f.engine.syncConfig(config()); await f.engine.start(); const queued = await f.engine.enqueueFollowup(request()); await until(f.engine, state => state.counts.sent === 1); await f.engine.close();
  const stored = JSON.parse(await readFile(f.filename, 'utf8')); delete stored.followupOnce;
  const original = stored.jobs[0];
  for (let index = 0; index < 205; index++) stored.jobs.push({ ...original, id: `filler-${index}`, kind: 'reply', status: 'ignored', taskId: undefined });
  await writeFile(f.filename, JSON.stringify(stored), 'utf8'); const reopened = await f.create();
  assert.ok(!(await reopened.status()).jobs.some(job => job.id === queued.jobId));
  assert.equal((await reopened.getJob(queued.jobId)).taskId, 'task-1'); assert.equal(await reopened.getJob('missing-job'), null);
  await reopened.start(); assert.equal((await reopened.enqueueFollowup(request())).duplicate, true);
});
