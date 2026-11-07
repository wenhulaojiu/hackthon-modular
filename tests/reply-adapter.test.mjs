import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createReplyAdapter } from '../scripts/local-wechat/reply-adapter.mjs';
import { createReplyEngine, DEFAULT_REPLY_SETTINGS } from '../scripts/local-wechat/reply-engine.mjs';

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
    await adapter.pause();
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('kexu-adapter-test-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return { adapter, root, reads, now: () => timestamp, setTime: value => { timestamp = value; }, setMessages: value => { messages = value; }, gateway: value => writeFile(path.join(root, '.local-wechat', 'reply-adapter.json'), JSON.stringify(value), 'utf8') };
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

async function scopedFixture(t, acceptUnprefixedTestMessages) {
  const workspace = { id: 'acct-0123456789abcdef0123', workspaceToken: 'acct-0123456789abcdef0123@2' };
  let currentWorkspace = workspace.workspaceToken;
  const grant = { type: 'scoped-test-http', baseUrl: 'http://127.0.0.1:8000', token: 'synthetic-scoped-token', workspaceToken: workspace.workspaceToken, allowedChatIds: ['wxid_customer'], expiresAt: '2026-11-07T03:05:00.000Z', maxSends: 3, testPrefix: '【自测adapter】', ...(acceptUnprefixedTestMessages !== undefined ? { acceptUnprefixedTestMessages } : {}) };
  let report = { protocol: 'kexu-reply-v1', ready: true, workspaceToken: workspace.workspaceToken, allowedChatIds: ['wxid_customer'], expiresAt: grant.expiresAt, remainingSends: 3, capabilities: { stableChatIds: false, scopedStableChatIds: true, readback: true, idempotentSend: true, scopeRestricted: true }, ...(acceptUnprefixedTestMessages === true ? { acceptUnprefixedTestMessages: true } : {}) };
  let receiptScope = workspace.workspaceToken;
  let disconnect = false;
  let beforeProbe;
  const sends = [];
  const f = await fixture(t, { workspace, currentWorkspace: () => currentWorkspace, fetch: async (url, input) => {
    if (url.endsWith('/status')) { await beforeProbe?.(); return Response.json(report); }
    const body = JSON.parse(input.body); sends.push(body);
    if (disconnect) throw Error('合成发送断连');
    return Response.json({ status: 'sent', chatId: body.chatId, workspaceToken: receiptScope, messageId: `native-scoped-${sends.length}`, textSha256: createHash('sha256').update(body.text).digest('hex'), readback: true });
  } });
  await f.gateway(grant);
  return { ...f, grant, workspace, sends, setReport: value => { report = { ...report, ...value }; }, setCurrent: value => { currentWorkspace = value; }, setReceiptScope: value => { receiptScope = value; }, setDisconnect: value => { disconnect = value; }, beforeProbe: callback => { beforeProbe = callback; } };
}

const autoConfig = () => ({ ...config(), settings: { ...config().settings, mode: 'auto' } });
const sendInput = key => ({ chatId: 'wxid_customer', text: '面包10元。', idempotencyKey: key });

test('受限ready不能泛化：先保存唯一客户review配置，再允许该客户auto启动', async t => {
  const f = await scopedFixture(t);
  assert.equal((await f.adapter.status({ probe: true })).canSend, false);
  f.adapter.syncConfig(config());
  assert.equal((await f.adapter.status({ probe: true })).canSend, true);
  await f.adapter.start(autoConfig());
  assert.equal((await f.adapter.send(sendInput('one'))).status, 'sent');
  assert.equal(f.sends[0].workspaceToken, f.workspace.workspaceToken);
  assert.equal(f.sends.length, 1);
});

test('临时测试拒绝多选、错误客户和重复映射，不能读取额外会话', async t => {
  const f = await scopedFixture(t);
  const multiple = autoConfig();
  multiple.settings.selectedCustomerIds.push('c2');
  multiple.customers.push({ id: 'c2', wechatId: 'wxid_other', autoReplyEnabled: true });
  await assert.rejects(f.adapter.start(multiple), /唯一/);
  const wrong = autoConfig(); wrong.customers[0].wechatId = 'wxid_other';
  await assert.rejects(f.adapter.start(wrong), /授权私聊/);
  const duplicate = autoConfig(); duplicate.customers.push({ id: 'c2', wechatId: 'wxid_customer', autoReplyEnabled: true });
  await assert.rejects(f.adapter.start(duplicate), /唯一映射/);
  await f.adapter.start(autoConfig());
  f.adapter.syncConfig(multiple);
  assert.equal((await f.adapter.send(sendInput('blocked'))).status, 'failed');
  await assert.rejects(f.adapter.poll(), /唯一/);
  assert.equal(f.sends.length, 0);
  assert.equal(f.reads.length, 0);
});

test('每次发送重查scope、唯一名单、期限、配额及受限能力', async t => {
  const scenarios = [
    { workspaceToken: 'acct-0123456789abcdef0123@3' },
    { allowedChatIds: ['wxid_customer', 'wxid_other'] },
    { allowedChatIds: ['wxid_other'] },
    { expiresAt: '2026-11-07T03:06:00.000Z' },
    { remainingSends: 0 },
    { remainingSends: 4 },
    { ready: false },
    { testPrefix: '【其他测试】' },
    { capabilities: { stableChatIds: true, scopedStableChatIds: true, readback: true, idempotentSend: true, scopeRestricted: true } },
  ];
  for (const changed of scenarios) await t.test(JSON.stringify(changed), async child => {
    const f = await scopedFixture(child);
    await f.adapter.start(autoConfig());
    f.setReport(changed);
    assert.equal((await f.adapter.send(sendInput('blocked'))).status, 'failed');
    assert.equal(f.sends.length, 0);
  });
});

test('临时测试仅接收带固定前缀的新客户纯文本，保留商户回声用于防重和接管', async t => {
  const f = await scopedFixture(t);
  await f.adapter.start(autoConfig());
  f.setTime(f.now() + 3000);
  const time = f.now() / 1000;
  f.setMessages([
    native('201', time, { content: '普通私聊和旧记录不进入本次模型' }),
    native('202', time, { content: `${f.grant.testPrefix}面包多少钱？` }),
    native('203', time, { content: `前面另有文字${f.grant.testPrefix}也不触发` }),
    native('204', time, { content: `${f.grant.testPrefix}非文本`, local_type: '49' }),
    native('205', time, { content: '面包10元。', sender: '我', sender_username: 'wxid_owner' }),
    native('206', time, { content: `${f.grant.testPrefix}未知作者`, sender_username: 'unknown' }),
  ]);
  const events = await f.adapter.poll();
  assert.deepEqual(events.map(event => [event.nativeMessageId, event.sender]).sort((a, b) => a[0].localeCompare(b[0])), [['202', 'customer'], ['205', 'merchant']]);
  await f.gateway({ ...f.grant, testPrefix: '【另一次测试】' });
  assert.equal((await f.adapter.send(sendInput('changed-prefix'))).status, 'failed');
  assert.equal(f.sends.length, 0);
});

test('明确双重授权允许唯一测试号启动后的无前缀纯文本，不重放旧消息', async t => {
  const f = await scopedFixture(t, true);
  const started = f.now();
  await f.adapter.start(autoConfig());
  f.setTime(started + 3000);
  f.setMessages([
    native('301', started / 1000 - 1, { content: '启动前的问题不能重放' }),
    native('302', started / 1000 + 1, { content: '我想咨询面包' }),
    native('303', started / 1000 + 2, { content: '面包多少钱一份' }),
    native('304', started / 1000 + 2, { content: '非文本不触发', local_type: '49' }),
    native('305', started / 1000 + 3, { content: '面包10元。', sender: '我', sender_username: 'wxid_owner' }),
    native('306', started / 1000 + 3, { content: '未知作者不触发', sender_username: 'unknown' }),
  ]);
  const events = await f.adapter.poll();
  assert.deepEqual(events.map(event => event.text), ['我想咨询面包', '面包多少钱一份', '面包10元。']);
  assert.deepEqual(f.reads, [['wxid_customer']]);
  assert.equal(f.sends.length, 0);
});

test('无前缀授权必须为真布尔值且由网关准确回显，ready不能代替授权', async t => {
  for (const reported of [undefined, false, 'true']) await t.test(`网关回显${String(reported)}`, async child => {
    const f = await scopedFixture(child, true);
    f.setReport({ acceptUnprefixedTestMessages: reported });
    await assert.rejects(f.adapter.start(autoConfig()), /无前缀授权/);
    assert.equal(f.reads.length, 0);
  });
  for (const configured of [false, undefined, 'true', null]) await t.test(`本地配置${String(configured)}`, async child => {
    const f = await scopedFixture(child, configured);
    f.setReport({ acceptUnprefixedTestMessages: true });
    await assert.rejects(f.adapter.start(autoConfig()), /无前缀授权/);
    assert.equal(f.reads.length, 0);
  });
});

test('无前缀模式每次入队前复验网关授权，撤销、换号、扩大名单或配额耗尽均不返回消息', async t => {
  for (const changed of [{ acceptUnprefixedTestMessages: false }, { workspaceToken: 'acct-0123456789abcdef0123@3' }, { allowedChatIds: ['wxid_customer', 'wxid_other'] }, { remainingSends: 0 }]) await t.test(JSON.stringify(changed), async child => {
    const f = await scopedFixture(child, true);
    await f.adapter.start(autoConfig());
    f.setTime(f.now() + 1000);
    f.setMessages([native('401', f.now() / 1000, { content: '面包多少钱一份' })]);
    f.setReport(changed);
    await assert.rejects(f.adapter.poll(), /授权|核验失败/);
    assert.equal(f.sends.length, 0);
  });
});

test('运行中不能从前缀授权扩大到无前缀，重新启动仍以新基线忽略此前问题', async t => {
  const f = await scopedFixture(t);
  await f.adapter.start(autoConfig());
  f.setTime(f.now() + 2000);
  const previousTime = f.now() / 1000 - 1;
  f.setMessages([native('501', previousTime, { content: '我想咨询面包' })]);
  await f.gateway({ ...f.grant, acceptUnprefixedTestMessages: true });
  f.setReport({ acceptUnprefixedTestMessages: true });
  assert.deepEqual(await f.adapter.poll(), []);
  assert.equal((await f.adapter.send(sendInput('changed-flag'))).status, 'failed');
  await f.adapter.start(autoConfig());
  assert.deepEqual(await f.adapter.poll(), []);
  f.setTime(f.now() + 1000);
  f.setMessages([native('501', previousTime, { content: '我想咨询面包' }), native('502', f.now() / 1000, { content: '面包多少钱一份' })]);
  assert.deepEqual((await f.adapter.poll()).map(event => event.nativeMessageId), ['502']);
  assert.equal(f.sends.length, 0);
});

test('固定无前缀授权运行中被本地收窄时不继续入队', async t => {
  const f = await scopedFixture(t, true);
  await f.adapter.start(autoConfig());
  await f.gateway({ ...f.grant, acceptUnprefixedTestMessages: false });
  await assert.rejects(f.adapter.poll(), /无前缀授权已变化/);
  assert.equal((await f.adapter.send(sendInput('narrowed-flag'))).status, 'failed');
  assert.equal(f.sends.length, 0);
});

test('固定授权拒绝延长窗口、扩大额度、切换工作区和运行中降级到通用网关', async t => {
  for (const change of [{ expiresAt: '2026-11-07T03:05:01.000Z' }, { maxSends: 4 }, { allowedChatIds: ['wxid_customer', 'wxid_other'] }]) await t.test(JSON.stringify(change), async child => {
    const f = await scopedFixture(child);
    await f.gateway({ ...f.grant, ...change });
    await assert.rejects(f.adapter.start(autoConfig()));
    assert.equal(f.sends.length, 0);
  });
  const f = await scopedFixture(t);
  await f.adapter.start(autoConfig());
  await f.gateway({ type: 'verified-http', baseUrl: f.grant.baseUrl, token: f.grant.token });
  assert.equal((await f.adapter.send(sendInput('downgrade'))).status, 'failed');
  await f.gateway(f.grant);
  f.setCurrent('acct-0123456789abcdef0123@3');
  assert.equal((await f.adapter.send(sendInput('old-scope'))).status, 'failed');
  assert.equal(f.sends.length, 0);
});

test('发送预检期间暂停、变更客户或到期均不发POST', async t => {
  for (const action of ['pause', 'selection', 'expiry']) await t.test(action, async child => {
    const f = await scopedFixture(child);
    await f.adapter.start(autoConfig());
    f.beforeProbe(() => {
      if (action === 'pause') f.adapter.pause();
      if (action === 'selection') { const next = autoConfig(); next.customers[0].wechatId = 'wxid_other'; f.adapter.syncConfig(next); }
      if (action === 'expiry') f.setTime(Date.parse(f.grant.expiresAt));
    });
    assert.equal((await f.adapter.send(sendInput('late'))).status, 'failed');
    assert.equal(f.sends.length, 0);
  });
});

test('串行发送最多尝试三条；同幂等标识回用结果，未知回执也占额度且不重发', async t => {
  const f = await scopedFixture(t);
  await f.adapter.start(autoConfig());
  assert.equal((await f.adapter.send(sendInput('one'))).status, 'sent');
  assert.equal((await f.adapter.send(sendInput('one'))).status, 'sent');
  f.setReceiptScope('acct-0123456789abcdef0123@3');
  assert.equal((await f.adapter.send(sendInput('two'))).status, 'unknown');
  assert.equal((await f.adapter.send(sendInput('two'))).status, 'unknown');
  f.setDisconnect(true);
  const outcomes = await Promise.all([f.adapter.send(sendInput('three')), f.adapter.send(sendInput('four'))]);
  assert.deepEqual(outcomes.map(value => value.status), ['unknown', 'failed']);
  assert.equal(f.sends.length, 3);
  assert.equal((await f.adapter.send({ ...sendInput('one'), text: '不同内容' })).status, 'failed');
});

test('生产引擎auto接收新消息后自动生成并经受限适配器发送，无人工approve', async t => {
  const f = await scopedFixture(t);
  const settings = { ...structuredClone(DEFAULT_REPLY_SETTINGS), enabled: true, mode: 'auto', selectedCustomerIds: ['c1'], debounceSeconds: 0, cooldownSeconds: 5, businessHours: { enabled: false, start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5, 6] } };
  const value = { settings, customers: [{ ...config().customers[0], name: '合成测试客户' }], products: [{ id: 'bread', name: '面包', type: 'product', price: 10, description: '测试商品资料', faq: [], enabled: true }], storeName: '合成测试店铺', industry: '零售' };
  let generated = 0;
  const engine = await createReplyEngine({ directory: path.join(f.root, '.local-wechat', 'synthetic-engine'), now: f.now, tickMs: 10, generate: async () => { generated += 1; return { action: 'reply', reply: '面包10元。', reason: '根据已配置商品价格', productIds: ['bread'] }; }, send: input => f.adapter.send(input) });
  try {
    await engine.syncConfig(value); f.adapter.syncConfig(value); await f.adapter.start(value); await engine.start();
    f.setTime(f.now() + 2000); f.setMessages([native('101', f.now() / 1000, { content: `${f.grant.testPrefix}面包多少钱？` })]);
    for (const event of await f.adapter.poll()) await engine.ingest(event);
    let state;
    for (let i = 0; i < 300; i += 1) { state = await engine.status(); if (state.counts.sent === 1) break; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(state.counts.sent, 1);
    assert.equal(generated, 1);
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].chatId, 'wxid_customer');
    assert.equal(f.sends[0].text, '面包10元。');
  } finally { await engine.close(); }
});

