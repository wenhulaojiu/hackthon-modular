import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MOTHER_BABY_INDUSTRY, MOTHER_BABY_STORE, createMotherBabyDemo } from '../lib/mother-baby-demo.ts';
import { demoSeed } from '../lib/seed.ts';
import type { AppState, Customer } from '../lib/types.ts';

const realCustomer: Customer = {
  id: 'real-1', name: '真实客户', wechatId: 'wx_real', color: '#123456', stage: '新客户', tags: [], manualTags: [],
  summary: '', preferences: '', budget: '', note: '', createdAt: '2026-11-01', lastContactAt: '', nextFollowUpAt: '',
  source: 'manual', evidence: [], messages: [], baby: { ageMonths: 6, formulaStage: '2段' },
};
const previous: AppState = { ...demoSeed(), customers: [realCustomer], orders: [], tasks: [], imports: [], demo: false };

test('默认工作区与演示店铺都已是母婴行业', () => {
  assert.equal(demoSeed().settings.storeName, MOTHER_BABY_STORE);
  assert.equal(demoSeed().settings.industry, MOTHER_BABY_INDUSTRY);
  assert.ok(demoSeed().customers.every(customer => customer.baby && typeof customer.baby.ageMonths === 'number'));
  const result = createMotherBabyDemo(previous);
  assert.equal(result.settings.storeName, MOTHER_BABY_STORE);
  assert.equal(result.settings.industry, MOTHER_BABY_INDUSTRY);
  assert.match(result.replySettings?.welcomeMessage ?? '', /配方奶粉|辅食|纸尿裤/u);
});

test('演示目录全部改为母婴商品服务，不残留咖啡或烘焙文案', () => {
  const result = createMotherBabyDemo(previous);
  const demoProducts = (result.products ?? []).filter(product => product.source === 'demo');
  assert.equal(demoProducts.length, 22);
  for (const product of demoProducts) {
    assert.doesNotMatch(product.name, /咖啡|面包|可颂|花艺|茶歇|贝果|曲奇|拿铁/u);
    assert.doesNotMatch(product.description, /咖啡因|现磨|烘焙|花材/u);
    assert.ok(product.description.length >= 90);
    assert.ok(product.faq.length >= 3);
    assert.match(product.description, /按包装说明与儿科医生建议核对/u);
  }
  assert.ok(demoProducts.some(product => product.name === '1段婴儿配方奶粉'));
  assert.ok(demoProducts.some(product => product.name === '2段婴儿配方奶粉'));
  assert.ok(demoProducts.some(product => product.name === '奶粉分段与转奶咨询'));
});

test('30位演示客户都有宝宝档案，且包含6月龄换段场景', () => {
  const result = createMotherBabyDemo(previous);
  const demoCustomers = result.customers.filter(customer => customer.source === 'demo');
  assert.equal(demoCustomers.length, 30);
  assert.ok(demoCustomers.every(customer => customer.baby && typeof customer.baby.ageMonths === 'number'));
  assert.ok(demoCustomers.filter(customer => customer.baby?.ageMonths === 6).length >= 3);
  assert.ok(demoCustomers.every(customer => customer.tags.some(tag => tag.includes('个月宝宝'))));
  assert.ok(demoCustomers.every(customer => customer.summary.includes('宝宝约') && customer.summary.includes('曾咨询')));
  assert.ok(demoCustomers.every(customer => !/咖啡|茶具|杯子|浅烘/u.test(customer.summary)));
  assert.equal(result.customers.filter(customer => customer.id === 'real-1').length, 1);
  assert.equal(result.customers.find(customer => customer.id === 'real-1')?.baby?.ageMonths, 6);
});

test('演示订单、跟进话术与欢迎语不含旧行业文案，且不作功效承诺', () => {
  const result = createMotherBabyDemo(previous);
  const text = JSON.stringify([result.orders, result.tasks, result.replySettings]);
  assert.doesNotMatch(text, /咖啡|面包|藤编收纳篮|茶具|浅烘/u);
  assert.doesNotMatch(text, /保证有效|一定有效|承诺疗效/u);
  assert.ok(result.tasks.every(task => /宝宝|月龄|段位|儿保|纸尿裤|核对/u.test(task.title + task.script)));
});
