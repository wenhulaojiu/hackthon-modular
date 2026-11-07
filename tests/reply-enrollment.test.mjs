import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createReplyAdapter } from '../scripts/local-wechat/reply-adapter.mjs';
import { createLocalReplyService } from '../scripts/local-wechat/reply-service.mjs';
import { DEFAULT_REPLY_SETTINGS } from '../scripts/local-wechat/reply-engine.mjs';
import { assertAdditiveEnrollment, isEnrollmentChatId, isFriendAddedSystemText, requestReplyEnrollment } from '../scripts/local-wechat/reply-enrollment.mjs';

const baseTime = Date.parse('2026-11-07T04:00:00Z');
const workspace = { id: 'acct-aaaaaaaaaaaaaaaaaaaa', workspaceToken: 'acct-aaaaaaaaaaaaaaaaaaaa@1' };
const configuration = () => ({ settings: { ...structuredClone(DEFAULT_REPLY_SETTINGS), enabled: true, mode: 'review', selectedCustomerIds: [], autoEnrollNewContacts: true, welcomeEnabled: false, cooldownSeconds: 0, debounceSeconds: 0, businessHours: { enabled: false, start: '09:00', end: '18:00', days: [1] } }, customers: [], products: [{ id: 'bread', name: '面包', type: 'product', price: 10, description: '当天制作。', faq: [], enabled: true }], storeName: '合成门店', industry: '烘焙' });
const customer = (index, extra = {}) => ({ id: `customer-${index}`, name: `合成客户${index}`, wechatId: `wxid_new_${index}`, autoReplyEnabled: true, humanTakeover: false, ...extra });
const incoming = (id, chatId, extra = {}) => ({ server_id: String(id), timestamp: baseTime / 1000 + 1, sender: '合成客户', sender_username: chatId, local_type: '1', content: '面包多少钱？', ...extra });
const append = (config, customers) => ({ ...config, customers: [...config.customers, ...customers], settings: { ...config.settings, selectedCustomerIds: [...config.settings.selectedCustomerIds, ...customers.map(item => item.id)] } });

async function temporary(t) {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'kexu-enrollment-test-'));
  const disposers = [];
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose();
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('kexu-enrollment-test-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return { root, dispose: callback => disposers.push(callback) };
}

async function adapterFixture(t) {
  const { root, dispose } = await temporary(t);
  let clock = baseTime;
  let catalog = [];
  const records = new Map();
  const reads = [];
  let listed = 0;
  const hooks = {};
  const reader = {
    inspect: async () => ({ configured: true, pythonReady: true, exporterReady: true }),
    listPrivateChats: async () => { listed++; await hooks.list?.(); return catalog; },
    probePrivateChats: async since => {
      listed++; await hooks.list?.();
      return catalog.flatMap(chat => {
        const rows = (records.get(chat.id) || []).filter(row => row.timestamp * 1000 >= since && (String(row.local_type) === '10000' || String(row.local_type) === '1' && (row.sender_username === chat.id || row.sender === '我')));
        if (!rows.length) return [];
        const incomingRows = rows.filter(row => String(row.local_type) === '1' && row.sender_username === chat.id && row.sender !== '我');
        const systemRows = rows.filter(row => String(row.local_type) === '10000');
        return [{ ...chat, watermark: createHash('sha256').update(JSON.stringify(rows)).digest('hex'), timestamp: Math.max(...rows.map(row => row.timestamp * 1000)), inbound: incomingRows.length > 0, lastIncomingAt: incomingRows.length ? Math.max(...incomingRows.map(row => row.timestamp * 1000)) : null, systemChanged: systemRows.length > 0, lastSystemAt: systemRows.length ? Math.max(...systemRows.map(row => row.timestamp * 1000)) : null }];
      });
    },
    readForReplies: async ids => { reads.push(ids); await hooks.read?.(); return ids.map(id => ({ metadata: { chat_type: 'private', chat_username: id }, messages: records.get(id) || [] })); },
  };
  const adapter = createReplyAdapter({ root, reader, now: () => clock, workspace, currentWorkspace: () => workspace.workspaceToken });
  dispose(() => adapter.pause());
  return { root, dispose, reader, adapter, reads, records, hooks, listed: () => listed, setCatalog: value => { catalog = value; }, setTime: value => { clock = value; } };
}