function builtinSender() {
  const state = { configured: true, canSend: true, mode: 'native-background', requiresForeground: false, message: '合成原生后台发送器' };
  const calls = { status: [], start: [], sync: [], pause: 0, send: [] };
  const hooks = {};
  const sender = {
    status: async options => { calls.status.push(options); await hooks.status?.(); return { ...state }; },
    start: async value => { calls.start.push(structuredClone(value)); await hooks.start?.(); },
    syncConfig: async value => { calls.sync.push(structuredClone(value)); await hooks.sync?.(); },
    pause: () => { calls.pause += 1; return hooks.pause?.(); },
    send: async value => { calls.send.push(value); return hooks.send ? hooks.send(value) : { status: 'sent', messageId: 'native-builtin-1' }; },
  };
  return { sender, state, calls, hooks };
}

const builtinConfig = (mode = 'auto') => ({ ...config(), settings: { ...config().settings, enabled: true, mode } });

test('注入原生发送器保持默认暂停，显式启动才传完整规则并优先于旧HTTP', async t => {
  const n = builtinSender(); let http = 0;
  const f = await fixture(t, { nativeSender: n.sender, fetch: async () => { http += 1; throw Error('不得调用旧网关'); } });
  await f.gateway({ type: 'verified-http', baseUrl: 'http://127.0.0.1:8000', token: 'synthetic-unused-http' });
  const status = await f.adapter.status({ probe: true });
  assert.equal(status.canSend, true); assert.equal(status.requiresForeground, false); assert.equal(status.mode, 'native-background');
  assert.deepEqual(await f.adapter.poll(), []);
  assert.equal((await f.adapter.send(sendInput('before-start'))).status, 'failed');
  assert.equal(n.calls.start.length, 0); assert.equal(n.calls.send.length, 0);
  const value = builtinConfig();
  await f.adapter.syncConfig(value); assert.deepEqual(n.calls.sync, [value]);
  await f.adapter.start(value); assert.deepEqual(n.calls.start, [value]);
  assert.deepEqual(await f.adapter.send(sendInput('native-one')), { status: 'sent', messageId: 'native-builtin-1' });
  assert.deepEqual(n.calls.send, [sendInput('native-one')]); assert.equal(http, 0);
});

