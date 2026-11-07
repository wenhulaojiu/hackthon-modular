import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createReplyAdapter } from '../scripts/local-wechat/reply-adapter.mjs';

const config = () => ({ settings: { mode: 'review', selectedCustomerIds: ['c1'] }, customers: [{ id: 'c1', wechatId: 'wxid_customer', autoReplyEnabled: true }] });
const ready = { configured: true, pythonReady: true, exporterReady: true };
const native = (server_id, timestamp, extra = {}) => ({ server_id, local_id: 1, source_database: 'message_0.db', timestamp, local_type: '1', sender: '客户', sender_username: 'wxid_customer', content: '请问价格？', ...extra });

async function fixture(t, options = {}) {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'kexu-adapter-test-'));
  await mkdir(path.join(root, '.local-wechat'));
  let timestamp = Date.parse('2026-11-07T03:00:00Z');
  let messages = [];
  const reads = [];
  const reader = { inspect: async () => ready, readForReplies: async ids => { reads.push(ids); return [{ metadata: { chat_type: 'private', chat_username: 'wxid_customer' }, messages }]; } };
  const adapter = createReplyAdapter({ root, reader, now: () => timestamp, ...options });
  t.after(async () => {
    adapter.pause();
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('kexu-adapter-test-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return { adapter, root, reads, setTime: value => { timestamp = value; }, setMessages: value => { messages = value; }, gateway: value => writeFile(path.join(root, '.local-wechat', 'reply-adapter.json'), JSON.stringify(value), 'utf8') };
}

test('默认不连接发送服务、不读取聊天，缺发送器拒绝自动模式', async t => {
  let requests = 0;
  const f = await fixture(t, { fetch: async () => { requests++; throw Error('不应请求'); } });
  assert.equal((await f.adapter.status()).canReceive, true);
  assert.equal((await f.adapter.status()).canSend, false);
  assert.deepEqual(await f.adapter.poll(), []);
  await assert.rejects(f.adapter.start({ ...config(), settings: { ...config().settings, mode: 'auto' } }), /自动发送尚未接通/);
  assert.equal(requests, 0);
  assert.equal(f.reads.length, 0);
});

test('轮询仅白名单并保留原生消息身份，严格标记角色和非文本', async t => {
  const f = await fixture(t);
  await f.adapter.start(config());
  const base = Date.parse('2026-11-07T03:00:00Z');
  f.setTime(base + 4000);
  f.setMessages([native('old', base / 1000 - 1), native('11', base / 1000 + 1), native('12', base / 1000 + 2, { sender: '我', sender_username: 'wxid_owner' }), native('13', base / 1000 + 3, { sender_username: 'unknown' }), native('14', base / 1000 + 3, { local_type: '49' })]);
  const events = await f.adapter.poll();
  assert.equal(events.length, 4);
  assert.deepEqual(events.map(e => e.sender), ['customer', 'merchant', 'system', 'customer']);
  assert.equal(events.at(-1).kind, 'unsupported');
  assert.deepEqual(f.reads, [['wxid_customer']]);
  assert.equal((await f.adapter.poll())[0].id, events[0].id);
  f.adapter.pause();
  assert.deepEqual(await f.adapter.poll(), []);
});

test('拒绝远端网关、库存Weix不完整响应与错误会话证明', async t => {
  const f = await fixture(t, { fetch: async () => new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } }) });
  await f.gateway({ type: 'verified-http', baseUrl: 'http://example.com:8000', token: 'synthetic-local-token' });
  assert.equal((await f.adapter.status({ probe: true })).canSend, false);
  assert.match((await f.adapter.status()).message, /回环/);
  await f.gateway({ type: 'verified-http', baseUrl: 'http://127.0.0.1:8000', token: 'synthetic-local-token' });
  assert.equal((await f.adapter.status({ probe: true })).canSend, false);
  await f.adapter.start(config());
  assert.equal((await f.adapter.send({ chatId: 'wxid_customer', text: '草稿', idempotencyKey: 'test' })).status, 'unknown');
});

test('匹配消息ID、会话和正文哈希回读才标sent；超时不重发', async t => {
  let sends = 0;
  let timeout = false;
  const f = await fixture(t, { fetch: async (url, input) => {
    if (url.endsWith('/status')) return Response.json({ protocol: 'kexu-reply-v1', ready: true, capabilities: { stableChatIds: true, readback: true, idempotentSend: true } });
    sends++;
    if (timeout) throw Error('模拟发送后网络断开');
    const body = JSON.parse(input.body);
    return Response.json({ status: 'sent', chatId: body.chatId, messageId: 'native-123', textSha256: createHash('sha256').update(body.text).digest('hex'), readback: true });
  } });
  await f.gateway({ type: 'verified-http', baseUrl: 'http://127.0.0.1:8000', token: 'synthetic-local-token' });
  await f.adapter.start({ ...config(), settings: { ...config().settings, mode: 'auto' } });
  assert.deepEqual(await f.adapter.send({ chatId: 'wxid_customer', text: '你好', idempotencyKey: 'one' }), { status: 'sent', messageId: 'native-123' });
  timeout = true;
  assert.equal((await f.adapter.send({ chatId: 'wxid_customer', text: '你好', idempotencyKey: 'two' })).status, 'unknown');
  assert.equal(sends, 2);
  assert.equal((await f.adapter.send({ chatId: 'wxid_outside', text: '你好', idempotencyKey: 'three' })).status, 'failed');
  assert.equal(sends, 2);
});
