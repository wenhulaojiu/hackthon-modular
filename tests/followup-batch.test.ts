import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { applyFollowupReceipt } from '../lib/followup.ts';
import { batchFollowupBlockReason, followupButtonAction, followupTextSha256, prepareFollowupBatch, runFollowupBatch } from '../app/components/followup-batch.ts';
import type { FollowupBatchContext, FollowupBatchItem, FollowupBatchPlan } from '../app/components/followup-batch.ts';
import type { AppState, ReplyJobView } from '../lib/types.ts';

function context(): FollowupBatchContext {
  const customers = ['甲', '乙', '丙'].map((name, index) => ({ id: `c${index}`, name: `合成${name}`, wechatId: `wxid_synthetic_${index}`, source: 'wechat' as const, color: '#123456', stage: '新客户' as const, tags: [], manualTags: [], summary: '', preferences: '', budget: '', note: '', createdAt: '2026-11-07', lastContactAt: '', nextFollowUpAt: '2026-11-07', evidence: [], messages: [], autoReplyEnabled: true }));
  const state: AppState = { schemaVersion: 1, demo: false, imports: [], orders: [], settings: { storeName: '合成门店', industry: '零售', followupDays: 7, ai: { baseUrl: 'https://example.test', model: 'synthetic', temperature: 0, profilePrompt: '', marketingPrompt: '', extractionPrompt: '' } }, customers, tasks: customers.map((customer, index) => ({ id: `t${index}`, customerId: customer.id, title: `合成跟进${index}`, date: '2026-11-07', kind: 'followup', status: 'todo', priority: 'normal', script: `您好，合成咨询${index}的体验怎么样？` })), replySettings: { enabled: true, mode: 'review', selectedCustomerIds: customers.map(customer => customer.id), businessHours: { enabled: false, start: '09:00', end: '18:00', days: [1] }, faq: [], handoffKeywords: [], maxReplyChars: 300, cooldownSeconds: 0, debounceSeconds: 10, prompt: '' } };
  return { state, runtime: { running: true, takeovers: [], jobs: [], adapter: { canSend: true } }, local: true, locked: false, submittedTaskIds: new Set() };
}
const receipt = (item: FollowupBatchItem, status: ReplyJobView['status'] = 'sent'): ReplyJobView => ({ id: `job-${item.taskId}`, customerId: item.customerId, chatId: item.chatId, kind: 'followup', taskId: item.taskId, status, message: { id: item.taskId, text: '商家主动跟进', date: '2026-11-07' }, reply: item.text, createdAt: '2026-11-07', updatedAt: '2026-11-07', ...(status === 'sent' ? { sendMessageId: `message-${item.taskId}` } : {}) });
function harness(value: FollowupBatchContext) {
  const events: string[] = [], attempts = new Set<string>(), deliveries: { taskId: string; jobId: string; note: string }[] = [];
  const dependencies = {
    current: async () => value,
    assertCurrent: () => {},
    attempted: attempts,
    onAttempt: (item: FollowupBatchItem) => { events.push(`attempt:${item.taskId}`); },
    submit: async (item: FollowupBatchItem) => { events.push(`submit:${item.taskId}`); return { jobId: `job-${item.taskId}` }; },
    observe: async (item: FollowupBatchItem) => { events.push(`observe:${item.taskId}`); return receipt(item); },
    onDelivery: (item: FollowupBatchItem, jobId: string, _job: ReplyJobView | null, note: string) => { deliveries.push({ taskId: item.taskId, jobId, note }); },
    finish: async (item: FollowupBatchItem, job: ReplyJobView) => { events.push(`finish:${item.taskId}`); value.state = applyFollowupReceipt(value.state, item.taskId, job); },
  };
  return { dependencies, events, attempts, deliveries };
}
const planFor = (value: FollowupBatchContext): Promise<FollowupBatchPlan> => prepareFollowupBatch(value, value.state.tasks);

test('预览只包含当前列表可发的已保存正文，SHA256按UTF8冻结', async () => {
  const value = context();
  value.state.customers[1].source = 'demo';
  value.state.tasks[2].script = '';
  const plan = await planFor(value);
  assert.equal(plan.items.length, 1); assert.equal(plan.skipped.length, 2);
  assert.match(plan.skipped[0].reason, /演示/); assert.match(plan.skipped[1].reason, /话术/);
  assert.equal(plan.items[0].text, value.state.tasks[0].script);
  assert.equal(plan.items[0].textSha256, createHash('sha256').update(value.state.tasks[0].script, 'utf8').digest('hex'));
  assert.equal(await followupTextSha256('合成正文'), createHash('sha256').update('合成正文', 'utf8').digest('hex'));
  assert.deepEqual((await prepareFollowupBatch(context(), [])).items, []);
});