test('已选择但停用或异常的原生发送器不降级HTTP，review仍可只读接待', async t => {
  for (const fault of ['disabled', 'status-error', 'foreground-required']) await t.test(fault, async child => {
    const n = builtinSender(); let http = 0;
    if (fault === 'disabled') n.state.canSend = false;
    if (fault === 'status-error') n.hooks.status = () => { throw Error('合成组件不可用'); };
    if (fault === 'foreground-required') n.state.requiresForeground = true;
    const f = await fixture(child, { nativeSender: n.sender, fetch: async () => { http += 1; throw Error('不得降级'); } });
    await f.gateway({ type: 'verified-http', baseUrl: 'http://127.0.0.1:8000', token: 'synthetic-unused-http' });
    const status = await f.adapter.status({ probe: true });
    assert.equal(status.configured, true); assert.equal(status.canSend, false);
    await assert.rejects(f.adapter.start(builtinConfig()), /自动发送尚未接通/);
    await f.adapter.start(builtinConfig('review'));
    assert.equal((await f.adapter.send(sendInput('blocked'))).status, 'failed');
    assert.equal(n.calls.start.length, 0); assert.equal(n.calls.send.length, 0); assert.equal(http, 0);
  });
});

test('原生明确未配置时保留verified-http与scoped-test-http兼容路径', async t => {
  const n = builtinSender(); n.state.configured = false; n.state.canSend = false;
  let httpSends = 0;
  const f = await fixture(t, { nativeSender: n.sender, fetch: async (url, init) => {
    if (url.endsWith('/status')) return Response.json({ protocol: 'kexu-reply-v1', ready: true, capabilities: { stableChatIds: true, readback: true, idempotentSend: true } });
    httpSends += 1; const body = JSON.parse(init.body);
    return Response.json({ status: 'sent', chatId: body.chatId, messageId: 'http-native-fallback', textSha256: createHash('sha256').update(body.text).digest('hex'), readback: true });
  } });
  await f.gateway({ type: 'verified-http', baseUrl: 'http://127.0.0.1:8000', token: 'synthetic-http-fallback' });
  await f.adapter.start(builtinConfig());
  assert.deepEqual(await f.adapter.send(sendInput('http-one')), { status: 'sent', messageId: 'http-native-fallback' });
  assert.equal(httpSends, 1); assert.equal(n.calls.start.length, 0); assert.equal(n.calls.send.length, 0);
  // 原有受限协议测试仍独立覆盖单账号、唯一会话、期限及配额约束。
  const scoped = await scopedFixture(t);
  await scoped.adapter.start(autoConfig());
  assert.equal((await scoped.adapter.send(sendInput('scoped-still-valid'))).status, 'sent');
});

