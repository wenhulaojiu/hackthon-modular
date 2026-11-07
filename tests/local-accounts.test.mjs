import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createAccountRegistry } from '../scripts/local-wechat/accounts.mjs';
import { createLocalAccountRuntime } from '../scripts/local-wechat/vite-plugin.mjs';
import { createLocalWechatService } from '../scripts/local-wechat/service.mjs';
import { createLocalReplyService } from '../scripts/local-wechat/reply-service.mjs';
import { DEFAULT_REPLY_SETTINGS } from '../scripts/local-wechat/reply-engine.mjs';

async function fixture(t, extra = {}) {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'kexu-accounts-test-'));
  const closers = [];
  t.after(async () => {
    for (const close of closers) await close();
    const actual = await realpath(root);
    // 删除只限本次合成目录；绝不触及真实微信和桌面用户数据。
    assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(actual).startsWith('kexu-accounts-test-'));
    await rm(actual, { recursive: true, force: true });
  });
  const dataRoot = path.join(root, 'synthetic-wechat');
  const firstDb = path.join(dataRoot, 'synthetic_account_A', 'db_storage');
  const secondDb = path.join(dataRoot, 'synthetic_account_B', 'db_storage');
  const exporterRoot = path.join(root, 'exporter');
  const pythonPath = path.join(root, 'python.exe');
  await Promise.all([mkdir(firstDb, { recursive: true }), mkdir(secondDb, { recursive: true }), mkdir(path.join(dataRoot, 'unrelated'), { recursive: true }), mkdir(path.join(exporterRoot, 'scripts'), { recursive: true }), mkdir(path.join(root, '.local-wechat'))]);
  await writeFile(path.join(exporterRoot, 'scripts', 'export_wechat.py'), '# 合成占位文件，不执行。\n', 'utf8');
  await writeFile(pythonPath, '合成占位文件，不执行。', 'utf8');
  const config = { exporterRoot, pythonPath, dbDir: firstDb, ...extra };
  const configFile = path.join(root, '.local-wechat', 'config.json');
  await writeFile(configFile, JSON.stringify(config), 'utf8');
  return { root, dataRoot, firstDb, secondDb, config, configFile, closers };
}

test('账号登记只公开目录身份：原绑定保持legacy，选择后保留其余配置且可恢复旧工作区', async t => {
  const f = await fixture(t, { customSetting: { enabled: true } });
  const queueDirectory = path.join(f.root, '.local-wechat', 'replies');
  await mkdir(queueDirectory);
  const queueFile = path.join(queueDirectory, 'queue.json');
  const originalQueue = '原有队列字节，不应迁移或覆盖。';
  await writeFile(queueFile, originalQueue, 'utf8');
  const registry = await createAccountRegistry({ root: f.root });
  const listed = await registry.list();
  assert.equal(listed.active.id, 'legacy');
  assert.equal(listed.active.workspaceToken, 'legacy@1');
  assert.equal(listed.accounts.length, 2);
  assert.equal(listed.accounts.filter(item => item.active).length, 1);
  assert.ok(!JSON.stringify(listed).includes(f.root));
  assert.ok(!JSON.stringify(listed).includes('db_storage'));
  const next = listed.accounts.find(item => !item.active);
  assert.match(next.id, /^acct-[a-f0-9]{20}$/);
  await assert.rejects(registry.select(f.secondDb), /列表/);
  await assert.rejects(registry.select('acct-' + 'f'.repeat(20)), /不可用/);
  const selected = await registry.select(next.id);
  assert.equal(selected.workspaceToken, `${next.id}@2`);
  assert.deepEqual(JSON.parse(await readFile(f.configFile, 'utf8')), { ...f.config, dbDir: await realpath(f.secondDb) });
  assert.equal(await readFile(queueFile, 'utf8'), originalQueue);
  const reopened = await createAccountRegistry({ root: f.root });
  assert.equal(reopened.active().workspaceToken, selected.workspaceToken);
  assert.equal((await reopened.select('legacy')).workspaceToken, 'legacy@3');
  assert.equal(JSON.parse(await readFile(f.configFile, 'utf8')).dbDir, await realpath(f.firstDb));
  assert.equal(await readFile(queueFile, 'utf8'), originalQueue);
});

test('未完成切换的恢复日志回滚配置，不把新目录误认作旧CRM账号', async t => {
  const f = await fixture(t);
  await createAccountRegistry({ root: f.root });
  const registryFile = path.join(f.root, '.local-wechat', 'accounts.json');
  const saved = JSON.parse(await readFile(registryFile, 'utf8'));
  await writeFile(registryFile, JSON.stringify({ ...saved, pending: { previousConfig: f.config } }), 'utf8');
  await writeFile(f.configFile, JSON.stringify({ ...f.config, dbDir: f.secondDb }), 'utf8');
  const recovered = await createAccountRegistry({ root: f.root });
  assert.equal(recovered.active().workspaceToken, 'legacy@1');
  assert.deepEqual(JSON.parse(await readFile(f.configFile, 'utf8')), f.config);
  assert.equal(JSON.parse(await readFile(registryFile, 'utf8')).pending, undefined);
});

