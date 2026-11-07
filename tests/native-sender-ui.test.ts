import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeSenderCanEnable, nativeSenderRequest, replySettingsFor } from '../app/components/reply-ui.ts';
import { setWorkspaceToken } from '../lib/client-workspace.ts';
import type { AppState, NativeSenderStatus } from '../lib/types';

const component: NativeSenderStatus = { available: true, installed: true, enabled: false, ready: false, compatible: true, requiresForeground: false, message: '组件已暂停', componentVersion: 'test-version', source: 'helper', setupState: 'ready' };
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const localWindow = () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { protocol: 'http:', hostname: '127.0.0.1' } } });
  return () => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); };
};

test('首次未绑定时可进入启用核对，安装中或未安装时仍阻断', () => {
  assert.equal(nativeSenderCanEnable({ ...component, compatible: false, ready: false, message: '请点击启用完成当前账号核对。' }), true);
  assert.equal(nativeSenderCanEnable({ ...component, installed: false }), false);
  assert.equal(nativeSenderCanEnable({ ...component, available: false }), false);
  assert.equal(nativeSenderCanEnable({ ...component, setupState: 'installing' }), false);
  assert.equal(nativeSenderCanEnable({ ...component, enabled: true }), false);
});

test('原生组件状态查询只读且携带当前工作区标识', async t => {
  t.after(localWindow()); setWorkspaceToken('legacy@1');
  let request: { url: string; init?: RequestInit } | undefined;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => { request = { url: String(input), init }; return jsonResponse(component); });
  assert.deepEqual(await nativeSenderRequest('status'), component);
  assert.equal(request?.url, '/__local-wechat/native-sender/status');
  assert.equal(request?.init?.method, 'GET');
  assert.equal(request?.init?.body, undefined);
  assert.equal(new Headers(request?.init?.headers).get('X-Kexu-Workspace'), 'legacy@1');
  assert.equal(new Headers(request?.init?.headers).get('X-Kexu-Local'), '1');
});

test('安装启停只调用组件接口并提交空对象，不携带聊天或密钥', async t => {
  t.after(localWindow()); setWorkspaceToken('legacy@1');
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => { requests.push({ url: String(input), init }); return jsonResponse(component); });
  for (const action of ['setup', 'enable', 'disable'] as const) await nativeSenderRequest(action);
  assert.deepEqual(requests.map(request => request.url), ['setup', 'enable', 'disable'].map(action => `/__local-wechat/native-sender/${action}`));
  for (const request of requests) {
    assert.equal(request.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(request.init?.body)), {});
    assert.equal(new Headers(request.init?.headers).get('Content-Type'), 'application/json');
  }
});

test('原生组件拒绝旧服务的残缺状态与前台发送能力', async t => {
  t.after(localWindow()); setWorkspaceToken('legacy@1');
  let response: unknown = { ready: true };
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(response));
  await assert.rejects(nativeSenderRequest('status'), /状态不完整/);
  response = { ...component, requiresForeground: true };
  await assert.rejects(nativeSenderRequest('status'), /状态不完整/);
  response = { error: '当前微信构建不兼容' };
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(response, 409));
  await assert.rejects(nativeSenderRequest('enable'), /当前微信构建不兼容/);
});

test('在线页面不会连接原生组件，缺省等待10秒且显式60秒保持', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { protocol: 'https:', hostname: 'example.test' } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return jsonResponse(component); });
  await assert.rejects(nativeSenderRequest('setup'), /Windows 本地版/);
  assert.equal(calls, 0);
  assert.equal(replySettingsFor({} as AppState).debounceSeconds, 10);
  const explicit = { ...replySettingsFor({} as AppState), debounceSeconds: 60 };
  assert.equal(replySettingsFor({ replySettings: explicit } as AppState).debounceSeconds, 60);
});

test('切换工作区时丢弃迟到的组件操作结果', async t => {
  t.after(localWindow()); setWorkspaceToken('legacy@1');
  let finish!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', async () => new Promise<Response>(resolve => { finish = resolve; }));
  const pending = nativeSenderRequest('enable');
  setWorkspaceToken('acct-0123456789abcdef0123@2');
  finish(jsonResponse({ ...component, enabled: true }));
  await assert.rejects(pending, { code: 'WORKSPACE_CHANGED' });
});
