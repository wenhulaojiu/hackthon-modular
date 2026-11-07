import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const nativeRequire = createRequire(import.meta.url);
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const loaded = { exports: {} };
// 使用生产校验器和演示构造器，不访问数据库、账号、微信或网络。
const requireSchema = name => {
  if (name === 'cloudflare:workers') return { env: {} };
  if (name === '@/app/chatgpt-auth') return { getChatGPTUser: async () => null };
  if (name === '@/db') return { getDb: () => { throw new Error('本测试不访问数据库'); } };
  if (name === '@/db/schema' || name === '@/lib/seed') return {};
  if (name === '@/lib/reply-context') { const module = { exports: {} }; const compiled = ts.transpileModule(readFileSync(new URL('../lib/reply-context.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText; new Function('require', 'module', 'exports', compiled)(nativeRequire, module, module.exports); return module.exports; }
  if (name === '@/lib/competition-demo') { const module = { exports: {} }; new Function('require', 'module', 'exports', compile('../lib/competition-demo.ts'))(nativeRequire, module, module.exports); return module.exports; }
  if (name.startsWith('@/')) throw new Error(`未声明的测试依赖：${name}`);
  return nativeRequire(name);
};
new Function('require', 'module', 'exports', compile('../lib/server.ts'))(requireSchema, loaded, loaded.exports);
const builder = { exports: {} };
new Function('require', 'module', 'exports', compile('../lib/competition-demo.ts'))(nativeRequire, builder, builder.exports);

test('合成演示店铺通过真实保存schema的JSON往返，虚拟来源与欢迎语完整保留', () => {
  const input = { schemaVersion: 1, customers: [], orders: [], tasks: [], imports: [], demo: false, settings: { storeName: '合成门店', industry: '', followupDays: 7, ai: { baseUrl: '', model: '', temperature: 0, profilePrompt: '', marketingPrompt: '', extractionPrompt: '' } } };
  const result = builder.exports.createCompetitionDemo(input, new Date('2026-11-07T06:00:00.000Z'));
  const saved = loaded.exports.appStateSchema.parse(JSON.parse(JSON.stringify(result)));
  assert.deepEqual(saved, result);
  assert.equal(saved.customers.filter(item => item.source === 'demo' && item.autoReplyEnabled === false).length, 30);
  assert.equal(saved.products.filter(item => item.source === 'demo').length, 22);
  assert.equal(saved.replySettings.welcomeMessage, builder.exports.DEMO_WELCOME);
  assert.ok(new TextEncoder().encode(JSON.stringify(saved)).length < 1_450_000);
});
