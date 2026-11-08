import assert from 'node:assert/strict';
import test from 'node:test';
import type { Customer } from '../lib/types.ts';
import { customerContactTimestamp, recentCustomerMessageCount, sortCustomers } from '../features/customers/customer-sorting.ts';

const now = Date.parse('2026-11-07T12:00:00.000Z');
const customer = (id: string, lastContactAt = '', messages: Customer['messages'] = []): Customer => ({ id, name: id, wechatId: `wxid_${id}`, color: '#000', stage: '新客户', tags: [], manualTags: [], summary: '', preferences: '', budget: '', note: '', createdAt: '2026-10-01', lastContactAt, nextFollowUpAt: '', source: 'wechat', evidence: [], messages });
const message = (id: string, date: string, sender: 'customer' | 'merchant' = 'customer') => ({ id, date, sender, text: '合成消息' });
const ids = (rows: Customer[]) => rows.map(row => row.id);

test('按最近联系日期升降序，未知和无效日期始终排在有效日期之后', () => {
  const rows = [customer('unknown'), customer('new', '2026-11-07'), customer('invalid', '2026-02-31'), customer('old', '2026-10-08')];
  assert.deepEqual(ids(sortCustomers(rows, 'date-asc', now)), ['old', 'new', 'unknown', 'invalid']);
  assert.deepEqual(ids(sortCustomers(rows, 'date-desc', now)), ['new', 'old', 'unknown', 'invalid']);
  assert.deepEqual(ids(rows), ['unknown', 'new', 'invalid', 'old'], '排序不修改原数组');
  assert.equal(customerContactTimestamp(rows[2]), null);
});

test('按真实时间处理不同时区，日期相同时保留原有顺序', () => {
  const rows = [customer('utc', '2026-11-06T16:30:00Z'), customer('shanghai', '2026-11-07T00:00:00+08:00'), customer('date-only', '2026-11-07')];
  assert.deepEqual(ids(sortCustomers(rows, 'date-asc', now)), ['shanghai', 'date-only', 'utc']);
  assert.deepEqual(ids(sortCustomers(rows, 'date-desc', now)), ['utc', 'shanghai', 'date-only']);
});

test('近30天活跃度只计算客户发来的消息，排除旧、未来和无效时间', () => {
  const recent = customer('recent', '', [
    message('boundary', '2026-10-08T12:00:00.000Z'),
    message('now', '2026-11-07T12:00:00.000Z'),
    message('old', '2026-10-08T11:59:59.999Z'),
    message('future', '2026-11-07T12:00:00.001Z'),
    message('merchant', '2026-11-07T11:00:00Z', 'merchant'),
    message('missing', ''), message('invalid', '2026-11-31T12:00:00Z'),
  ]);
  assert.equal(recentCustomerMessageCount(recent, now), 2);
  assert.equal(recentCustomerMessageCount(customer('quiet', '', [message('old', '2026-10-01')]), now), 0);
});

test('活跃度优先消息数量，相同数量按最近联系排序并将未知日期放在同组末尾', () => {
  const rows = [customer('quiet', '2026-11-07'), customer('unknown', '', [message('a', '2026-11-01')]), customer('older', '2026-11-01', [message('b', '2026-11-01')]), customer('busy', '2026-10-10', [message('c', '2026-11-01'), message('d', '2026-11-02')]), customer('newer', '2026-11-06', [message('e', '2026-11-01')])];
  assert.deepEqual(ids(sortCustomers(rows, 'activity-desc', now)), ['busy', 'newer', 'older', 'unknown', 'quiet']);
});
