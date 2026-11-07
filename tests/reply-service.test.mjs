import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createLocalReplyService } from '../scripts/local-wechat/reply-service.mjs';
import { DEFAULT_REPLY_SETTINGS } from '../scripts/local-wechat/reply-engine.mjs';
import { containsCredentialLikeText } from '../scripts/local-wechat/credential-guard.mjs';
import { GENERATION_FAILURES } from '../scripts/local-wechat/reply-generation-errors.mjs';

const configuration = () => ({ settings: { ...structuredClone(DEFAULT_REPLY_SETTINGS), debounceSeconds: 0, enabled: true, selectedCustomerIds: ['customer-one'], businessHours: { enabled: false, start: '09:00', end: '18:00', days: [1] } }, customers: [{ id: 'customer-one', wechatId: 'wxid_one', name: '合成客户', autoReplyEnabled: true }], products: [{ id: 'service-one', type: 'service', name: '洗护', price: 128, description: '洗护服务，按预约时间到店。', faq: [], enabled: true }], storeName: '合成测试门店', industry: '通用门店' });

test('本地凭据识别覆盖长密钥与带标签token，普通业务文字不受影响', () => {
  for (const value of [
    `合成凭据 sk-${'SyntheticOnly'.repeat(3)}`,
    `Authorization: Bearer ${'synthetic-token-'.repeat(3)}`,
    `API Key: ${'SYNTHETIC_API_CREDENTIAL_'.repeat(2)}`,
    `"api_key": "${'synthetic_api_'.repeat(3)}"`,
    `Secret Key为 ${'synthetic-secret-'.repeat(3)}`,
  ]) assert.equal(containsCredentialLikeText(value), true);
  for (const value of [undefined, null, 123, '', '洗护服务价格128元，需要提前预约。', 'API Key请在设置页填写。', 'Bearer是认证方式', 'sk-short', '订单编号SYNTHETIC_ORDER_NUMBER_WITHOUT_CREDENTIAL_LABEL']) assert.equal(containsCredentialLikeText(value), false);
});

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
  const scenarios = [
    { scoped: true, label: '当前工作区scoped-test-http显式空context' },
    { label: '普通verified-http保留原上下文' },
    { native: true, verification: true, label: '原生验证模式只发送本批消息，显式空context' },
    { native: true, label: '正常原生接待保留上下文' },
    { verification: true, label: '未注入原生发送器时验证标志不影响普通接待' },
  ];
  for (const scenario of scenarios) await t.test(scenario.label, async child => {
    const scoped = scenario.scoped === true;
    const parent = await realpath(os.tmpdir());
    const root = await mkdtemp(path.join(parent, 'kexu-reply-http-body-'));
    const workspace = { id: 'acct-aaaaaaaaaaaaaaaaaaaa', workspaceToken: 'acct-aaaaaaaaaaaaaaaaaaaa@1' };
    const privateDirectory = path.join(root, '.local-wechat');
    const queueDirectory = path.join(privateDirectory, 'replies', workspace.id);
    await mkdir(queueDirectory, { recursive: true });
    const historyText = '仅本机合成旧上下文，不应进入临时测试请求';
    const sensitiveHistoryText = `API Key: ${'SYNTHETIC_HISTORY_CREDENTIAL_'.repeat(2)}`;
    const credential = 'SYNTHETIC_PRIVATE_ADAPTER_CREDENTIAL';
    await writeFile(path.join(privateDirectory, 'reply-adapter.json'), JSON.stringify({ type: scoped ? 'scoped-test-http' : 'verified-http', workspaceToken: workspace.workspaceToken, token: credential }), 'utf8');
    await writeFile(path.join(queueDirectory, 'queue.json'), JSON.stringify({ version: 1, config: null, configRevision: 0, jobs: [], seen: [], takeovers: [], history: { wxid_one: [{ id: 'synthetic-old-history', sender: 'customer', text: historyText, date: new Date(Date.now() - 60_000).toISOString() }, { id: 'synthetic-credential-history', sender: 'customer', text: sensitiveHistoryText, date: new Date(Date.now() - 30_000).toISOString() }] }, lastSent: {} }), 'utf8');
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
    service = await createLocalReplyService({ root, origin, adapter, nativeSender: scenario.native ? {} : undefined, nativeVerificationMode: scenario.verification === true, workspace, currentWorkspace: () => workspace.workspaceToken, pollMs: 60_000, fetch: async (url, input) => {
      assert.equal(url, `${origin}/api/reply`);
      assert.equal(input.headers['X-Kexu-Workspace'], workspace.workspaceToken);
      assert.equal(input.method, 'POST');
      assert.ok(!input.body.includes(credential), '模型请求不能包含适配器私有凭据');
      assert.ok(!input.body.includes(sensitiveHistoryText), '模型请求应省略含合成密钥的历史行');
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
    if (scoped || scenario.native && scenario.verification) {
      assert.deepEqual(body.context, []);
      assert.ok(!JSON.stringify(body).includes(historyText));
    } else {
      assert.ok(body.context.some(message => message.text === historyText));
      for (const message of events) assert.ok(body.context.some(item => item.text === message.text));
    }
    assert.equal(sends, 0);
    const persisted = JSON.parse(await readFile(path.join(queueDirectory, 'queue.json'), 'utf8'));
    assert.ok(persisted.history.wxid_one.some(message => message.text === sensitiveHistoryText), '过滤模型上下文不能改写本地原始聊天');
    await call('/pause', {});
  });
});

test('本批新消息含疑似密钥时在模型前停止，整批不生成且不发送', async t => {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'kexu-credential-batch-'));
  let service;
  let active = false;
  let delivered = false;
  let requests = 0;
  let sends = 0;
  const at = new Date().toISOString();
  const events = [`API Key: ${'SYNTHETIC_NEW_CREDENTIAL_'.repeat(2)}`, '洗护需要预约吗？'].map((text, index) => ({ id: `synthetic-sensitive-${index}`, nativeMessageId: `20000${index}`, chatId: 'wxid_one', sender: 'customer', text, date: at, kind: 'text', source: 'realtime' }));
  const adapter = {
    status: async () => ({ canReceive: true, canSend: true }), start: async () => { active = true; }, pause: () => { active = false; }, syncConfig: () => {}, fail: () => { active = false; },
    poll: async () => { if (!active || delivered) return []; delivered = true; return events; },
    send: async () => { sends++; return { status: 'sent', messageId: 'unexpected-synthetic-send' }; },
  };
  const server = http.createServer((request, response) => { void service.handle(request, response).then(handled => { if (!handled) { response.statusCode = 404; response.end(); } }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  service = await createLocalReplyService({ root, origin, adapter, pollMs: 60_000, fetch: async () => { requests++; return Response.json({ action: 'reply', reply: '洗护128元。', reason: '合成回复', productIds: ['service-one'] }); } });
  t.after(async () => {
    await service.close(); await new Promise(resolve => server.close(resolve));
    const actual = await realpath(root);
    assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(actual).startsWith('kexu-credential-batch-'));
    await rm(actual, { recursive: true, force: true });
  });
  const call = async (route, body) => {
    const response = await fetch(`${origin}/__local-wechat/replies${route}`, { method: 'POST', headers: { 'X-Kexu-Local': '1', Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const config = configuration(); config.settings.mode = 'auto'; config.settings.debounceSeconds = 1;
  await call('/config', config); await call('/start', {});
  let state;
  const deadline = Date.now() + 5000;
  do {
    state = await service.status();
    if (state.counts.failed === 1) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(state.counts.failed, 1);
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].messages.length, 2, '疑似密钥不能通过删除本批证据绕过校验');
  assert.equal(state.jobs[0].failureCode, 'AI_INPUT_CREDENTIAL_BLOCKED');
  assert.equal(requests, 0, '本批疑似密钥不能提交给模型');
  assert.equal(sends, 0, '本批停止后不能发送回复');
  assert.ok(!state.jobs[0].reason.includes('SYNTHETIC_NEW_CREDENTIAL_'), '错误原因不能包含密钥原文');
});

async function nativeServiceFixture(t) {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'kexu-native-reply-http-'));
  const workspace = { id: 'acct-aaaaaaaaaaaaaaaaaaaa', workspaceToken: 'acct-aaaaaaaaaaaaaaaaaaaa@1' };
  let token = workspace.workspaceToken;
  const hooks = {};
  const calls = { start: [], sync: [], send: [], pause: 0 };
  const nativeSender = {
    status: async () => ({ configured: true, canSend: true, requiresForeground: false, mode: 'native-background', workspaceToken: workspace.workspaceToken, message: '合成后台发送器' }),
    start: async config => { calls.start.push(config); await hooks.start?.(); },
    syncConfig: async config => { calls.sync.push(config); await hooks.sync?.(); },
    pause: () => { calls.pause += 1; return hooks.pause?.(); },
    send: async input => { calls.send.push(input); return hooks.send ? hooks.send(input) : { status: 'sent', messageId: 'synthetic-native-receipt' }; },
  };
  let delivered = false;
  const reader = {
    inspect: async () => ({ configured: true, pythonReady: true, exporterReady: true }),
    readForReplies: async ids => {
      assert.deepEqual(ids, ['wxid_one']);
      const messages = delivered ? [] : [{ server_id: '1234567890123456789', timestamp: Math.floor(Date.now() / 1000) + 2, local_type: '1', sender: '合成客户', sender_username: 'wxid_one', content: '洗护多少钱？' }];
      delivered = true;
      return [{ metadata: { chat_username: 'wxid_one', chat_type: 'private' }, messages }];
    },
  };
  let service;
  const server = http.createServer((request, response) => { void service.handle(request, response).then(handled => { if (!handled) { response.statusCode = 404; response.end(); } }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  service = await createLocalReplyService({ root, reader, origin, nativeSender, workspace, currentWorkspace: () => token, pollMs: 60_000, generate: async () => ({ action: 'reply', reply: '洗护服务价格128元。', reason: '依据合成服务价格', productIds: ['service-one'] }) });
  t.after(async () => {
    hooks.pause = undefined;
    await service.close(); await new Promise(resolve => server.close(resolve));
    const actual = await realpath(root);
    assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(actual).startsWith('kexu-native-reply-http-'));
    await rm(actual, { recursive: true, force: true });
  });
  const call = async (route, body) => {
    const response = await fetch(`${origin}/__local-wechat/replies${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Kexu-Local': '1', 'X-Kexu-Workspace': workspace.workspaceToken, Origin: origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const untilDraft = async () => {
    for (let count = 0; count < 300; count += 1) {
      const state = await service.status();
      if (state.counts.draft === 1) return state;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('合成草稿未生成');
  };
  return { service, calls, hooks, call, untilDraft, switchWorkspace: () => { token = 'acct-aaaaaaaaaaaaaaaaaaaa@2'; } };
}

test('HTTP服务透传原生发送器，默认审核暂停，规则同步和显式启动均等待manager', async t => {
  const f = await nativeServiceFixture(t);
  const initial = await f.call('/status');
  assert.equal(initial.status, 200); assert.equal(initial.data.running, false);
  assert.equal(initial.data.adapter.mode, 'native-background'); assert.equal(initial.data.adapter.requiresForeground, false);
  assert.equal(f.calls.start.length, 0); assert.equal(f.calls.send.length, 0);
  let finishSync; const syncing = new Promise(resolve => { f.hooks.sync = async () => { resolve(); await new Promise(done => { finishSync = done; }); }; });
  let saved = false; const saving = f.call('/config', configuration()).then(value => { saved = true; return value; });
  await syncing; assert.equal(saved, false); finishSync();
  assert.equal((await saving).status, 200); assert.equal(f.calls.start.length, 0);
  f.hooks.sync = undefined;
  let finishStart; const entering = new Promise(resolve => { f.hooks.start = async () => { resolve(); await new Promise(done => { finishStart = done; }); }; });
  let started = false; const starting = f.call('/start', {}).then(value => { started = true; return value; });
  await entering; assert.equal(started, false); assert.equal(f.calls.send.length, 0); finishStart();
  assert.equal((await starting).status, 200);
  const state = await f.untilDraft();
  assert.equal(f.calls.send.length, 0, 'review模式不能自动发送');
  assert.equal(f.calls.start[0].settings.mode, 'review');
  assert.deepEqual(f.calls.start[0].settings.selectedCustomerIds, ['customer-one']);
  assert.equal((await f.call(`/jobs/${state.jobs[0].id}/approve`, {})).status, 200);
  for (let count = 0; count < 300 && f.calls.send.length === 0; count += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.calls.send.length, 1);
  assert.equal(f.calls.send[0].chatId, 'wxid_one');
});

test('暴露pause立即停止引擎且等待原生pause，换号后不能批准旧草稿', async t => {
  const f = await nativeServiceFixture(t);
  await f.call('/config', configuration()); await f.call('/start', {});
  const state = await f.untilDraft();
  let finishPause; f.hooks.pause = () => new Promise(resolve => { finishPause = resolve; });
  let completed = false; const stopping = f.service.pause().then(() => { completed = true; });
  assert.ok(finishPause, 'manager.pause应被同步调用');
  assert.equal((await f.service.status()).running, false);
  assert.equal(completed, false); finishPause(); await stopping;
  f.hooks.pause = undefined;
  f.switchWorkspace();
  const old = await f.call(`/jobs/${state.jobs[0].id}/approve`, {});
  assert.equal(old.status, 409); assert.equal(old.data.code, 'WORKSPACE_CHANGED'); assert.equal(f.calls.send.length, 0);
});

test('close先同步封禁原生发送再关闭引擎，并等待原生在途结束', async t => {
  const f = await nativeServiceFixture(t);
  await f.call('/config', configuration());
  let finishPause; f.hooks.pause = () => new Promise(resolve => { finishPause = resolve; });
  let closed = false; const closing = f.service.close().then(() => { closed = true; });
  assert.ok(finishPause); await Promise.resolve(); assert.equal(closed, false);
  finishPause(); await closing; f.hooks.pause = undefined;
  assert.equal(closed, true); assert.equal(f.calls.send.length, 0);
});


test('本地生成错误保留安全分类，非JSON与恶意供应商错误不进入队列也不触发重发', async t => {
  const leak = 'SYNTHETIC_PROVIDER_SECRET_DO_NOT_PERSIST';
  const cases = [
    ['缺密钥', 'AI_KEY_MISSING', () => Response.json({ code: 'AI_KEY_MISSING', error: leak }, { status: 400 })],
    ['上游认证', 'AI_AUTH_REJECTED', () => Response.json({ code: 'AI_AUTH_REJECTED', error: leak }, { status: 502 })],
    ['本地401', 'AI_UNKNOWN', () => Response.json({ error: leak }, { status: 401 })],
    ['本地403', 'AI_UNKNOWN', () => Response.json({ error: leak }, { status: 403 })],
    ['额度受限', 'AI_RATE_LIMITED', () => Response.json({ error: leak }, { status: 429 })],
    ['明确超时', 'AI_TIMEOUT', () => Response.json({ code: 'AI_TIMEOUT', error: leak }, { status: 504 })],
    ['请求超时', 'AI_TIMEOUT', () => { throw new DOMException(leak, 'TimeoutError'); }],
    ['连接异常', 'AI_NETWORK_UNREACHABLE', () => { throw new TypeError(leak); }],
    ['模型格式', 'AI_RESPONSE_FORMAT', () => Response.json({ code: 'AI_RESPONSE_FORMAT', error: leak }, { status: 502 })],
    ['成功状态非JSON', 'AI_RESPONSE_FORMAT', () => new Response(`<html>${leak}</html>`, { status: 200 })],
    ['成功状态无效结构', 'AI_RESPONSE_FORMAT', () => Response.json({ error: leak }, { status: 200 })],
    ['未知502', 'AI_UNKNOWN', () => Response.json({ code: 'UNTRUSTED_CODE', error: leak, cause: leak }, { status: 502 })],
    ['故障状态非JSON', 'AI_UNKNOWN', () => new Response(`<html>${leak}</html>`, { status: 502 })],
    ['原型字段', 'AI_UNKNOWN', () => Response.json({ code: '__proto__', error: leak }, { status: 502 })],
  ];
  for (const [label, expectedCode, responseFactory] of cases) await t.test(label, async child => {
    const parent = await realpath(os.tmpdir());
    const root = await mkdtemp(path.join(parent, 'kexu-generation-http-error-'));
    let service, active = false, delivered = false, requests = 0, sends = 0;
    const adapter = {
      status: async () => ({ canReceive: true, canSend: false }), start: async () => { active = true; }, pause: () => { active = false; }, syncConfig: () => {}, fail: () => { active = false; },
      poll: async () => { if (!active || delivered) return []; delivered = true; return [{ id: 'synthetic-error-event', nativeMessageId: '700001', chatId: 'wxid_one', sender: 'customer', text: '洗护多少钱？', date: new Date().toISOString(), kind: 'text', source: 'realtime' }]; },
      send: async () => { sends++; throw new Error('分类测试不能发送'); },
    };
    const server = http.createServer((request, response) => { void service.handle(request, response).then(handled => { if (!handled) { response.statusCode = 404; response.end(); } }); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    service = await createLocalReplyService({ root, origin, adapter, pollMs: 60_000, fetch: async () => { requests++; return responseFactory(); } });
    child.after(async () => {
      await service.close(); await new Promise(resolve => server.close(resolve));
      const actual = await realpath(root);
      assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
      assert.ok(path.basename(actual).startsWith('kexu-generation-http-error-'));
      await rm(actual, { recursive: true, force: true });
    });
    const call = async (route, body) => {
      const response = await fetch(`${origin}/__local-wechat/replies${route}`, { method: 'POST', headers: { 'X-Kexu-Local': '1', Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200); return response.json();
    };
    await call('/config', configuration()); await call('/start', {});
    let state;
    const deadline = Date.now() + 4000;
    do {
      state = await service.status();
      if (state.counts.failed === 1) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.equal(state.counts.failed, 1); assert.equal(state.jobs[0].failureCode, expectedCode); assert.equal(state.jobs[0].reason, GENERATION_FAILURES[expectedCode]);
    await service.poll();
    assert.equal(requests, 1); assert.equal(sends, 0); assert.ok(!JSON.stringify(await service.status()).includes(leak));
    const persisted = await readFile(path.join(root, '.local-wechat', 'replies', 'queue.json'), 'utf8');
    assert.ok(!persisted.includes(leak), '供应商错误正文和凭据不能持久化');
  });
});