async function serveRuntime(t, f, runner) {
  let runtime;
  let stoppedReplies = 0;
  const server = http.createServer((request, response) => {
    void runtime.handle(request, response).then(handled => {
      if (!handled) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ scope: request.headers['x-kexu-local-scope'], revision: request.headers['x-kexu-local-revision'], raw: request.rawHeaders })); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  runtime = await createLocalAccountRuntime({
    root: f.root, origin,
    readerFactory: options => createLocalWechatService({ ...options, platform: 'win32', runner }),
    replyFactory: async () => ({ handle: async () => false, close: async () => { stoppedReplies++; } }),
  });
  f.closers.push(async () => { await runtime.close(); await new Promise(resolve => server.close(resolve)); });
  const call = async (route, data, token, extra = {}) => {
    const response = await fetch(origin + route, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'X-Kexu-Local': '1', 'Content-Type': 'application/json', ...(token ? { 'X-Kexu-Workspace': token } : {}), ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  };
  return { runtime, call, stoppedReplies: () => stoppedReplies };
}

const listing = () => ({ code: 0, stdout: JSON.stringify({ status: 'listed', chats: [{ username: 'wxid_synthetic', name: '合成好友', type: 'private' }], message_bodies_read: false, files_written: false }) });

test('原生中间件覆盖伪造作用域头，SSR可bootstrap，旧页面不能跨账号写入', async t => {
  const f = await fixture(t);
  const runtime = await serveRuntime(t, f, async () => listing());
  const initial = await runtime.call('/api/state', undefined, undefined, { 'X-Kexu-Local-Scope': 'forged', 'X-Kexu-Local-Revision': '999' });
  assert.equal(initial.status, 200);
  assert.equal(initial.data.scope, 'legacy');
  assert.equal(initial.data.revision, '1');
  assert.ok(!initial.data.raw.includes('forged'));
  assert.equal((await runtime.call('/')).data.scope, 'legacy');
  const blocked = await runtime.call('/api/state', { state: {} });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'WORKSPACE_CHANGED');
  const accounts = (await runtime.call('/__local-wechat/accounts')).data;
  const next = accounts.accounts.find(account => !account.active);
  const selected = await runtime.call('/__local-wechat/accounts/select', { accountId: next.id }, 'legacy@1');
  assert.equal(selected.status, 200);
  assert.equal(selected.data.workspaceToken, `${next.id}@2`);
  assert.equal(selected.data.reload, true);
  assert.equal(selected.data.active.id, next.id);
  assert.equal(runtime.stoppedReplies(), 1);
  assert.equal((await runtime.call('/api/secret', { apiKey: 'synthetic' }, 'legacy@1')).status, 409);
  assert.equal((await runtime.call('/api/state', undefined, selected.data.workspaceToken)).data.scope, next.id);
  const stale = await runtime.call('/__local-wechat/chats', { query: '' }, 'legacy@1');
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'WORKSPACE_CHANGED');
  assert.equal((await runtime.call('/__local-wechat/status')).data.workspaceToken, `${next.id}@2`);
});

