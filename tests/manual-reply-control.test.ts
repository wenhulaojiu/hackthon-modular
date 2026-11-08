import assert from 'node:assert/strict';
import test from 'node:test';
import { assertManualReceipt, manualAutoResumeConfirmed, manualReplyError, manualReplyTerminal, observeManualReply, parseManualReplyRecord, prepareManualAttempt, replyJobResolved, replyQueueJobs, type ManualAttempt } from '../features/auto-reply/manual-reply-control.ts';
import type { ReplyJobView } from '../lib/types.ts';

const source: ReplyJobView = { id: 'd574cc3e-4790-42a0-a374-dc056968d9c0', customerId: 'synthetic-customer', chatId: 'wxid_synthetic', kind: 'reply', status: 'handoff', message: { id: 'synthetic-message', text: '合成客户问题', date: '2026-11-07T00:00:00Z' }, createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' };
const attempt: ManualAttempt = { sourceJobId: source.id, requestId: '5b5e8855-98c5-42b6-b891-63c039666ac2', text: '这款是原味软面包。', status: 'submitted' };
const job = (status: ReplyJobView['status'] = 'sent'): ReplyJobView => ({ ...source, id: '161c56a0-2a84-49b7-8d9f-60c31dc7d9cc', kind: 'manual', sourceJobId: source.id, requestId: attempt.requestId, status, reply: attempt.text, ...(status === 'sent' ? { sendMessageId: 'synthetic-native-id' } : {}) });

test('手动回复校验长度和字符；未确认请求复用标识与原文，不能换正文或重发未知正文', () => {
  assert.equal(manualReplyError('中'.repeat(300)), null);
  for (const text of ['', ' ', '中'.repeat(301), '\uD800', '含\0空字符']) assert.ok(manualReplyError(text));
  let ids = 0;
  const previous = { ...attempt, status: 'unknown' as const };
  assert.equal(prepareManualAttempt(source.id, attempt.text, previous, [], () => { ids++; return '不应生成'; }), previous);
  assert.equal(ids, 0);
  assert.throws(() => prepareManualAttempt(source.id, '另一段回复', previous, [], () => '不应生成'), /原请求/);
  assert.throws(() => prepareManualAttempt(source.id, attempt.text, null, [attempt.text], () => '不应生成'), /不会重复发送/);
  assert.equal(prepareManualAttempt(source.id, '另一段回复', null, [attempt.text], () => attempt.requestId).requestId, attempt.requestId);
});

test('刷新恢复只接受本卡片的有效尝试；发送回执核对客户、原任务、正文及原生ID', () => {
  const record = { attempt, blockedTexts: [] };
  assert.deepEqual(parseManualReplyRecord(JSON.stringify(record), source.id), record);
  assert.equal(parseManualReplyRecord(JSON.stringify(record), 'another-source').attempt, null);
  assert.equal(parseManualReplyRecord('{broken', source.id).attempt, null);
  assert.doesNotThrow(() => assertManualReceipt(job(), source, attempt));
  for (const patch of [{ customerId: 'another' }, { chatId: 'another' }, { sourceJobId: 'another' }, { requestId: 'another' }, { reply: '不同正文' }, { sendMessageId: '' }]) assert.throws(() => assertManualReceipt({ ...job(), ...patch }, source, attempt), /回执不匹配/);
});

test('手动回复只轮询原任务，终态及时停止，断线或达到上限不会再次提交或伪造成功', async () => {
  const queried: string[] = [];
  const expected = { ...attempt, jobId: job().id };
  const result = await observeManualReply(source, expected, async id => { queried.push(id); return job(queried.length === 2 ? 'sent' : 'sending'); }, new AbortController().signal, { wait: async () => {} });
  assert.equal(result?.status, 'sent');
  assert.deepEqual(queried, [job().id, job().id]);
  const pending = await observeManualReply(source, expected, async () => job('sending'), new AbortController().signal, { maxAttempts: 2, wait: async () => {} });
  assert.equal(pending?.status, 'sending');
  await assert.rejects(() => observeManualReply(source, expected, async () => { throw new Error('合成断线'); }, new AbortController().signal), /断线/);
  const aborted = new AbortController(); aborted.abort(new Error('工作区切换'));
  await assert.rejects(() => observeManualReply(source, expected, async () => job(), aborted.signal), /工作区切换/);
});

test('源卡片在精确的人工发送与托管恢复双重确认后才移出队列，历史和其他客户保留', () => {
  const resolved = { ...source, resolvedAt: '2026-11-07T01:00:00Z', resolvedByManualJobId: job().id };
  const manual = { ...job(), autoResumeStatus: 'restored' as const };
  const other = { ...source, id: 'f1a6a7d5-15c8-4213-acdc-16c44172463f', customerId: 'other-customer', chatId: 'wxid_other' };
  const rows = [manual, resolved, other];
  assert.equal(replyJobResolved(resolved, rows), true);
  assert.deepEqual(replyQueueJobs(rows), [other]);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].reason, source.reason);
  assert.equal(manualAutoResumeConfirmed(manual), true);
  for (const patch of [{ autoResumeStatus: 'pending' as const }, { autoResumeStatus: 'blocked' as const }, { autoResumeStatus: undefined }, { sendMessageId: '' }, { sourceJobId: other.id }, { customerId: other.customerId }, { chatId: other.chatId }]) {
    const incomplete = [resolved, { ...manual, ...patch }];
    assert.deepEqual(replyQueueJobs(incomplete), [resolved]);
  }
  assert.equal(replyJobResolved({ ...resolved, resolvedAt: 'invalid-date' }, rows), false);
  assert.equal(replyJobResolved({ ...resolved, resolvedByManualJobId: undefined }, rows), false);
  assert.equal(replyJobResolved(resolved, [resolved]), false);
});

test('人工发送未决或失败不隐藏源卡片，旧发送回执未确认托管时也不误报完成', () => {
  for (const status of ['draft', 'ready', 'sending', 'unknown', 'failed', 'handoff'] as const) {
    const manual = { ...job(status), autoResumeStatus: 'restored' as const };
    const claimed = { ...source, resolvedAt: '2026-11-07T01:00:00Z', resolvedByManualJobId: manual.id };
    assert.equal(manualAutoResumeConfirmed(manual), false);
    assert.deepEqual(replyQueueJobs([manual, claimed]), [claimed]);
  }
  assert.equal(manualAutoResumeConfirmed(job()), false);
});

test('微信已发送但托管恢复中只查询同一请求，恢复确认后才结束观察', async () => {
  const expected = { ...attempt, jobId: job().id };
  const pending = { ...job(), autoResumeStatus: 'pending' as const };
  const restored = { ...job(), autoResumeStatus: 'restored' as const };
  assert.equal(manualReplyTerminal(pending), false);
  assert.equal(manualReplyTerminal(restored), true);
  assert.equal(manualReplyTerminal({ ...job(), autoResumeStatus: 'blocked' }), true);
  const querying: string[] = [];
  const result = await observeManualReply(source, expected, async id => { querying.push(id); return querying.length === 1 ? pending : restored; }, new AbortController().signal, { wait: async () => {} });
  assert.equal(result?.autoResumeStatus, 'restored');
  assert.deepEqual(querying, [job().id, job().id]);
  const restoring = { ...attempt, jobId: job().id, status: 'restoring' as const };
  assert.equal(parseManualReplyRecord(JSON.stringify({ attempt: restoring, blockedTexts: [] }), source.id).attempt?.status, 'restoring');
  assert.equal(prepareManualAttempt(source.id, attempt.text, restoring, [], () => { throw new Error('不能创建新请求'); }), restoring);
});