test('原生发送前仍阻止非白名单、人工接管、重复映射和关闭总开关', async t => {
  for (const change of ['outside', 'takeover', 'duplicate', 'disabled']) await t.test(change, async child => {
    const n = builtinSender(); const f = await fixture(child, { nativeSender: n.sender });
    await f.adapter.start(builtinConfig());
    const next = builtinConfig();
    if (change === 'takeover') next.customers[0].humanTakeover = true;
    if (change === 'duplicate') next.customers.push({ id: 'duplicate', wechatId: 'wxid_customer', autoReplyEnabled: true });
    if (change === 'disabled') next.settings.enabled = false;
    await f.adapter.syncConfig(next);
    const input = { ...sendInput('guarded'), ...(change === 'outside' ? { chatId: 'wxid_outside' } : {}) };
    assert.equal((await f.adapter.send(input)).status, 'failed');
    assert.equal(n.calls.send.length, 0);
  });
});

test('原生预检等待期间暂停、接管或换工作区均不能实际调用send', async t => {
  for (const change of ['pause', 'takeover', 'workspace']) await t.test(change, async child => {
    const workspace = { id: 'acct-aaaaaaaaaaaaaaaaaaaa', workspaceToken: 'acct-aaaaaaaaaaaaaaaaaaaa@1' }; let token = workspace.workspaceToken;
    const n = builtinSender(); const f = await fixture(child, { nativeSender: n.sender, workspace, currentWorkspace: () => token });
    await f.adapter.start(builtinConfig());
    let release; const entered = new Promise(resolve => { n.hooks.status = async () => { resolve(); await new Promise(done => { release = done; }); }; });
    const sending = f.adapter.send(sendInput('race'));
    await entered;
    if (change === 'pause') await f.adapter.pause();
    if (change === 'takeover') { const next = builtinConfig(); next.customers[0].humanTakeover = true; await f.adapter.syncConfig(next); }
    if (change === 'workspace') token = 'acct-aaaaaaaaaaaaaaaaaaaa@2';
    release();
    assert.equal((await sending).status, 'failed'); assert.equal(n.calls.send.length, 0);
  });
});

