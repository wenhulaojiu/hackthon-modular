import assert from 'node:assert/strict';
import test from 'node:test';

let moduleId = 0;
const freshWorkspace = () => import(`../lib/client-workspace.ts?case=${moduleId++}`) as Promise<typeof import('../lib/client-workspace')>;
const accountToken = 'acct-0123456789abcdef0123@2';
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('旧页面排队的保存不能在切换后使用新账号标识', async t => {
  const workspace = await freshWorkspace();
  workspace.setWorkspaceToken('legacy@1');
  const previous = workspace.captureWorkspace();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests += 1; return jsonResponse({}); });
  workspace.beginWorkspaceSwitch();
  workspace.setWorkspaceToken(accountToken);
  await assert.rejects(workspace.workspaceFetch('/api/state', { method: 'POST', body: '旧客户数据' }, previous), { code: 'WORKSPACE_CHANGED' });
  assert.throws(() => workspace.captureWorkspace(), { code: 'WORKSPACE_CHANGED' });
  assert.equal(requests, 0);
});

test('请求已发出时切换账号，迟到结果仍会被丢弃', async t => {
  const workspace = await freshWorkspace();
  workspace.setWorkspaceToken('legacy@1');
  let finish!: (response: Response) => void;
  let requestSignal: AbortSignal | null | undefined;
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => { requestSignal = init?.signal; return new Promise<Response>(resolve => { finish = resolve; }); });
  const pending = workspace.workspaceFetch('/api/ai', { method: 'POST' });
  workspace.beginWorkspaceSwitch();
  assert.equal(requestSignal?.aborted, true);
  finish(jsonResponse({ summary: '旧账号的画像' }));
  await assert.rejects(pending, { code: 'WORKSPACE_CHANGED' });
});

test('普通保存冲突不锁定账号，明确的账号冲突会中止其他请求', async t => {
  const workspace = await freshWorkspace();
  workspace.setWorkspaceToken('legacy@1');
  let changed = false;
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(changed ? { error: '微信账号已切换', code: 'WORKSPACE_CHANGED' } : { error: '数据版本冲突', revision: 5 }, 409));
  const conflict = await workspace.workspaceFetch('/api/state', { method: 'POST' });
  assert.equal(conflict.status, 409);
  assert.equal(workspace.getWorkspaceInvalidation(), '');
  const controller = new AbortController();
  workspace.registerWorkspaceController(controller);
  changed = true;
  await assert.rejects(workspace.workspaceFetch('/api/state', { method: 'POST' }), { code: 'WORKSPACE_CHANGED' });
  assert.equal(controller.signal.aborted, true);
});

test('跨页面状态返回其他账号时锁定，账号偏好范围不含连接版本', async t => {
  const workspace = await freshWorkspace();
  workspace.setWorkspaceToken('acct-0123456789abcdef0123@2');
  assert.equal(workspace.getWorkspaceScope(), 'acct-0123456789abcdef0123');
  workspace.setWorkspaceToken('acct-0123456789abcdef0123@4');
  assert.equal(workspace.getWorkspaceScope(), 'acct-0123456789abcdef0123');
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ active: { workspaceToken: 'legacy@5' } }));
  await assert.rejects(workspace.workspaceFetch('/__local-wechat/accounts'), { code: 'WORKSPACE_CHANGED' });
});