test('换号先取消并等待读取退出，busy时拒绝请求，旧任务结果无法跨工作区读取', async t => {
  const f = await fixture(t);
  let aborted = false;
  let entered = false;
  let release;
  const runtime = await serveRuntime(t, f, async input => {
    if (input.args.some(value => value.startsWith('--list-chats='))) return listing();
    entered = true;
    return await new Promise(resolve => input.signal.addEventListener('abort', () => { aborted = true; release = () => resolve({ code: null, stdout: '', stderr: '' }); }, { once: true }));
  });
  const accounts = (await runtime.call('/__local-wechat/accounts')).data;
  const next = accounts.accounts.find(account => !account.active);
  await runtime.call('/__local-wechat/chats', { query: '' }, 'legacy@1');
  const created = await runtime.call('/__local-wechat/exports', { chatIds: ['wxid_synthetic'], start: '2026-11-01', end: '2026-11-01' }, 'legacy@1');
  assert.equal(created.status, 202);
  for (let count = 0; count < 100 && !entered; count++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(entered, true);
  let finished = false;
  const switching = runtime.call('/__local-wechat/accounts/select', { accountId: next.id }, 'legacy@1').then(result => { finished = true; return result; });
  for (let count = 0; count < 100 && !aborted; count++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(aborted, true);
  assert.equal(finished, false);
  assert.equal((await runtime.call('/__local-wechat/accounts')).status, 503);
  assert.equal((await runtime.call('/api/state')).status, 503);
  release();
  const selected = await switching;
  assert.equal(selected.status, 200);
  const old = await runtime.call(`/__local-wechat/jobs/${created.data.jobId}`, undefined, 'legacy@1');
  assert.equal(old.status, 409);
  assert.equal(old.data.code, 'WORKSPACE_CHANGED');
  const missing = await runtime.call(`/__local-wechat/jobs/${created.data.jobId}`, undefined, selected.data.workspaceToken);
  assert.equal(missing.status, 404);
  assert.equal(missing.data.exports, undefined);
});

test('外部直接更改dbDir不能绕过账号隔离，明确重选可修复绑定', async t => {
  const f = await fixture(t);
  let reads = 0;
  const runtime = await serveRuntime(t, f, async () => { reads++; return listing(); });
  await writeFile(f.configFile, JSON.stringify({ ...f.config, dbDir: f.secondDb }), 'utf8');
  const denied = await runtime.call('/__local-wechat/chats', { query: '' }, 'legacy@1');
  assert.equal(denied.status, 503);
  assert.match(denied.data.error, /其他程序更改/);
  assert.equal(reads, 0);
  const recovered = await runtime.call('/__local-wechat/accounts/select', { accountId: 'legacy' }, 'legacy@1');
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.workspaceToken, 'legacy@2');
  assert.equal(JSON.parse(await readFile(f.configFile, 'utf8')).dbDir, await realpath(f.firstDb));
  assert.equal((await runtime.call('/__local-wechat/chats', { query: '' }, 'legacy@2')).status, 200);
  assert.equal(reads, 1);
});

const replyConfig = () => ({ settings: { ...structuredClone(DEFAULT_REPLY_SETTINGS), enabled: true, debounceSeconds: 0, selectedCustomerIds: ['c1'], businessHours: { enabled: false, start: '09:00', end: '18:00', days: [1] } }, customers: [{ id: 'c1', wechatId: 'wxid_synthetic', name: '合成客户', autoReplyEnabled: true }], products: [], storeName: '合成门店', industry: '通用门店' });

test('接待队列按账号保存，后台生成携带捕获token，换号后的批准和发送被拦截', async t => {
  const f = await fixture(t);
  let service;
  let token = 'legacy@1';
  let active = false;
  let sends = 0;
  const generated = [];
  const adapter = { status: async () => ({ canReceive: true, canSend: true }), start: async () => { active = true; }, pause: () => { active = false; }, syncConfig() {}, fail() {}, poll: async () => active ? [{ id: 'synthetic-native-message', chatId: 'wxid_synthetic', sender: 'customer', text: '请介绍一下服务。', date: new Date().toISOString(), source: 'realtime', kind: 'text' }] : [], send: async () => { sends++; return { status: 'sent', messageId: 'synthetic-outgoing' }; } };
  const server = http.createServer((request, response) => { void service.handle(request, response); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const make = workspace => createLocalReplyService({ root: f.root, origin, adapter, pollMs: 60_000, workspace, currentWorkspace: () => token, fetch: async (_url, input) => { generated.push(input.headers['X-Kexu-Workspace']); return Response.json({ action: 'reply', reply: '你好，请问需要了解哪项服务？', productIds: [], reason: '合成回复' }); } });
  service = await make({ id: 'legacy', label: '旧号', workspaceToken: token });
  f.closers.push(async () => { await service.close(); await new Promise(resolve => server.close(resolve)); });
  const call = async (route, data, expected = token) => {
    const response = await fetch(`${origin}/__local-wechat/replies${route}`, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'X-Kexu-Local': '1', 'X-Kexu-Workspace': expected, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await call('/config', replyConfig())).status, 200);
  assert.equal((await call('/start', {})).status, 200);
  let status;
  for (let count = 0; count < 100; count++) {
    status = (await call('/status')).data;
    if (status.counts.draft) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(generated, ['legacy@1']);
  assert.equal(status.counts.draft, 1);
  const oldFile = path.join(f.root, '.local-wechat', 'replies', 'queue.json');
  const originalQueue = await readFile(oldFile, 'utf8');
  token = 'acct-' + 'a'.repeat(20) + '@2';
  const denied = await call(`/jobs/${status.jobs[0].id}/approve`, {}, 'legacy@1');
  assert.equal(denied.status, 409);
  assert.equal(denied.data.code, 'WORKSPACE_CHANGED');
  assert.equal(sends, 0);
  await service.close();
  service = await make({ id: token.split('@')[0], label: '新号', workspaceToken: token });
  assert.equal((await call('/status')).data.jobs.length, 0);
  assert.equal((await call('/status')).data.running, false);
  assert.equal(await readFile(oldFile, 'utf8'), originalQueue);
  assert.equal(JSON.parse(await readFile(path.join(f.root, '.local-wechat', 'replies', token.split('@')[0], 'queue.json'), 'utf8')).jobs.length, 0);
});