test('已完成、已提交、模糊客户、关闭或接管、无组件均有跳过原因', () => {
  const mutations: ((value: FollowupBatchContext) => void)[] = [
    value => { value.state.tasks[0].status = 'done'; },
    value => { value.submittedTaskIds = new Set(['t0']); },
    value => { value.runtime!.jobs.push(receipt({ taskId: 't0', customerId: 'c0', chatId: 'wxid_synthetic_0', customerName: '', title: '', text: value.state.tasks[0].script, textSha256: '' })); },
    value => { value.state.customers[1].wechatId = value.state.customers[0].wechatId; },
    value => { value.state.replySettings!.enabled = false; },
    value => { value.state.replySettings!.selectedCustomerIds = []; },
    value => { value.state.customers[0].autoReplyEnabled = false; },
    value => { value.state.customers[0].humanTakeover = true; },
    value => { value.runtime!.takeovers = ['c0']; },
    value => { value.runtime!.running = false; },
    value => { value.runtime!.adapter!.canSend = false; },
    value => { value.local = false; },
    value => { value.locked = true; },
  ];
  for (const change of mutations) { const value = context(); change(value); assert.ok(batchFollowupBlockReason(value, value.state.tasks[0])); }
});

test('unknown及其他终态保留检查原任务入口，发送已核实且完成后才停用按钮', () => {
  for (const status of ['unknown', 'failed', 'handoff', 'ignored', 'cancelled', 'draft', 'ready', 'sending'] as const) {
    const action = followupButtonAction({ status: 'todo' }, { job: { status } });
    assert.equal(action.mode, 'query'); assert.equal(action.disabled, false); assert.equal(action.label, '检查此条结果');
  }
  assert.deepEqual(followupButtonAction({ status: 'todo' }, {}), { mode: 'query', label: '检查此条结果', disabled: false });
  assert.deepEqual(followupButtonAction({ status: 'todo' }, { job: { status: 'sent' } }), { mode: 'query', label: '完成发送记录', disabled: false });
  assert.equal(followupButtonAction({ status: 'done' }, { job: { status: 'sent' } }).disabled, true);
  assert.equal(followupButtonAction({ status: 'todo' }).mode, 'send');
});

test('完整防重索引让最近200条之外的老任务也被跳过，旧版缺省字段兼容', async () => {
  const value = context(), oldPlan = await planFor(value), run = harness(value);
  assert.equal(oldPlan.items.length, 3);
  value.runtime!.submittedFollowups = [{ taskId: 't0', jobId: 'old-job-t0' }];
  value.runtime!.jobs = [];
  const onlyOld = await prepareFollowupBatch(value, [value.state.tasks[0]]);
  assert.equal(onlyOld.items.length, 0); assert.equal(onlyOld.skipped.length, 1); assert.match(onlyOld.skipped[0].reason, /已提交/);
  const latest = await planFor(value);
  assert.deepEqual(latest.items.map(item => item.taskId), ['t1', 't2']);
  const blocked = await runFollowupBatch(oldPlan, run.dependencies, new AbortController().signal);
  assert.equal(blocked.submitted, 0); assert.equal(blocked.notSent, 3); assert.deepEqual(run.events, []);
});

test('逐条提交、观察、核实完成后才提交下一条；再次执行没有额外提交', async () => {
  const value = context(), plan = await planFor(value), run = harness(value);
  const result = await runFollowupBatch(plan, run.dependencies, new AbortController().signal);
  assert.equal(result.sent, 3); assert.equal(result.notSent, 0); assert.equal(result.stopped, false);
  assert.deepEqual(run.events, ['attempt:t0', 'submit:t0', 'observe:t0', 'finish:t0', 'attempt:t1', 'submit:t1', 'observe:t1', 'finish:t1', 'attempt:t2', 'submit:t2', 'observe:t2', 'finish:t2']);
  assert.ok(value.state.tasks.every(task => task.status === 'done'));
  const count = run.events.length;
  const duplicate = await runFollowupBatch(plan, run.dependencies, new AbortController().signal);
  assert.equal(duplicate.submitted, 0); assert.equal(run.events.length, count);
});

