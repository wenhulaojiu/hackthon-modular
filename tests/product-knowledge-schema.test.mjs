import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import * as replyMoney from '../lib/reply-money-core.mjs';

const nativeRequire = createRequire(import.meta.url);
const source = readFileSync(new URL('../lib/server.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const loaded = { exports: {} };
// 只运行生产数据校验器；数据库、登录及云端绑定均替换为空依赖，不调用网络。
const requireSchema = name => {
  if (name === 'cloudflare:workers') return { env: {} };
  if (name === '@/app/chatgpt-auth') return { getChatGPTUser: async () => null };
  if (name === '@/db') return { getDb: () => { throw new Error('本测试不访问数据库'); } };
  if (name === '@/db/schema') return {};
  if (name === '@/lib/seed') return {};
  if (name === '@/lib/reply-context') { const module = { exports: {} }; const compiled = ts.transpileModule(readFileSync(new URL('../lib/reply-context.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText; new Function('require', 'module', 'exports', compiled)(nativeRequire, module, module.exports); return module.exports; }
  if (name === '@/lib/competition-demo') { const module = { exports: {} }; const compiled = ts.transpileModule(readFileSync(new URL('../lib/competition-demo.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText; new Function('require', 'module', 'exports', compiled)(nativeRequire, module, module.exports); return module.exports; }
  if (name === '@/lib/reply-catalog') { const module = { exports: {} }; const compiled = ts.transpileModule(readFileSync(new URL('../lib/reply-catalog.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText; new Function('require', 'module', 'exports', compiled)(nativeRequire, module, module.exports); return module.exports; }
  if (name === '@/lib/reply-money') return replyMoney;
  if (name.startsWith('@/')) throw new Error(`未声明的测试依赖：${name}`);
  return nativeRequire(name);
};
new Function('require', 'module', 'exports', output)(requireSchema, loaded, loaded.exports);
const { appStateSchema, productSchema, replySettingsSchema } = loaded.exports;

const product = { id: 'synthetic-product', name: '合成商品', type: 'product', price: 20, description: '仅用于校验的说明', faq: [], enabled: true };
const settings = { enabled: false, mode: 'review', selectedCustomerIds: [], businessHours: { enabled: true, start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] }, faq: [{ question: '原有问题', answer: '原有答案' }], handoffKeywords: [], maxReplyChars: 300, cooldownSeconds: 30, debounceSeconds: 60, prompt: '' };
const information = { contactName: '合成店长', phone: '010-00000000', address: '合成测试地址', serviceContent: '合成预约服务说明' };

test('新增补货标记与店铺基础信息经过JSON保存校验后完整保留', () => {
  const state = { schemaVersion: 1, customers: [], orders: [], tasks: [], imports: [], demo: false, settings: { storeName: '合成店铺', industry: '', followupDays: 7, ai: { baseUrl: '', model: '', temperature: 0, profilePrompt: '', marketingPrompt: '', extractionPrompt: '' } }, products: [{ ...product, stock: 0, restockThreshold: 5, needsRestock: true }], replySettings: { ...settings, storeInfo: information } };
  const saved = appStateSchema.parse(JSON.parse(JSON.stringify(state)));
  assert.equal(saved.products[0].needsRestock, true);
  assert.equal(saved.products[0].stock, 0);
  assert.equal(saved.products[0].restockThreshold, 5);
  assert.deepEqual(saved.replySettings.storeInfo, information);
  assert.deepEqual(saved.replySettings.faq, settings.faq);
  assert.deepEqual(saved.replySettings.businessHours, settings.businessHours);
});

test('旧商品和已有店铺FAQ保持兼容，不自动补写或删除资料', () => {
  const oldProduct = productSchema.parse(product);
  const oldSettings = replySettingsSchema.parse(settings);
  assert.equal(oldProduct.needsRestock, undefined);
  assert.equal(oldProduct.stock, undefined);
  assert.equal(oldProduct.restockThreshold, undefined);
  assert.equal(oldSettings.storeInfo, undefined);
  assert.deepEqual(oldSettings.faq, settings.faq);
});

test('店铺基础信息支持明确清空，拒绝超长、错误类型和额外字段', () => {
  assert.deepEqual(replySettingsSchema.parse({ ...settings, storeInfo: { phone: '', address: '', serviceContent: '' } }).storeInfo, { phone: '', address: '', serviceContent: '' });
  for (const patch of [{ contactName: '人'.repeat(81) }, { contactName: 123 }, { phone: 'a'.repeat(81) }, { address: '地'.repeat(501) }, { serviceContent: '文'.repeat(2001) }, { phone: 123 }, { apiKey: '不得进入店铺信息' }]) assert.equal(replySettingsSchema.safeParse({ ...settings, storeInfo: { ...information, ...patch } }).success, false);
  assert.equal(productSchema.safeParse({ ...product, needsRestock: 'true' }).success, false);
});

test('库存保留未知与零的区别，库存和补货提醒值拒绝负数、小数及超限', () => {
  assert.equal(productSchema.parse({ ...product, stock: null }).stock, null);
  assert.equal(productSchema.parse({ ...product, stock: 0, restockThreshold: 0 }).stock, 0);
  for (const field of ['stock', 'restockThreshold']) {
    for (const value of [-1, 1.5, 1_000_000_001, Infinity, NaN, '10']) assert.equal(productSchema.safeParse({ ...product, [field]: value }).success, false, `${field}=${value}`);
    assert.equal(productSchema.parse({ ...product, [field]: 1_000_000_000 })[field], 1_000_000_000);
  }
  assert.equal(productSchema.safeParse({ ...product, restockThreshold: null }).success, false);
});