test('原生异常或畸形sent回执成为unknown，同幂等键不会重发或改走HTTP', async t => {
  for (const kind of ['throw', 'missing-id', 'unknown']) await t.test(kind, async child => {
    const n = builtinSender(); let http = 0;
    n.hooks.send = () => { if (kind === 'throw') throw Error('合成发送后断连'); return kind === 'unknown' ? { status: 'unknown' } : { status: 'sent' }; };
    const f = await fixture(child, { nativeSender: n.sender, fetch: async () => { http += 1; throw Error('不得降级'); } });
    await f.adapter.start(builtinConfig());
    const first = await f.adapter.send(sendInput('same'));
    assert.equal(first.status, 'unknown');
    assert.deepEqual(await f.adapter.send(sendInput('same')), first);
    assert.equal((await f.adapter.send({ ...sendInput('same'), text: '另一条合成正文' })).status, 'failed');
    assert.equal(n.calls.send.length, 1); assert.equal(http, 0);
  });
});

test('原生发出后工作区切换保留unknown，旧服务暂停仍等待sender安全结束', async t => {
  const workspace = { id: 'acct-aaaaaaaaaaaaaaaaaaaa', workspaceToken: 'acct-aaaaaaaaaaaaaaaaaaaa@1' }; let token = workspace.workspaceToken;
  const n = builtinSender(); const f = await fixture(t, { nativeSender: n.sender, workspace, currentWorkspace: () => token });
  await f.adapter.start(builtinConfig());
  let finish; const entered = new Promise(resolve => { n.hooks.send = async () => { resolve(); return new Promise(done => { finish = done; }); }; });
  const pending = f.adapter.send(sendInput('in-flight'));
  await entered;
  token = 'acct-aaaaaaaaaaaaaaaaaaaa@2';
  let unpause; n.hooks.pause = () => new Promise(resolve => { unpause = resolve; });
  let stopped = false; const stopping = f.adapter.pause().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  finish({ status: 'sent', messageId: 'old-account-result' });
  assert.equal((await pending).status, 'unknown');
  unpause(); await stopping;
  n.hooks.pause = undefined;
  assert.equal(stopped, true); assert.equal(n.calls.send.length, 1);
});

