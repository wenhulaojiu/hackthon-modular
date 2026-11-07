import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const origin = 'http://127.0.0.1:5173';

function fixture() {
  const saved = { tasks: [{ id: 'task-one', customerId: 'c1', status: 'todo', script: '保存在服务端的合成话术' }], customers: [{ id: 'c1', wechatId: 'wxid_synthetic', source: 'wechat', autoReplyEnabled: true }], replySettings: { enabled: true, selectedCustomerIds: ['c1'] } };
  let local = true, loads = 0;
  class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const server = { ApiError, apiResponse: async work => { try { return await work(); } catch (error) { return Response.json({ error: error.message }, { status: error.status || 503 }); } }, json: value => Response.json(value), requireUserId: async () => 'synthetic-user', requireSameOrigin: request => { if (request.headers.get('origin') !== origin) throw new ApiError(403, '同源校验失败'); }, requestWorkspace: request => { if (!local) return undefined; if (request.headers.get('x-kexu-workspace') !== 'acct-aaaaaaaaaaaaaaaaaaaa@1') throw new ApiError(409, '账号已切换'); return { id: 'acct-aaaaaaaaaaaaaaaaaaaa', revision: 1 }; }, readJson: request => request.json(), parseInput: (schema, value) => { const parsed = schema.safeParse(value); if (!parsed.success) throw new ApiError(400, '格式错误'); return parsed.data; }, loadState: async (userId, workspace) => { assert.equal(userId, 'synthetic-user'); assert.equal(workspace.id, 'acct-aaaaaaaaaaaaaaaaaaaa'); loads++; return { state: saved }; } };
  const cache = new Map();
  function load(relative) {
    const url = new URL(`../${relative}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:\/)/, '$1');
    if (cache.has(relative)) return cache.get(relative).exports;
    const module = { exports: {} }; cache.set(relative, module);
    const compiled = ts.transpileModule(readFileSync(decodeURIComponent(url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function('require', 'module', 'exports', compiled)(name => name === '@/lib/server' ? server : name === '@/lib/followup' ? load('lib/followup.ts') : name === './reply-enrollment.ts' ? load('lib/reply-enrollment.ts') : require(name), module, module.exports);
    return module.exports;
  }
  const route = load('app/api/followup/route.ts');
  const call = (body, headers = {}) => route.POST(new Request(`${origin}/api/followup`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Kexu-Local': '1', 'X-Kexu-Workspace': 'acct-aaaaaaaaaaaaaaaaaaaa@1', ...headers }, body: JSON.stringify(body) }));
  return { saved, call, loads: () => loads, cloud: () => { local = false; } };
}

test('准备API只返回已保存task/customer/text，拒绝浏览器覆盖正文与云端/跨账号', async () => {
  const f = fixture();
  assert.deepEqual(await (await f.call({ taskId: 'task-one' })).json(), { taskId: 'task-one', customerId: 'c1', text: '保存在服务端的合成话术' });
  const before = f.loads();
  assert.equal((await f.call({ taskId: 'task-one', text: '浏览器不能指定正文' })).status, 400); assert.equal(f.loads(), before);
  assert.equal((await f.call({ taskId: 'task-one' }, { Origin: 'https://outside.example' })).status, 403);
  assert.equal((await f.call({ taskId: 'task-one' }, { 'X-Kexu-Workspace': 'acct-bbbbbbbbbbbbbbbbbbbb@1' })).status, 409);
  f.cloud(); assert.equal((await f.call({ taskId: 'task-one' })).status, 403);
});

test('准备API在已保存客户为demo或人工接管时拒绝，不修改任务记录', async () => {
  const f = fixture(); const original = structuredClone(f.saved.tasks);
  f.saved.customers[0].source = 'demo'; assert.equal((await f.call({ taskId: 'task-one' })).status, 409);
  f.saved.customers[0].source = 'wechat'; f.saved.customers[0].humanTakeover = true; assert.equal((await f.call({ taskId: 'task-one' })).status, 409);
  assert.deepEqual(f.saved.tasks, original);
});