test('自动建档只允许普通私聊，增量配置不能激活旧档案或修改原有规则', () => {
  for (const id of ['filehelper', 'weixin', 'fmessage', 'gh_public', 'wxpay_payment', 'room@chatroom', 'external@openim', '-option']) assert.equal(isEnrollmentChatId(id), false);
  assert.equal(isEnrollmentChatId('wxid_real_friend'), true);
  const old = append(configuration(), [customer('old', { autoReplyEnabled: false })]);
  old.settings.selectedCustomerIds = [];
  const next = append(old, [customer('new')]);
  assert.deepEqual(assertAdditiveEnrollment(old, next), ['customer-new']);
  assert.deepEqual(assertAdditiveEnrollment(next, structuredClone(next)), []);
  for (const mutate of [value => { value.settings.debounceSeconds = 300; }, value => { value.customers[0].autoReplyEnabled = true; value.settings.selectedCustomerIds.push(value.customers[0].id); }, value => { value.customers[1].humanTakeover = true; }, value => { value.customers[1].wechatId = 'gh_public'; }]) {
    const invalid = structuredClone(next); mutate(invalid);
    assert.throws(() => assertAdditiveEnrollment(old, invalid), /规则不一致/);
  }
});

test('好友通过提示仅匹配明确完整句式，不把引用、撤回或拍一拍当添加事件', () => {
  for (const text of ['你已添加了合成好友，现在可以开始聊天了。', '合成好友通过了你的朋友验证请求，现在可以开始聊天了。']) assert.equal(isFriendAddedSystemText(text), true);
  for (const text of ['合成好友拍了拍你', '合成好友撤回了一条消息', '他说“你已添加了合成好友，现在可以开始聊天了。”', '请加一下微信']) assert.equal(isFriendAddedSystemText(text), false);
});

test('原生好友系统事件独立触发，历史/撤回/拍一拍/商户不触发，普通文字仅作新私聊fallback', async t => {
  const f = await adapterFixture(t);
  const ids = ['system', 'recall', 'pat', 'history', 'merchant', 'plain'];
  f.setCatalog(ids.map(id => ({ id: `wxid_new_${id}`, name: `合成${id}`, type: 'private' })));
  const phrase = '你已添加了合成好友，现在可以开始聊天了。';
  f.records.set('wxid_new_system', [incoming(301, 'wxid_new_system', { local_type: '10000', sender: '系统', sender_username: '', content: phrase })]);
  f.records.set('wxid_new_recall', [incoming(302, 'wxid_new_recall', { local_type: '10002', sender: '系统', content: phrase })]);
  f.records.set('wxid_new_pat', [incoming(303, 'wxid_new_pat', { local_type: '10000', sender: '系统', content: '合成好友拍了拍你' })]);
  f.records.set('wxid_new_history', [incoming(304, 'wxid_new_history', { local_type: '10000', sender: '系统', timestamp: baseTime / 1000 - 1, content: phrase })]);
  f.records.set('wxid_new_merchant', [incoming(305, 'wxid_new_merchant', { sender: '我', sender_username: 'wxid_owner', content: phrase })]);
  f.records.set('wxid_new_plain', [incoming(306, 'wxid_new_plain', { content: phrase })]);
  await f.adapter.start(configuration()); f.setTime(baseTime + 2000);
  const found = await f.adapter.discover();
  assert.deepEqual(found.contacts.map(item => item.wechatId), ['wxid_new_system', 'wxid_new_plain']);
  assert.ok(found.welcomes.find(item => item.chatId === 'wxid_new_system').eventId.startsWith('friend-added:'));
  assert.ok(found.welcomes.find(item => item.chatId === 'wxid_new_plain').eventId.startsWith('new-private:'));
  assert.ok(found.events.every(event => event.chatId === 'wxid_new_plain' && event.kind === 'text'), '系统正文不能作为客户问题进入AI');
});

