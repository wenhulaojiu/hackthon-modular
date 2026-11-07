import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createNativeSenderRunner, createNativeSenderService } from '../scripts/local-wechat/native-sender-service.mjs';
import { createReplyAdapter } from '../scripts/local-wechat/reply-adapter.mjs';

const PIN = '9004a6cd98d32ebdcb50f35f15649e6c964e7720';
const workspace = { id: 'acct-aaaaaaaaaaaaaaaaaaaa', workspaceToken: 'acct-aaaaaaaaaaaaaaaaaaaa@1' };
const configuration = () => ({ settings: { enabled: true, selectedCustomerIds: ['customer-one'] }, customers: [{ id: 'customer-one', wechatId: 'wxid_synthetic_target', autoReplyEnabled: true }] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const receipt = input => ({ status: 'sent', readback: true, messageId: '12345678901234567890', chatId: input.chatId, workspaceToken: input.workspaceToken, textSha256: createHash('sha256').update(input.text, 'utf8').digest('hex') });

test('真实Node管理器与回复适配层合同互通，原生就绪后发送且重复请求不重复调用', async t => {
  const f = await fixture(t);
  await f.enable();
  const reader = { inspect: async () => ({ configured: true, pythonReady: true, exporterReady: true, databaseReady: true }), readForReplies: async () => [] };
  const adapter = createReplyAdapter({ root: f.root, workspace, currentWorkspace: () => workspace.workspaceToken, reader, nativeSender: f.service, fetch: async () => { assert.fail('原生已选择，不能回退HTTP'); } });
  const config = configuration(); config.settings.mode = 'auto';
  await adapter.start(config);
  const before = (await f.readConfig()).settingsGeneration;
  await adapter.syncConfig(config);
  assert.equal((await f.readConfig()).settingsGeneration, before);
  const first = await adapter.send(f.message());
  assert.equal(first.status, 'sent');
  assert.equal((await adapter.send(f.message())).messageId, first.messageId);
  assert.equal(f.calls.filter(call => call.action === 'send').length, 1);
  await adapter.pause();
  assert.equal((await adapter.send(f.message({ idempotencyKey: 'after-pause' }))).status, 'failed');
  assert.equal(f.calls.filter(call => call.action === 'send').length, 1);
});

async function fixture(t, options = {}) {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'kexu-native-manager-test-'));
  const senderDirectory = path.join(root, '.local-wechat', 'native-sender');
  const filename = path.join(senderDirectory, 'scopes', workspace.id, 'config.json');
  const calls = [];
  const setupCalls = [];
  let current = workspace.workspaceToken;
  let handler;
  const run = async (action, args, input) => {
    calls.push({ action, args, input });
    if (options.run) return options.run(action, args, input);
    if (action === 'bind') return { ready: true, compatible: true, installed: true, pid: 1234, processCreated: '12345678900000', selfWxid: 'wxid_synthetic_self', ignoredPrivate: 'SYNTHETIC_PRIVATE_ACCOUNT_INFORMATION' };
    if (action === 'inspect') return { ready: true, compatible: true, installed: true, ignoredPrivate: 'SYNTHETIC_PRIVATE_ACCOUNT_INFORMATION' };
    return receipt(input);
  };
  const setupRun = async args => {
    setupCalls.push(args);
    return options.setupRun ? options.setupRun(args) : { installed: true };
  };
  const service = createNativeSenderService({ root, workspace, currentWorkspace: () => current, platform: options.platform || 'win32', run, setupRun, onDisable: options.onDisable, sendTimeoutMs: options.sendTimeoutMs || 500, now: options.now || Date.now });
  const server = http.createServer((request, response) => {
    void (handler || service).handle(request, response).then(handled => { if (!handled) { response.statusCode = 404; response.end(); } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, body, headers = {}, method) => {
    const response = await fetch(`${origin}/__local-wechat/native-sender${route}`, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { Origin: origin, 'X-Kexu-Local': '1', 'X-Kexu-Workspace': workspace.workspaceToken, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const install = async () => {
    const initial = await call('/setup', {});
    assert.equal(initial.status, 202);
    assert.equal(initial.data.setupState, 'installing');
    for (let index = 0; index < 20; index++) {
      const state = await service.status();
      if (state.setupState !== 'installing') { assert.equal(state.setupState, 'ready'); return; }
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.fail('合成安装未完成');
  };
  const enable = async () => { await install(); const result = await call('/enable', {}); assert.equal(result.status, 200); return result.data; };
  const readConfig = async () => JSON.parse(await readFile(filename, 'utf8'));
  const message = changes => ({ chatId: 'wxid_synthetic_target', text: '合成咨询回复。', idempotencyKey: 'synthetic-request-one', ...changes });
  t.after(async () => {
    await service.close();
    await new Promise(resolve => server.close(resolve));
    const actual = await realpath(root);
    assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(actual).startsWith('kexu-native-manager-test-'));
    // 仅删除本测试创建的临时目录，不接触真实组件、账号或聊天。
    await rm(actual, { recursive: true, force: true });
  });
  return { root, senderDirectory, filename, service, calls, setupCalls, call, install, enable, readConfig, message, switchWorkspace: token => { current = token; }, replaceHandler: value => { handler = value; } };
}

test('原生管理API安装异步去重，启用只绑定账号且不启动接待，不公开私有字段', async t => {
  const installation = deferred();
  const f = await fixture(t, { setupRun: () => installation.promise });
  assert.equal(typeof f.service.status, 'function', '工厂同步返回服务对象');
  const before = await f.service.status();
  assert.equal(before.configured, false);
  assert.equal(before.installed, false);
  assert.equal(before.requiresForeground, false);
  assert.equal(before.componentVersion, PIN);
  assert.equal(f.calls.length, 0, '普通状态不调用原生worker');
  const first = await f.call('/setup', {});
  assert.equal(first.status, 202);
  assert.equal(first.data.setupState, 'installing');
  assert.equal((await f.call('/setup', {})).data.setupState, 'installing');
  assert.equal(f.setupCalls.length, 1);
  installation.resolve({ installed: true });
  for (let index = 0; index < 20 && (await f.service.status()).setupState === 'installing'; index++) await new Promise(resolve => setTimeout(resolve, 1));
  const enabled = await f.call('/enable', {});
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.enabled, true);
  assert.equal(enabled.data.ready, true);
  assert.equal(enabled.data.canSend, true, '组件能发送与接待是否running分开');
  assert.equal(enabled.data.configured, true);
  for (const name of ['pid', 'selfWxid', 'processCreated', 'helperRoot', 'pythonPath', 'allowedChatIds', 'ignoredPrivate']) assert.ok(!(name in enabled.data));
  assert.ok(!JSON.stringify(enabled.data).includes('SYNTHETIC_PRIVATE'));
  const saved = await f.readConfig();
  assert.equal(saved.enabled, true);
  assert.equal(saved.running, false);
  assert.deepEqual(saved.allowedChatIds, []);
  assert.equal(saved.selfWxid, 'wxid_synthetic_self');
  assert.equal(saved.workspaceToken, workspace.workspaceToken);
  assert.ok(Number.isSafeInteger(saved.settingsGeneration));
  assert.equal((await f.service.send(f.message())).status, 'failed');
  assert.deepEqual(f.calls.map(item => item.action), ['bind']);
});

test('同源、工作区和空JSON门禁拒绝浏览器指定PID、账号、路径或发送正文', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/status', undefined, { Origin: 'https://outside.example' })).status, 403);
  assert.equal((await f.call('/status', undefined, { 'X-Kexu-Workspace': 'legacy@1' })).status, 409);
  assert.equal((await f.call('/setup', {}, { 'X-Kexu-Local': '0' })).status, 403);
  for (const body of [{ pid: 1234 }, { selfWxid: 'wxid_other' }, { pythonPath: 'C:/outside.exe' }, { text: '不得发送' }, [], null]) assert.equal((await f.call('/enable', body)).status, 400);
  assert.equal((await f.call('/send', {})).status, 405);
  assert.equal((await f.call('/enable', undefined, {}, 'GET')).status, 405);
  assert.equal(f.calls.length, 0);
  assert.equal(f.setupCalls.length, 0);
  f.switchWorkspace('acct-bbbbbbbbbbbbbbbbbbbb@2');
  assert.equal((await f.call('/setup', {})).status, 409);
  assert.equal((await f.call('/status')).status, 409);
});

test('原生发送严格映射白名单并传generation，暂停保留组件选择，禁用可安全回调再次pause', async t => {
  let f;
  let callbacks = 0;
  f = await fixture(t, { onDisable: async () => { callbacks++; await f.service.pause(); } });
  await f.enable();
  await f.service.start(configuration());
  const before = await f.readConfig();
  assert.equal(before.running, true);
  assert.deepEqual(before.allowedChatIds, ['wxid_synthetic_target']);
  const sent = await f.service.send(f.message());
  assert.equal(sent.status, 'sent');
  const dispatch = f.calls.find(item => item.action === 'send');
  assert.deepEqual(dispatch.input, { ...f.message(), workspaceToken: workspace.workspaceToken, generation: before.settingsGeneration });
  assert.ok(!dispatch.args.includes(f.message().text));
  assert.equal(sent.workspaceToken, workspace.workspaceToken);
  const takeover = configuration(); takeover.customers[0].humanTakeover = true;
  await f.service.syncConfig(takeover);
  const changed = await f.readConfig();
  assert.equal(changed.running, false);
  assert.deepEqual(changed.allowedChatIds, []);
  assert.ok(changed.settingsGeneration > before.settingsGeneration);
  assert.equal((await f.service.send(f.message({ idempotencyKey: 'synthetic-after-takeover' }))).status, 'failed');
  await f.service.start(configuration());
  const pause = f.service.pause();
  assert.equal((await f.service.send(f.message({ idempotencyKey: 'synthetic-after-pause' }))).status, 'failed');
  await pause;
  const paused = await f.readConfig();
  assert.equal(paused.enabled, true);
  assert.equal(paused.running, false);
  const disabled = await f.call('/disable', {});
  assert.equal(disabled.status, 200);
  assert.equal(disabled.data.enabled, false);
  assert.equal(disabled.data.configured, true, '明确选过native后禁用不能退回HTTP发送器');
  assert.equal(callbacks, 1, '锁外回调可递归pause而不会死锁');
  assert.equal((await f.readConfig()).enabled, false);
});

test('坏白名单、群聊、无NUL约束或过长UTF8正文不会启动发送worker', async t => {
  const f = await fixture(t);
  await f.enable();
  for (const change of [config => { config.customers.push({ ...config.customers[0] }); }, config => { config.customers[0].wechatId = 'room@chatroom'; }, config => { config.settings.selectedCustomerIds = Array.from({ length: 21 }, (_, i) => `customer-${i}`); }]) {
    const config = configuration(); change(config);
    await assert.rejects(f.service.start(config));
  }
  await f.service.start(configuration());
  for (const change of [{ chatId: 'wxid_other' }, { text: '中'.repeat(342) }, { text: '\0' }, { text: '\ud800' }, { idempotencyKey: '' }, { idempotencyKey: 'bad\nkey' }]) assert.equal((await f.service.send(f.message(change))).status, 'failed');
  assert.equal(f.calls.filter(item => item.action === 'send').length, 0);
});

test('HTTP成功、假ID或错误回执一律unknown，只有严格原生凭证可为sent', async t => {
  let response = input => receipt(input);
  const f = await fixture(t, { run: async (action, _args, input) => action === 'bind' ? { ready: true, compatible: true, installed: true, pid: 1234, processCreated: '123456789', selfWxid: 'wxid_synthetic_self' } : action === 'inspect' ? { ready: true, compatible: true, installed: true } : response(input) });
  await f.enable(); await f.service.start(configuration());
  const changes = [{ status: 'success' }, { chatId: 'wxid_other' }, { messageId: '0' }, { messageId: 'synthetic-id' }, { readback: false }, { workspaceToken: 'legacy@1' }, { textSha256: '0'.repeat(64) }];
  for (const [index, change] of changes.entries()) {
    response = input => ({ ...receipt(input), ...change });
    assert.equal((await f.service.send(f.message({ idempotencyKey: `synthetic-bad-${index}` }))).status, 'unknown');
  }
  response = input => receipt(input);
  assert.equal((await f.service.send(f.message({ idempotencyKey: 'synthetic-good' }))).status, 'sent');
});

test('caller超时后仍持有原生发送锁，pause/close不kill且等worker实际退出', async t => {
  const entered = deferred();
  const exit = deferred();
  const f = await fixture(t, { sendTimeoutMs: 15, run: async (action, _args, input) => {
    if (action === 'bind') return { ready: true, compatible: true, installed: true, pid: 1234, processCreated: '123456789', selfWxid: 'wxid_synthetic_self' };
    if (action === 'inspect') return { ready: true, compatible: true, installed: true };
    entered.resolve(); await exit.promise; return receipt(input);
  } });
  await f.enable(); await f.service.start(configuration());
  const first = f.service.send(f.message());
  await entered.promise;
  assert.equal((await first).code, 'NATIVE_WAIT_TIMEOUT');
  assert.equal((await f.service.send(f.message({ idempotencyKey: 'synthetic-second' }))).code, 'NATIVE_SEND_BUSY');
  assert.equal(f.calls.filter(item => item.action === 'send').length, 1);
  await f.service.pause();
  assert.equal((await f.readConfig()).running, false);
  let closed = false;
  const closing = f.service.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(closed, false);
  exit.resolve(); await closing;
  assert.equal(closed, true);
});

test('相同授权轮询不改generation或active，也不会让在途发送的回读失效', async t => {
  const entered = deferred();
  const exit = deferred();
  const f = await fixture(t, { run: async (action, _args, input) => {
    if (action === 'bind') return { ready: true, compatible: true, installed: true, pid: 1234, processCreated: '123456789', selfWxid: 'wxid_synthetic_self' };
    if (action === 'inspect') return { ready: true, compatible: true, installed: true };
    entered.resolve(); await exit.promise; return receipt(input);
  } });
  await f.enable(); await f.service.start(configuration());
  const before = await f.readConfig();
  const pending = f.service.send(f.message());
  await entered.promise;
  for (let index = 0; index < 4; index++) {
    const polled = configuration();
    polled.customers[0].name = `合成显示名称${index}`;
    polled.products = [{ name: `与原生授权无关的商品${index}` }];
    await f.service.syncConfig(polled);
  }
  assert.deepEqual(await f.readConfig(), before, '无授权变化时不写配置或换generation');
  assert.equal((await f.service.send(f.message({ idempotencyKey: 'synthetic-concurrent' }))).code, 'NATIVE_SEND_BUSY', '仍在运行，不能被轮询意外暂停');
  exit.resolve();
  assert.equal((await pending).status, 'sent');
  const disabled = configuration(); disabled.settings.enabled = false;
  await f.service.syncConfig(disabled);
  const stopped = await f.readConfig();
  assert.equal(stopped.running, false);
  assert.ok(stopped.settingsGeneration > before.settingsGeneration);
  await f.service.syncConfig(structuredClone(disabled));
  assert.deepEqual(await f.readConfig(), stopped);
});

test('授权签名只比较实际成员集合，显示排序变化不增加generation', async t => {
  const f = await fixture(t);
  await f.enable();
  const config = configuration();
  config.settings.selectedCustomerIds.push('customer-two');
  config.customers.push({ id: 'customer-two', wechatId: 'wxid_synthetic_second', autoReplyEnabled: true });
  await f.service.start(config);
  const before = await f.readConfig();
  config.settings.selectedCustomerIds.reverse(); config.customers.reverse();
  await f.service.syncConfig(config);
  assert.deepEqual(await f.readConfig(), before);
  assert.equal((await f.service.send(f.message({ chatId: 'wxid_synthetic_second' }))).status, 'sent');
});

test('readonly probe缓存10秒并合并并发请求，start与enable强制重新核验', async t => {
  let clock = 100_000;
  let inspectCalls = 0;
  let wait = false;
  const entered = deferred();
  const exit = deferred();
  const f = await fixture(t, { now: () => clock, run: async action => {
    if (action === 'bind') return { ready: true, compatible: true, installed: true, pid: 1234, processCreated: '123456789', selfWxid: 'wxid_synthetic_self' };
    assert.equal(action, 'inspect');
    inspectCalls++;
    if (wait) { entered.resolve(); await exit.promise; }
    return { ready: true, compatible: true, installed: true };
  } });
  await f.enable();
  assert.equal((await f.service.status({ probe: true })).ready, true);
  assert.equal(inspectCalls, 0, '刚完成的bind可供状态使用');
  await f.service.start(configuration());
  assert.equal(inspectCalls, 1, 'start忽略10秒缓存');
  await Promise.all(Array.from({ length: 4 }, () => f.service.status({ probe: true })));
  assert.equal(inspectCalls, 1);
  clock += 10_001; wait = true;
  const statuses = Promise.all(Array.from({ length: 4 }, () => f.service.status({ probe: true })));
  await entered.promise;
  assert.equal(inspectCalls, 2, '并发状态只启动一次过期预检');
  exit.resolve();
  assert.ok((await statuses).every(state => state.ready));
  wait = false;
  await f.service.start(configuration());
  assert.equal(inspectCalls, 3, '缓存未到期也重新预检start');
  assert.equal((await f.call('/enable', {})).status, 200);
  assert.equal(f.calls.filter(item => item.action === 'bind').length, 2, 'enable不复用旧绑定');
});

test('发送在途时即使10秒缓存过期也不inspect，避免临时DLL触发bridge_busy假失败', async t => {
  let clock = 100_000;
  let nativeRunning = false;
  let inspectCalls = 0;
  const entered = deferred();
  const exit = deferred();
  const f = await fixture(t, { now: () => clock, run: async (action, _args, input) => {
    if (action === 'bind') return { ready: true, compatible: true, installed: true, pid: 1234, processCreated: '123456789', selfWxid: 'wxid_synthetic_self' };
    if (action === 'inspect') { inspectCalls++; return nativeRunning ? { ready: false, compatible: false, installed: true, code: 'BRIDGE_BUSY' } : { ready: true, compatible: true, installed: true }; }
    nativeRunning = true; entered.resolve(); await exit.promise; nativeRunning = false; return receipt(input);
  } });
  await f.enable(); await f.service.start(configuration());
  assert.equal(inspectCalls, 1);
  const pending = f.service.send(f.message());
  await entered.promise;
  clock += 12_000;
  const statuses = await Promise.all(Array.from({ length: 5 }, () => f.service.status({ probe: true })));
  assert.equal(inspectCalls, 1);
  assert.ok(statuses.every(state => state.ready && state.canSend));
  exit.resolve(); assert.equal((await pending).status, 'sent');
  assert.equal((await f.service.status({ probe: true })).ready, true);
  assert.equal(inspectCalls, 2, 'worker退出后恢复已过期的只读核验');
});

test('发送等待已经开始的readonly probe退出，之后状态不会再插入新probe', async t => {
  let clock = 100_000;
  let wait = false;
  const entered = deferred();
  const exit = deferred();
  let dispatches = 0;
  const f = await fixture(t, { now: () => clock, run: async (action, _args, input) => {
    if (action === 'bind') return { ready: true, compatible: true, installed: true, pid: 1234, processCreated: '123456789', selfWxid: 'wxid_synthetic_self' };
    if (action === 'inspect') { if (wait) { entered.resolve(); await exit.promise; } return { ready: true, compatible: true, installed: true }; }
    dispatches++; return receipt(input);
  } });
  await f.enable(); await f.service.start(configuration());
  clock += 10_001; wait = true;
  const checking = f.service.status({ probe: true });
  await entered.promise;
  const pending = f.service.send(f.message());
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(dispatches, 0);
  exit.resolve(); await checking;
  assert.equal((await pending).status, 'sent');
  assert.equal(dispatches, 1);
});

test('旧服务关闭不覆盖同scope新revision已写入的配置', async t => {
  const f = await fixture(t);
  await f.enable(); await f.service.start(configuration());
  const next = { ...await f.readConfig(), workspaceToken: `${workspace.id}@2`, settingsGeneration: 100, enabled: true, running: false };
  await writeFile(f.filename, JSON.stringify(next), 'utf8');
  f.switchWorkspace(next.workspaceToken);
  await f.service.close();
  assert.deepEqual(await f.readConfig(), next);
});

test('安装失败和非Windows状态不泄露runner异常，也不绑定或发送', async t => {
  const failed = await fixture(t, { setupRun: async () => { throw new Error('SYNTHETIC_PRIVATE_INSTALL_ERROR'); } });
  assert.equal((await failed.call('/setup', {})).status, 202);
  for (let index = 0; index < 20 && (await failed.service.status()).setupState === 'installing'; index++) await new Promise(resolve => setTimeout(resolve, 1));
  const result = await failed.service.status();
  assert.equal(result.setupState, 'failed');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_INSTALL'));
  assert.equal((await failed.call('/enable', {})).status, 503);
  assert.equal(failed.calls.length, 0);
  const other = await fixture(t, { platform: 'linux' });
  assert.equal((await other.service.status({ probe: true })).available, false);
  assert.equal((await other.call('/setup', {})).status, 503);
  assert.equal(other.calls.length, 0);
  assert.equal(other.setupCalls.length, 0);
});

test('配置损坏仍标记configured，避免静默改用其他发送器', async t => {
  const f = await fixture(t);
  await f.enable();
  await writeFile(f.filename, '{"private-invalid":"SYNTHETIC_PRIVATE_CONFIG"}', 'utf8');
  const state = await f.service.status({ probe: true });
  assert.equal(state.configured, true);
  assert.equal(state.ready, false);
  assert.ok(!JSON.stringify(state).includes('PRIVATE_CONFIG'));
  await assert.rejects(f.service.start(configuration()));
  // 测试自行恢复合成配置后再由fixture清理，生产不会自动覆盖损坏内容。
  await rm(f.filename);
});

test('spawn固定参数采用stdin UTF8且不在超量、失败时调用kill', async () => {
  let child;
  let invocation;
  let kills = 0;
  const sent = [];
  const run = createNativeSenderRunner((command, args, options) => {
    invocation = { command, args, options };
    child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.on('data', chunk => sent.push(chunk));
    child.kill = () => { kills++; };
    return child;
  });
  const input = { workspaceToken: 'legacy@1', text: '仅合成中文正文' };
  const result = run({ command: 'fixed-python.exe', args: ['-B', 'fixed-script.py', 'send'], cwd: 'fixed-workspace', input });
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsHide, true);
  assert.ok(!invocation.args.includes(input.text));
  child.stdout.write(JSON.stringify({ status: 'unknown' }));
  child.emit('close', 2, null);
  assert.deepEqual(await result, { status: 'unknown' });
  assert.deepEqual(JSON.parse(Buffer.concat(sent).toString('utf8')), input);
  const oversized = run({ command: 'fixed-python.exe', args: ['send'], cwd: 'fixed-workspace' });
  child.stdout.write('x'.repeat(130_000));
  let done = false;
  const settled = oversized.catch(error => { done = true; return error; });
  await Promise.resolve();
  assert.equal(done, false, '超量输出仍等待实际子进程close');
  assert.equal(kills, 0);
  child.emit('close', 0, null);
  assert.equal((await settled).code, 'NATIVE_PROCESS_UNVERIFIED');
  assert.equal(kills, 0);
});