test('原生启动和规则同步必须等待完成，同步失败保持暂停', async t => {
  const n = builtinSender(); const f = await fixture(t, { nativeSender: n.sender });
  let finishStart; const started = new Promise(resolve => { n.hooks.start = async () => { resolve(); await new Promise(done => { finishStart = done; }); }; });
  let running = false; const starting = f.adapter.start(builtinConfig()).then(() => { running = true; });
  await started; assert.equal(running, false);
  await f.adapter.pause(); finishStart();
  await assert.rejects(starting, /已暂停|变化/); assert.equal(running, false);
  n.hooks.start = undefined;
  await f.adapter.start(builtinConfig());
  let finishSync; const synced = new Promise(resolve => { n.hooks.sync = async () => { resolve(); await new Promise(done => { finishSync = done; }); }; });
  let completed = false; const syncing = f.adapter.syncConfig(builtinConfig()).then(() => { completed = true; });
  await synced; assert.equal(completed, false); finishSync(); await syncing;
  n.hooks.sync = () => { throw Error('合成同步失败'); };
  await assert.rejects(f.adapter.syncConfig(builtinConfig()));
  assert.equal((await f.adapter.send(sendInput('after-failure'))).status, 'failed');
});

test('运行中启用原生或关闭已选原生都不会热切换到其他发送器', async t => {
  const n = builtinSender(); n.state.configured = false; n.state.canSend = false;
  const f = await fixture(t, { nativeSender: n.sender, fetch: async () => { throw Error('没有配置HTTP'); } });
  await f.adapter.start(builtinConfig('review'));
  n.state.configured = true; n.state.canSend = true;
  assert.equal((await f.adapter.send(sendInput('changed-source'))).status, 'failed'); assert.equal(n.calls.send.length, 0);
  await f.adapter.start(builtinConfig());
  n.state.canSend = false;
  assert.equal((await f.adapter.send(sendInput('disabled-native'))).status, 'failed'); assert.equal(n.calls.send.length, 0);
});