test('只读目录发现需启动后真实入站，排除旧记录、商户单方消息、公众号及已有禁用档案', async t => {
  const f = await adapterFixture(t);
  const config = configuration(); config.customers = [customer('disabled', { autoReplyEnabled: false }), customer('manual', { humanTakeover: true })];
  f.setCatalog(['new', 'old', 'merchant', 'disabled', 'manual'].map(id => ({ id: `wxid_new_${id}`, name: `合成${id}`, type: 'private' })).concat([{ id: 'gh_public', name: '公众号', type: 'private' }, { id: 'filehelper', name: '助手', type: 'private' }, { id: 'group@chatroom', name: '群', type: 'group' }]));
  f.records.set('wxid_new_new', [incoming(101, 'wxid_new_new'), incoming(102, 'wxid_new_new', { content: '需要提前预约吗？' })]);
  f.records.set('wxid_new_old', [incoming(103, 'wxid_new_old', { timestamp: baseTime / 1000 - 1 })]);
  f.records.set('wxid_new_merchant', [incoming(104, 'wxid_new_merchant', { sender: '我', sender_username: 'wxid_owner' })]);
  assert.deepEqual(await f.adapter.discover(), { contacts: [], events: [] });
  assert.equal(f.listed(), 0);
  await f.adapter.start(config); f.setTime(baseTime + 2000);
  const found = await f.adapter.discover();
  assert.deepEqual(found.contacts, [{ wechatId: 'wxid_new_new', name: '合成new', date: new Date(baseTime + 1000).toISOString() }]);
  assert.deepEqual(found.events.map(event => event.nativeMessageId), ['101', '102']);
  assert.deepEqual(f.reads[0], ['wxid_new_new'], '旧水位和商户单方会话不应触发正文导出');
  f.setTime(baseTime + 60_000);
  await f.adapter.enrollCustomers(append(config, [customer('new')]));
  f.records.get('wxid_new_new').push(incoming(105, 'wxid_new_new'));
  assert.ok((await f.adapter.poll()).some(event => event.nativeMessageId === '101'), '增量接纳不能重置startedAt而丢首条消息');
});

test('自动接待21位客户仍按20人分批，关闭发现与暂停期间不扫描目录', async t => {
  const f = await adapterFixture(t);
  const config = append(configuration(), Array.from({ length: 21 }, (_, index) => customer(index)));
  f.setCatalog(config.customers.map(item => ({ id: item.wechatId, name: item.name, type: 'private' })));
  for (let index = 0; index < 21; index++) f.records.set(`wxid_new_${index}`, [incoming(1000 + index, `wxid_new_${index}`)]);
  config.settings.autoEnrollNewContacts = false;
  await f.adapter.start(config); f.setTime(baseTime + 2000);
  await f.adapter.poll();
  assert.deepEqual(f.reads.map(ids => ids.length), [20, 1]);
  assert.deepEqual(await f.adapter.discover(), { contacts: [], events: [] });
  assert.equal(f.listed(), 1);
  await f.adapter.pause();
  assert.deepEqual(await f.adapter.discover(), { contacts: [], events: [] });
});

test('目录读取期间暂停丢弃迟到发现，不能扩大名单或恢复接待', async t => {
  const f = await adapterFixture(t);
  await f.adapter.start(configuration());
  let finish;
  const entered = new Promise(resolve => { f.hooks.list = () => { resolve(); return new Promise(done => { finish = done; }); }; });
  const finding = f.adapter.discover(); await entered;
  await f.adapter.pause(); finish();
  assert.deepEqual(await finding, { contacts: [], events: [] });
  await assert.rejects(() => f.adapter.enrollCustomers(append(configuration(), [customer('late')])), /接待已暂停/);
});