test('正文或hash改变时暂停，不提交；上一条之后的最新state也必须重读', async () => {
  for (const alterHash of [false, true]) {
    const value = context(), plan = await planFor(value), run = harness(value);
    if (alterHash) plan.items[0].textSha256 = '0'.repeat(64); else value.state.tasks[0].script += '修改';
    const result = await runFollowupBatch(plan, run.dependencies, new AbortController().signal);
    assert.equal(result.submitted, 0); assert.equal(result.notSent, 3); assert.match(result.reason, /变化/); assert.deepEqual(run.events, []);
  }
  const value = context(), plan = await planFor(value), run = harness(value), finish = run.dependencies.finish;
  run.dependencies.finish = async (item, job) => { await finish(item, job); value.state.tasks[1].script += '其他窗口修改'; };
  const result = await runFollowupBatch(plan, run.dependencies, new AbortController().signal);
  assert.equal(result.sent, 1); assert.equal(result.submitted, 1); assert.equal(result.notSent, 2); assert.match(result.reason, /变化/);
});

test('unknown、有限等待结束、失败、缺少凭据均停止后续，未核实不完成', async () => {
  for (const status of ['unknown', 'ready', 'failed', 'sent'] as const) {
    const value = context(), plan = await planFor(value), run = harness(value);
    run.dependencies.observe = async item => { run.events.push(`observe:${item.taskId}`); const job = receipt(item, status); if (status === 'sent') delete job.sendMessageId; return job; };
    const result = await runFollowupBatch(plan, run.dependencies, new AbortController().signal);
    assert.equal(result.submitted, 1); assert.equal(result.sent, 0); assert.equal(result.notSent, 2); assert.equal(result.stopped, true);
    assert.equal(value.state.tasks[0].status, 'todo'); assert.equal(run.deliveries.at(-1)?.jobId, 'job-t0');
    assert.equal(result.failed + result.unconfirmed, 1);
  }
});

test('中止和工作区切换阻断后续；已提交的任务编号与原文仍可查询，重复不新增提交', async () => {
  const value = context(), plan = await planFor(value), run = harness(value), controller = new AbortController();
  run.dependencies.observe = async item => { controller.abort(new Error('合成手动停止')); return receipt(item); };
  const stopped = await runFollowupBatch(plan, run.dependencies, controller.signal);
  assert.equal(stopped.submitted, 1); assert.equal(stopped.unconfirmed, 1); assert.equal(stopped.notSent, 2);
  assert.equal(run.deliveries.at(-1)?.jobId, 'job-t0'); assert.equal(plan.items[0].text, value.state.tasks[0].script);
  const repeated = await runFollowupBatch(plan, run.dependencies, new AbortController().signal);
  assert.equal(repeated.submitted, 0); assert.equal(run.events.filter(event => event.startsWith('submit:')).length, 1);
  const fresh = context(), freshPlan = await planFor(fresh), switched = harness(fresh), finish = switched.dependencies.finish;
  let invalid = false;
  switched.dependencies.assertCurrent = () => { if (invalid) throw new Error('合成工作区已切换'); };
  switched.dependencies.finish = async (item, job) => { await finish(item, job); invalid = true; };
  const result = await runFollowupBatch(freshPlan, switched.dependencies, new AbortController().signal);
  assert.equal(result.sent, 1); assert.equal(result.notSent, 2); assert.match(result.reason, /工作区/);
});

test('提交断线不重提，逐条总超时停止；零可发不伪造成功', async () => {
  const value = context(), plan = await planFor(value), run = harness(value);
  run.dependencies.submit = async () => { throw new Error('合成网络断线'); };
  const uncertain = await runFollowupBatch(plan, run.dependencies, new AbortController().signal);
  assert.equal(uncertain.unconfirmed, 1); assert.equal(uncertain.notSent, 2); assert.equal(run.attempts.size, 1);
  const timeoutValue = context(), timeoutPlan = await planFor(timeoutValue), timeout = harness(timeoutValue);
  const timeoutResult = await runFollowupBatch(timeoutPlan, { ...timeout.dependencies, observe: async (_item, _id, signal) => new Promise((_resolve, reject) => { const hold = setTimeout(() => reject(new Error('合成等待上限')), 200); signal.addEventListener('abort', () => { clearTimeout(hold); reject(signal.reason); }, { once: true }); }) }, new AbortController().signal, { itemTimeoutMs: 20 });
  assert.equal(timeoutResult.submitted, 1); assert.equal(timeoutResult.unconfirmed, 1); assert.equal(timeoutResult.notSent, 2);
  const empty = await runFollowupBatch({ items: [], skipped: [] }, harness(context()).dependencies, new AbortController().signal);
  assert.equal(empty.sent, 0); assert.equal(empty.submitted, 0); assert.match(empty.reason, /没有可发送/);
});
