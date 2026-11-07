import assert from 'node:assert/strict';
import test from 'node:test';
import { applyFollowupReceipt, followupBlockReason, prepareSavedFollowup } from '../lib/followup.ts';
import { observeFollowup } from '../app/components/followup-control.ts';
import type { AppState, ReplyJobView } from '../lib/types.ts';

function state(): AppState {
  return { schemaVersion: 1, demo: false, imports: [], orders: [], settings: { storeName: '合成门店', industry: '零售', followupDays: 7, ai: { baseUrl: 'https://example.test', model: 'synthetic', temperature: 0, profilePrompt: '', marketingPrompt: '', extractionPrompt: '' } }, customers: [{ id: 'c1', name: '合成客户', wechatId: 'wxid_synthetic', source: 'wechat', color: '#123456', stage: '新客户', tags: [], manualTags: [], summary: '', preferences: '', budget: '', note: '', createdAt: '2026-11-07', lastContactAt: '', nextFollowUpAt: '2026-11-07', evidence: [], messages: [], autoReplyEnabled: true }], tasks: [{ id: 'task-one', customerId: 'c1', title: '合成跟进', date: '2026-11-07', kind: 'followup', status: 'todo', priority: 'normal', script: '您好，最近使用体验怎么样？' }, { id: 'task-two', customerId: 'c1', title: '后续联系', date: '2026-11-10', kind: 'reminder', status: 'todo', priority: 'normal', script: '' }], replySettings: { enabled: true, mode: 'review', selectedCustomerIds: ['c1'], businessHours: { enabled: false, start: '09:00', end: '18:00', days: [1] }, faq: [], handoffKeywords: [], maxReplyChars: 300, cooldownSeconds: 0, debounceSeconds: 10, prompt: '' } };
}
const receipt = (status: ReplyJobView['status'] = 'sent'): ReplyJobView => ({ id: 'synthetic-job', customerId: 'c1', chatId: 'wxid_synthetic', kind: 'followup', taskId: 'task-one', status, message: { id: 'task-one', text: '商家主动跟进', date: '2026-11-07' }, reply: '您好，最近使用体验怎么样？', createdAt: '2026-11-07', updatedAt: '2026-11-07', ...(status === 'sent' ? { sendMessageId: '12345' } : {}) });

test('只准备已保存任务正文，演示、未选、人工、关闭和空/过长话术明确阻断', () => {
  const saved = state();
  assert.deepEqual(prepareSavedFollowup(saved, 'task-one'), { taskId: 'task-one', customerId: 'c1', text: saved.tasks[0].script });
  for (const change of [
    (value: AppState) => { value.customers[0].source = 'demo'; },
    (value: AppState) => { value.customers[0].humanTakeover = true; },
    (value: AppState) => { value.customers[0].autoReplyEnabled = false; },
    (value: AppState) => { value.replySettings!.selectedCustomerIds = []; },
    (value: AppState) => { value.replySettings!.enabled = false; },
    (value: AppState) => { value.tasks[0].script = ' '; },
    (value: AppState) => { value.tasks[0].script = '中'.repeat(301); },
    (value: AppState) => { value.tasks[0].status = 'done'; },
  ]) { const invalid = structuredClone(saved); change(invalid); assert.ok(followupBlockReason(invalid, invalid.tasks[0])); assert.throws(() => prepareSavedFollowup(invalid, 'task-one')); }
});

test('仅本条sent且正文/客户/回执完整时完成，余下跟进日期与其他资料保留', () => {
  const saved = state(), before = structuredClone(saved);
  for (const status of ['ready', 'sending', 'unknown', 'failed'] as const) assert.throws(() => applyFollowupReceipt(saved, 'task-one', receipt(status)), /凭据/);
  assert.throws(() => applyFollowupReceipt(saved, 'task-one', { ...receipt(), taskId: 'another-task' }), /凭据/);
  assert.throws(() => applyFollowupReceipt(saved, 'task-one', { ...receipt(), reply: '不同的合成正文' }), /话术已变化/);
  const next = applyFollowupReceipt(saved, 'task-one', receipt());
  assert.equal(next.tasks[0].status, 'done'); assert.equal(next.tasks[1].status, 'todo'); assert.equal(next.customers[0].nextFollowUpAt, '2026-11-10');
  assert.deepEqual(saved, before); assert.equal(applyFollowupReceipt(next, 'task-one', receipt()), next);
});

test('仅有限查询当前job，终态立即停止，等待耗尽不伪造sent', async () => {
  const queried: string[] = []; let waits = 0;
  const job = await observeFollowup('synthetic-job', async id => { queried.push(id); return receipt(queried.length < 3 ? 'sending' : 'sent'); }, new AbortController().signal, { maxAttempts: 10, wait: async () => { waits++; } });
  assert.equal(job?.status, 'sent'); assert.deepEqual(queried, ['synthetic-job', 'synthetic-job', 'synthetic-job']); assert.equal(waits, 2);
  let calls = 0;
  const pending = await observeFollowup('synthetic-job', async () => { calls++; return receipt('ready'); }, new AbortController().signal, { maxAttempts: 2, wait: async () => {} });
  assert.equal(calls, 2); assert.equal(pending?.status, 'ready');
  const aborted = new AbortController(); aborted.abort(new Error('合成页面退出'));
  await assert.rejects(() => observeFollowup('synthetic-job', async () => { throw new Error('不应再查询'); }, aborted.signal), /页面退出/);
});