test('新私聊API只提交20人以内的目录信息，带本机与工作区头，不提交聊天正文', async () => {
  const contacts = [{ wechatId: 'wxid_new_api', name: '合成客户', date: new Date(baseTime).toISOString() }];
  const next = append(configuration(), [customer('api')]);
  let calls = 0;
  const request = async (url, input) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:5173/api/reply/enroll');
    assert.equal(input.headers['X-Kexu-Local'], '1');
    assert.equal(input.headers['X-Kexu-Workspace'], workspace.workspaceToken);
    assert.deepEqual(JSON.parse(input.body), { contacts });
    return Response.json({ config: next, addedCustomerIds: ['customer-api'], revision: 2 });
  };
  assert.equal((await requestReplyEnrollment({ origin: 'http://127.0.0.1:5173', request, contacts, workspace })).revision, 2);
  await assert.rejects(() => requestReplyEnrollment({ origin: 'http://127.0.0.1:5173', request, contacts: Array.from({ length: 21 }, (_, index) => ({ wechatId: `wxid_${index}`, name: '合成' })), workspace }), /资料格式/);
  assert.equal(calls, 1);
});

async function serviceFixture(t, { count = 1, beforeEnrollment, welcome = false, systemOnly = false, debounceSeconds = 0 } = {}) {
  const f = await adapterFixture(t);
  f.setCatalog(Array.from({ length: count }, (_, index) => ({ id: `wxid_new_${index}`, name: `新客户${index}`, type: 'private' })));
  for (let index = 0; index < count; index++) f.records.set(`wxid_new_${index}`, [incoming(10000 + index, `wxid_new_${index}`)]);
  if (systemOnly) for (let index = 0; index < count; index++) f.records.set(`wxid_new_${index}`, [incoming(10000 + index, `wxid_new_${index}`, { sender: '系统', sender_username: '', local_type: '10000', content: '你已添加了合成好友，现在可以开始聊天了。' })]);
  let config = configuration(); config.settings.mode = 'auto';
  config.settings.welcomeEnabled = welcome; config.settings.welcomeMessage = '欢迎来到合成小店，我们提供当天制作的面包。'; config.settings.debounceSeconds = debounceSeconds;
  const requests = [];
  const sends = [];
  const enrolls = [];
  const nativeSender = { status: async () => ({ configured: true, canSend: true, mode: 'native-background', requiresForeground: false }), start: async () => {}, syncConfig: async () => {}, pause: () => {}, enrollCustomers: async next => { enrolls.push(next); }, send: async input => { sends.push(input); return { status: 'sent', messageId: `synthetic-send-${sends.length}` }; } };
  const adapter = createReplyAdapter({ root: f.root, reader: f.reader, now: () => baseTime, workspace, currentWorkspace: () => workspace.workspaceToken, nativeSender });
  let service;
  const server = http.createServer((request, response) => { void service.handle(request, response).then(handled => { if (!handled) { response.statusCode = 404; response.end(); } }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  service = await createLocalReplyService({ root: f.root, reader: f.reader, origin, adapter, workspace, currentWorkspace: () => workspace.workspaceToken, pollMs: 60_000, fetch: async (url, input) => {
    const body = JSON.parse(input.body); requests.push({ url, body });
    if (url.endsWith('/api/reply/enroll')) {
      assert.equal(input.headers['X-Kexu-Local'], '1');
      assert.ok(body.contacts.length <= 20);
      await beforeEnrollment?.();
      const added = body.contacts.filter(contact => !config.customers.some(item => item.wechatId === contact.wechatId)).map(contact => ({ id: `id-${contact.wechatId}`, wechatId: contact.wechatId, name: contact.name, autoReplyEnabled: true, humanTakeover: false }));
      config = append(config, added);
      return Response.json({ config, addedCustomerIds: added.map(item => item.id), revision: requests.filter(item => item.url.endsWith('/enroll')).length });
    }
    assert.ok(config.settings.selectedCustomerIds.includes(body.customerId), '建档入范围完成后才能请求模型');
    return Response.json({ action: 'reply', reply: '面包10元。', reason: '根据合成已配商品。', productIds: ['bread'] });
  } });
  f.dispose(async () => { await service.close(); await new Promise(resolve => server.close(resolve)); });
  const call = async (route, body) => {
    const response = await fetch(`${origin}/__local-wechat/replies${route}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Kexu-Local': '1', 'X-Kexu-Workspace': workspace.workspaceToken }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return response.json();
  };
  await call('/config', config);
  return { ...f, service, call, requests, sends, enrolls };
}

async function until(service, check) {
  for (let count = 0; count < 500; count++) {
    const state = await service.status();
    if (check(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('合成新私聊未完成预期处理');
}

test('零名单启动后先建档入范围再处理新私聊首条，重复轮询不重复建档或发送', async t => {
  const f = await serviceFixture(t);
  await f.call('/start', {});
  const state = await until(f.service, value => value.counts.sent === 1);
  assert.equal(state.stateRevision, 1);
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].message.text, '面包多少钱？');
  assert.equal(f.requests[0].url.endsWith('/api/reply/enroll'), true);
  assert.equal(f.enrolls.length, 1);
  const priorReads = f.reads.length;
  await f.service.poll();
  assert.equal(f.requests.filter(item => item.url.endsWith('/enroll')).length, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.reads.length, priorReads, '同一水位无需重复导出正文');
  f.records.get('wxid_new_0').push(incoming(20000, 'wxid_new_0', { timestamp: baseTime / 1000 + 2, sender: '我', sender_username: 'wxid_owner', content: '我来亲自跟进。' }));
  await f.service.poll();
  assert.ok((await f.service.status()).takeovers.includes('id-wxid_new_0'), '已选客户的商户文字水位变化仍须触发人工接管');
});

test('21位新私聊分两次API接纳，读取批次仍不超过20，首条消息均进入各自任务', async t => {
  const f = await serviceFixture(t, { count: 21 });
  await f.call('/start', {});
  const state = await until(f.service, value => value.counts.sent === 21);
  assert.equal(f.requests.filter(item => item.url.endsWith('/enroll')).length, 2);
  assert.ok(f.reads.every(ids => ids.length <= 20));
  assert.equal(new Set(state.jobs.map(job => job.chatId)).size, 21);
});

test('建档API等待期间用户暂停，迟到回执不入引擎、不请求模型也不发送', async t => {
  let finish;
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const f = await serviceFixture(t, { beforeEnrollment: () => { entered(); return new Promise(resolve => { finish = resolve; }); } });
  await f.call('/start', {}); await waiting;
  await f.service.pause(); finish();
  await f.service.poll();
  const state = await f.service.status();
  assert.equal(state.running, false);
  assert.equal(state.jobs.length, 0);
  assert.equal(f.enrolls.length, 0);
  assert.equal(f.requests.filter(item => item.url.endsWith('/api/reply')).length, 0);
  assert.equal(f.sends.length, 0);
});

test('仅好友通过系统事件也可先建档发一次店铺介绍，不请求模型，后续咨询仍等60秒', async t => {
  const f = await serviceFixture(t, { welcome: true, systemOnly: true, debounceSeconds: 60 });
  await f.call('/start', {});
  let state = await until(f.service, value => value.counts.sent === 1);
  assert.equal(f.sends[0].text, '欢迎来到合成小店，我们提供当天制作的面包。');
  assert.equal(f.requests.filter(item => item.url.endsWith('/api/reply')).length, 0);
  assert.equal(state.jobs.length, 1);
  f.records.get('wxid_new_0').push(incoming(30000, 'wxid_new_0', { timestamp: baseTime / 1000 + 2 }));
  await f.service.poll(); state = await f.service.status();
  assert.equal(state.counts.queued, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.requests.filter(item => item.url.endsWith('/api/reply')).length, 0);
  assert.ok(Date.parse(state.jobs.find(job => job.status === 'queued').quietUntil) > Date.now() + 55_000);
});

test('没有系统记录时首条新客纯文本fallback先欢迎，咨询不绕过60秒等待', async t => {
  const f = await serviceFixture(t, { welcome: true, debounceSeconds: 60 });
  await f.call('/start', {});
  const state = await until(f.service, value => value.counts.sent === 1 && value.counts.queued === 1);
  assert.equal(state.jobs.length, 2);
  assert.equal(f.sends[0].text, '欢迎来到合成小店，我们提供当天制作的面包。');
  assert.equal(f.requests.filter(item => item.url.endsWith('/api/reply')).length, 0);
});
