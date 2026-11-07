import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createLocalReplyService } from '../scripts/local-wechat/reply-service.mjs';
import { DEFAULT_REPLY_SETTINGS } from '../scripts/local-wechat/reply-engine.mjs';

const configuration = () => ({ settings: { ...structuredClone(DEFAULT_REPLY_SETTINGS), debounceSeconds: 0, enabled: true, selectedCustomerIds: ['customer-one'], businessHours: { enabled: false, start: '09:00', end: '18:00', days: [1] } }, customers: [{ id: 'customer-one', wechatId: 'wxid_one', name: '合成客户', autoReplyEnabled: true }], products: [{ id: 'service-one', type: 'service', name: '洗护', price: 128, description: '洗护服务，按预约时间到店。', faq: [], enabled: true }], storeName: '合成测试门店', industry: '通用门店' });

test('本机HTTP接待端到端：保存大配置→新消息→后台草稿，跨域和未接发送器均被拒绝', async t => {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'kexu-reply-http-test-'));
  let service;
  let active = false;
  let sends = 0;
  const adapter = { status: async () => ({ configured: false, canReceive: true, canSend: false, message: '合成只读适配器' }), start: async () => { active = true; }, pause: () => { active = false; }, syncConfig: () => {}, fail: () => { active = false; }, poll: async () => active ? [{ id: 'native-event-one', chatId: 'wxid_one', sender: 'customer', text: '洗护多少钱？', date: new Date().toISOString(), kind: 'text', source: 'realtime' }] : [], send: async () => { sends++; return { status: 'unknown' }; } };
  const server = http.createServer((request, response) => { void service.handle(request, response).then(handled => { if (!handled) { response.statusCode = 404; response.end(); } }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  service = await createLocalReplyService({ root, origin, adapter, pollMs: 60_000, generate: async () => ({ action: 'reply', reply: '洗护服务价格128元。', reason: '依据门店真实洗护价格', productIds: ['service-one'] }) });
  t.after(async () => {
    await service.close();
    await new Promise(resolve => server.close(resolve));
    const actual = await realpath(root);
    assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(actual).startsWith('kexu-reply-http-test-'));
    await rm(actual, { recursive: true, force: true });
  });
  const call = async (route, data, headers = {}) => {
    const response = await fetch(`${origin}/__local-wechat/replies${route}`, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-Kexu-Local': '1', Origin: origin, 'Content-Type': 'application/json', ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await call('/status', undefined, { Origin: 'https://outside.example' })).status, 403);
  assert.equal((await call('/start', {})).status, 400);
  const config = configuration();
  config.products[0].description = '合成知识资料。'.repeat(1000);
  assert.ok(Buffer.byteLength(JSON.stringify(config)) > 8192);
  assert.equal((await call('/config', config)).status, 200);
  assert.equal((await call('/start', {})).status, 200);
  let state;
  const deadline = Date.now() + 4000;
  do {
    state = (await call('/status')).data;
    if (state.counts.draft === 1) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(state.counts.draft, 1);
  assert.equal(state.generatorMode, 'background');
  assert.equal(state.adapter.canSend, false);
  assert.equal((await call(`/jobs/${state.jobs[0].id}/approve`, {})).status, 409);
  await service.poll();
  assert.equal((await call('/status')).data.jobs.length, 1);
  assert.equal((await call('/pause', {})).data.running, false);
  assert.equal(sends, 0);
  const auto = configuration(); auto.settings.mode = 'auto';
  assert.equal((await call('/config', auto)).status, 409);
});

test('生产后台生成HTTP正文传递连续消息证据，临时单会话测试隔离历史而普通接待保留上下文', async t => {
  for (const scoped of [true, false]) await t.test(scoped ? '当前工作区scoped-test-http显式空context' : '普通verified-http保留原上下文', async child => {
    const parent = await realpath(os.tmpdir());
    const root = await mkdtemp(path.join(parent, 'kexu-reply-http-body-'));
    const workspace = { id: 'acct-aaaaaaaaaaaaaaaaaaaa', workspaceToken: 'acct-aaaaaaaaaaaaaaaaaaaa@1' };
    const privateDirectory = path.join(root, '.local-wechat');
    const queueDirectory = path.join(privateDirectory, 'replies', workspace.id);
    await mkdir(queueDirectory, { recursive: true });
    const historyText = '仅本机合成旧上下文，不应进入临时测试请求';
    const credential = 'SYNTHETIC_PRIVATE_ADAPTER_CREDENTIAL';
    await writeFile(path.join(privateDirectory, 'reply-adapter.json'), JSON.stringify({ type: scoped ? 'scoped-test-http' : 'verified-http', workspaceToken: workspace.workspaceToken, token: credential }), 'utf8');
    await writeFile(path.join(queueDirectory, 'queue.json'), JSON.stringify({ version: 1, config: null, configRevision: 0, jobs: [], seen: [], takeovers: [], history: { wxid_one: [{ id: 'synthetic-old-history', sender: 'customer', text: historyText, date: new Date(Date.now() - 60_000).toISOString() }] }, lastSent: {} }), 'utf8');
    let service;
    let active = false;
    let delivered = false;
    let sends = 0;
    const generated = [];
    const at = new Date().toISOString();
    const events = [{ id: 'new-message-one', nativeMessageId: '100001', text: '洗护多少钱？' }, { id: 'new-message-two', nativeMessageId: '100002', text: '需要提前预约吗？' }].map(message => ({ ...message, chatId: 'wxid_one', sender: 'customer', date: at, source: 'realtime', kind: 'text' }));
    const adapter = {
      status: async () => ({ canReceive: true, canSend: false }), start: async () => { active = true; }, pause: () => { active = false; }, syncConfig: () => {}, fail: () => { active = false; },
      poll: async () => { if (!active || delivered) return []; delivered = true; return events; },
      send: async () => { sends++; throw new Error('审核测试不得发送'); },
    };
    const server = http.createServer((request, response) => { void service.handle(request, response).then(handled => { if (!handled) { response.statusCode = 404; response.end(); } }); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    service = await createLocalReplyService({ root, origin, adapter, workspace, currentWorkspace: () => workspace.workspaceToken, pollMs: 60_000, fetch: async (url, input) => {
      assert.equal(url, `${origin}/api/reply`);
      assert.equal(input.headers['X-Kexu-Workspace'], workspace.workspaceToken);
      assert.equal(input.method, 'POST');
      assert.ok(!input.body.includes(credential), '模型请求不能包含适配器私有凭据');
      generated.push(JSON.parse(input.body));
      return Response.json({ action: 'reply', reply: '洗护服务价格128元。', reason: '依据合成商品资料。', productIds: ['service-one'] });
    } });
    child.after(async () => {
      await service.close(); await new Promise(resolve => server.close(resolve));
      const actual = await realpath(root);
      assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
      assert.ok(path.basename(actual).startsWith('kexu-reply-http-body-'));
      await rm(actual, { recursive: true, force: true });
    });
    const call = async (route, body) => {
      const response = await fetch(`${origin}/__local-wechat/replies${route}`, { method: 'POST', headers: { 'X-Kexu-Local': '1', 'X-Kexu-Workspace': workspace.workspaceToken, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      return response.json();
    };
    const config = configuration(); config.settings.debounceSeconds = 1;
    await call('/config', config); await call('/start', {});
    const deadline = Date.now() + 5000;
    let state;
    do {
      state = await service.status();
      if (state.counts.draft === 1) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.equal(state.counts.draft, 1);
    assert.equal(generated.length, 1, '连续新消息只生成一个HTTP请求');
    const body = generated[0];
    assert.deepEqual(body.messages.map(message => [message.id, message.nativeMessageId, message.text]), events.map(message => [message.id, message.nativeMessageId, message.text]));
    assert.equal(body.message.text, events.map(message => message.text).join('\n'));
    assert.equal(body.message.id, events[1].id);
    if (scoped) {
      assert.deepEqual(body.context, []);
      assert.ok(!JSON.stringify(body).includes(historyText));
    } else {
      assert.ok(body.context.some(message => message.text === historyText));
      for (const message of events) assert.ok(body.context.some(item => item.text === message.text));
    }
    assert.equal(sends, 0);
    await call('/pause', {});
  });
});
