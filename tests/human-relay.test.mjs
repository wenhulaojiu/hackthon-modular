import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHumanRelay, parseRelayAnswer } from '../scripts/local-wechat/human-relay.mjs';

async function fixture(t, overrides = {}) {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'kexu-relay-')); t.after(() => rm(directory, { recursive: true, force: true }));
 const clock = 1800000000000; const sent = [], answers = [], jobs = []; let incoming = [];
 const config = { customers: [{ id: 'customer-1', wechatId: 'wxid_customer', name: '测试客户' }] };
 const engine = { getConfig: async () => config, status: async () => ({ running: true }), relayJobs: async () => jobs, takeover: async () => {}, getJob: async id => jobs.find(j => j.id === id) };
 const options = { directory, engine, now: () => clock, reader: { readForReplies: async () => [{ metadata: { chat_type: 'private', chat_username: 'wxid_sales' }, messages: incoming }] }, notify: async input => { sent.push(input); return { status: 'sent', messageId: '100' }; }, answer: async input => { answers.push(input); return { id: 'manual-1', status: 'sent' }; }, ...overrides };
 const relay = await createHumanRelay(options); await relay.configure({ enabled: true, salesChatId: 'wxid_sales' });
 jobs.push({ id: 'source-1', kind: 'reply', status: 'handoff', customerId: 'customer-1', chatId: 'wxid_customer', message: { text: '需要人工解答' }, createdAt: new Date(clock).toISOString() });
 return { relay, sent, answers, jobs, config, options, directory, clock, incoming: value => { incoming = value; }, message: (id, text = '人工答案') => ({ sender: '销售', sender_username: 'wxid_sales', local_type: 1, server_id: '200', timestamp: clock / 1000 + 1, content: '#' + id + ' ' + text }) };
}
test('答案必须包含完整问题编号，拒绝空正文与超长内容', () => {
 assert.equal(parseRelayAnswer('可以退货'), null);
 assert.equal(parseRelayAnswer('#123 你好'), null);
 assert.equal(parseRelayAnswer('#12345678-1234-1234-1234-123456789abc ' + '字'.repeat(301)), null);
 assert.equal(parseRelayAnswer('#12345678-1234-1234-1234-123456789abc 可以').text, '可以');
});
test('难题通知A、A带编号作答、原任务回传，重复扫描不重发', async t => {
 const f = await fixture(t); await f.relay.tick(); const ticket = f.relay.status().tickets[0];
 assert.equal(f.sent[0].chatId, 'wxid_sales'); assert.equal(ticket.status, 'waiting');
 f.incoming([f.message(ticket.id)]); await f.relay.tick(); await f.relay.tick();
 assert.equal(f.answers.length, 1); assert.equal(f.answers[0].jobId, 'source-1'); assert.equal(f.relay.status().tickets[0].status, 'sent'); assert.equal(f.sent.length, 1);
});
test('其他发送者、商户回声、未知编号、启用前消息均不能回传', async t => {
 const f = await fixture(t); await f.relay.tick(); const id = f.relay.status().tickets[0].id;
 f.incoming([{ ...f.message(id), sender_username: 'wxid_other' }, { ...f.message(id), sender: '我' }, { ...f.message(id), timestamp: f.clock / 1000 - 10 }, f.message('12345678-1234-1234-1234-123456789abc')]); await f.relay.tick(); assert.equal(f.answers.length, 0);
});
test('通知异常在重启后仍不重发', async t => {
 const f = await fixture(t, { notify: async () => { throw new Error('超时'); } }); await f.relay.tick();
 assert.equal(f.relay.status().tickets[0].status, 'unknown');
 const restarted = await createHumanRelay(f.options); await restarted.tick(); assert.equal(restarted.status().tickets.length, 1); assert.equal(restarted.status().tickets[0].status, 'unknown');
});
test('A不能是客户，停用后不接受此前待答问题', async t => {
 const f = await fixture(t); await assert.rejects(f.relay.configure({ enabled: true, salesChatId: 'wxid_customer' }));
 await f.relay.tick(); const id = f.relay.status().tickets[0].id; await f.relay.configure({ enabled: false, salesChatId: 'wxid_sales' }); f.incoming([f.message(id)]); await f.relay.tick(); assert.equal(f.answers.length, 0); assert.equal(f.relay.status().tickets[0].status, 'cancelled');
});
test('客户出现新问题后旧答案必须人工复核', async t => {
 const f = await fixture(t); await f.relay.tick(); const id = f.relay.status().tickets[0].id;
 f.jobs.push({ ...f.jobs[0], id: 'new-source', createdAt: new Date(f.clock + 1000).toISOString(), status: 'queued' });
 f.incoming([f.message(id)]); await f.relay.tick(); assert.equal(f.answers.length, 0); assert.equal(f.relay.status().tickets[0].status, 'needs_review');
});
test('旧历史难题不补发，重复并发tick只通知一次', async t => {
 const f = await fixture(t); f.jobs[0].createdAt = new Date(f.clock - 1000).toISOString(); await f.relay.tick(); assert.equal(f.sent.length, 0);
 f.jobs[0].createdAt = new Date(f.clock).toISOString(); await Promise.all([f.relay.tick(), f.relay.tick()]); assert.equal(f.sent.length, 1);
});
test('发送意图持久化后再调用外部发送，失败不自动重发', async t => {
 const f = await fixture(t); await f.relay.tick(); const id = f.relay.status().tickets[0].id;
 f.options.answer = async () => { const saved = JSON.parse(await readFile(path.join(f.directory, 'human-relay.json'), 'utf8')); assert.equal(saved.tickets[0].status, 'answering'); throw new Error('未知结果'); };
 const relay = await createHumanRelay(f.options); f.incoming([f.message(id)]); await relay.tick(); assert.equal(relay.status().tickets[0].status, 'unknown');
});
