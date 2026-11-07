import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompetitionDemo, DEMO_BREAD_DETAILS, DEMO_WELCOME, migrateCompetitionCatalog } from '../lib/competition-demo.ts';
import type { AppState, Customer, Product } from '../lib/types.ts';

const now = new Date('2026-11-07T06:00:00.000Z');
const date = '2026-11-01T02:00:00.000Z';
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

function customer(id = 'synthetic-real-customer'): Customer {
  return { id, name: '合成真实资料占位', wechatId: `synthetic_${id}`, color: '#123456', stage: '新客户', tags: ['原标签'], manualTags: ['人工标签'], summary: '原有摘要', preferences: '原有偏好', budget: '80元', note: '仅用于测试的合成资料', createdAt: date, lastContactAt: date, nextFollowUpAt: date, source: 'wechat', evidence: [], messages: [{ id: `message-${id}`, sender: 'customer', text: '合成咨询', date }], autoReplyEnabled: true, humanTakeover: false };
}

function product(id = 'synthetic-real-product'): Product {
  return { id, name: '原有合成商品', type: 'product', price: 37, description: '原有说明', faq: [{ question: '原有问题', answer: '原有答案' }], enabled: false, needsRestock: true };
}

function state(): AppState {
  const real = customer();
  const demo = { ...customer('old-demo-customer'), source: 'demo' as const, autoReplyEnabled: false };
  return {
    schemaVersion: 1, demo: false, customers: [real, demo],
    orders: [
      { id: 'synthetic-real-order', customerId: real.id, description: '原有合成交易', amount: 37, date, status: 'confirmed', type: 'sale', evidence: '合成交易证据' },
      { id: 'old-demo-order', customerId: demo.id, description: '旧演示交易', amount: 20, date, status: 'confirmed', type: 'sale', evidence: '旧演示资料' },
    ],
    tasks: [
      { id: 'synthetic-real-task', customerId: real.id, title: '原有合成任务', date, kind: 'followup', status: 'todo', priority: 'high', script: '原有合成话术' },
      { id: 'old-demo-task', customerId: demo.id, title: '旧演示任务', date, kind: 'reminder', status: 'todo', priority: 'normal', script: '' },
    ],
    products: [product(), { ...product('old-demo-product'), source: 'demo' }],
    imports: [{ id: 'synthetic-import', fileName: '合成导入.json', date, customerCount: 1, messageCount: 1 }],
    exports: [{ id: 'synthetic-export', fileName: '合成导出.json', date, kind: 'json', customerCount: 1, messageCount: 1 }],
    settings: { storeName: '原有合成店铺', industry: '合成行业', followupDays: 13, ai: { baseUrl: 'https://synthetic.example/v1', model: 'synthetic-model', temperature: 0.37, profilePrompt: '原有画像提示', marketingPrompt: '原有推荐提示', extractionPrompt: '原有消费提示' } },
    replySettings: { enabled: true, mode: 'auto', selectedCustomerIds: [real.id, demo.id], autoEnrollNewContacts: false, welcomeEnabled: false, welcomeMessage: '原有欢迎语', businessHours: { enabled: true, start: '10:00', end: '18:00', days: [1, 3, 5] }, faq: [{ question: '店铺原问题', answer: '店铺原答案' }], handoffKeywords: ['原有转人工词'], maxReplyChars: 240, cooldownSeconds: 47, debounceSeconds: 90, prompt: '原有回复提示' },
  };
}

function emptyState(): AppState {
  const input = state();
  return { ...input, customers: [], orders: [], tasks: [], products: [], imports: [], exports: [], replySettings: undefined };
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) freeze(item);
  }
  return value;
}

function validReferences(result: AppState) {
  const ids = new Set(result.customers.map(item => item.id));
  for (const rows of [result.customers, result.orders, result.tasks, result.products || []]) assert.equal(new Set(rows.map(item => item.id)).size, rows.length);
  for (const row of [...result.orders, ...result.tasks]) assert.ok(ids.has(row.customerId), row.id);
  for (const id of result.replySettings?.selectedCustomerIds || []) assert.ok(ids.has(id), id);
  for (const item of result.customers) {
    assert.equal(new Set(item.messages.map(message => message.id)).size, item.messages.length);
    assert.ok(Number.isFinite(Date.parse(item.createdAt)));
  }
}

test('加载保留原有真实客户、交易、任务、商品、导入导出与完整模型配置', () => {
  const input = state();
  const result = createCompetitionDemo(input, now);
  assert.deepEqual(result.customers.find(item => item.id === input.customers[0].id), input.customers[0]);
  assert.deepEqual(result.orders.find(item => item.id === input.orders[0].id), input.orders[0]);
  assert.deepEqual(result.tasks.find(item => item.id === input.tasks[0].id), input.tasks[0]);
  assert.deepEqual(result.products?.find(item => item.id === input.products![0].id), input.products![0]);
  assert.deepEqual(result.settings.ai, input.settings.ai);
  assert.equal(result.settings.followupDays, 13);
  assert.deepEqual(result.imports, input.imports);
  assert.deepEqual(result.exports, input.exports);
  assert.deepEqual(result.replySettings?.faq, input.replySettings?.faq);
  assert.deepEqual(result.replySettings?.handoffKeywords, input.replySettings?.handoffKeywords);
  assert.equal(result.replySettings?.prompt, input.replySettings?.prompt);
  assert.equal(result.replySettings?.debounceSeconds, 90);
  assert.equal(result.customers.some(item => item.id === 'old-demo-customer'), false);
  assert.equal(result.orders.some(item => item.id === 'old-demo-order'), false);
  assert.equal(result.tasks.some(item => item.id === 'old-demo-task'), false);
  assert.equal(result.products?.some(item => item.id === 'old-demo-product'), false);
});

test('30位虚拟客户明确标记并排除接待，欢迎语不超过300字符', () => {
  const result = createCompetitionDemo(state(), now);
  const demos = result.customers.filter(item => item.source === 'demo');
  assert.equal(demos.length, 30);
  for (const item of demos) {
    assert.equal(item.autoReplyEnabled, false);
    assert.equal(item.humanTakeover, false);
    assert.ok(item.wechatId.startsWith('demo_customer_'));
    assert.doesNotMatch(item.name, /（演示）/);
    assert.equal(item.source, 'demo');
    assert.match(item.note, /不参与自动发送/);
    assert.equal(result.replySettings?.selectedCustomerIds.includes(item.id), false);
  }
  assert.deepEqual(result.replySettings?.selectedCustomerIds, ['synthetic-real-customer']);
  assert.equal(result.replySettings?.welcomeMessage, DEMO_WELCOME);
  assert.ok(DEMO_WELCOME.length > 0 && DEMO_WELCOME.length <= 300);
  assert.equal(DEMO_WELCOME.includes('\0'), false);
  assert.doesNotMatch(DEMO_WELCOME, /演示|比赛/);
});

test('演示目录提供16商品和6服务，价格、说明与FAQ可以用于咨询', () => {
  const result = createCompetitionDemo(emptyState(), now);
  const catalog = result.products!;
  assert.equal(catalog.filter(item => item.type === 'product').length, 16);
  assert.equal(catalog.filter(item => item.type === 'service').length, 6);
  assert.equal(catalog.filter(item => item.type === 'product' && item.needsRestock).length, 3);
  for (const item of catalog) {
    assert.equal(item.source, 'demo');
    assert.equal(item.enabled, true);
    assert.ok(typeof item.price === 'number' && Number.isFinite(item.price) && item.price > 0);
    assert.doesNotMatch(item.description, /比赛演示资料/);
    assert.ok(item.faq.length > 0);
    for (const faq of item.faq) assert.ok(faq.question.trim() && faq.answer.trim());
    if (item.type === 'service') {
      assert.equal(item.needsRestock, false);
      assert.equal(item.stock, undefined);
      assert.equal(item.restockThreshold, undefined);
    } else {
      assert.ok(Number.isInteger(item.stock) && item.stock! >= 0);
      assert.equal(item.restockThreshold, 5);
      assert.equal(item.stock! <= item.restockThreshold!, item.needsRestock);
    }
  }
  assert.equal(catalog.find(item => item.name === '美式咖啡')?.price, 18);
  assert.equal(catalog.find(item => item.name === '花艺体验')?.price, 168);
});

test('商品补充风味规格保存资料，面包使用已确认的口味和两天保质期', () => {
  const catalog = createCompetitionDemo(emptyState(), now).products!;
  for (const item of catalog) {
    assert.ok(item.description.length >= 90, item.name);
    assert.ok(item.faq.length >= 3, item.name);
    assert.doesNotMatch(item.description, /比赛演示资料/);
  }
  assert.match(DEMO_BREAD_DETAILS.description, /原味奶香软面包/);
  assert.match(DEMO_BREAD_DETAILS.description, /10元\/个.*80g/);
  assert.match(DEMO_BREAD_DETAILS.description, /小麦.*奶和蛋/);
  assert.match(DEMO_BREAD_DETAILS.description, /未开封常温密封保质期2天/);
  assert.match(DEMO_BREAD_DETAILS.description, /开封后建议当天食用/);
  assert.ok(DEMO_BREAD_DETAILS.faq.some(item => /怎么保存|能放多久/.test(item.question) && /2天/.test(item.answer)));
  for (const name of ['美式咖啡', '燕麦拿铁', '桂花拿铁', '柠檬冷萃', '季节水果茶']) assert.match(catalog.find(item => item.name === name)!.description, /当天/);
  assert.match(catalog.find(item => item.name === '巴斯克蛋糕')!.description, /0–4℃冷藏.*保质期2天/);
  assert.match(catalog.find(item => item.name === '挂耳咖啡礼盒')!.description, /保质期12个月/);
  for (const item of catalog.filter(item => item.type === 'service')) assert.match(item.description, /预约|沟通|确认/);
  for (const name of ['手作香氛蜡烛', '帆布手提袋', '鲜花小束']) assert.doesNotMatch(catalog.find(item => item.name === name)!.description, /食品保质期|保质期\d/);
});

test('旧目录按字段精确补全，不覆盖手改说明FAQ价格库存或任何历史消息', () => {
  const fresh = createCompetitionDemo(state(), now);
  const input = structuredClone(fresh);
  const coffee = input.products!.find(item => item.name === '美式咖啡')!;
  coffee.description = '【比赛演示资料】现磨咖啡，可选热饮或冰饮。';
  coffee.faq = [{ question: '现在有货吗？', answer: '当日余量请通过微信咨询；标记待补货的商品需人工确认。' }];
  coffee.price = 19;
  coffee.stock = 123;
  coffee.restockThreshold = 8;
  const flower = input.products!.find(item => item.name === '花艺体验')!;
  flower.description = '店员手改花艺说明，不要覆盖。';
  flower.faq = [{ question: '如何预约？', answer: '请至少提前一天通过微信留言预约，具体时段以人工确认为准。' }];
  const croissant = input.products!.find(item => item.name === '原味可颂')!;
  croissant.description = '每日烘焙，含小麦、奶及蛋；过敏信息请先咨询。';
  croissant.faq = [{ question: '人工问题', answer: '人工答案保留。' }];
  const before = structuredClone(input);
  const result = migrateCompetitionCatalog(freeze(input));
  const migrated = result.products!.find(item => item.name === '美式咖啡')!;
  assert.equal(migrated.description, fresh.products!.find(item => item.name === '美式咖啡')!.description);
  assert.deepEqual(migrated.faq, fresh.products!.find(item => item.name === '美式咖啡')!.faq);
  assert.equal(migrated.price, 19);
  assert.equal(migrated.stock, 123);
  assert.equal(migrated.restockThreshold, 8);
  assert.equal(result.products!.find(item => item.name === '花艺体验')!.description, flower.description);
  assert.deepEqual(result.products!.find(item => item.name === '花艺体验')!.faq, fresh.products!.find(item => item.name === '花艺体验')!.faq);
  assert.equal(result.products!.find(item => item.name === '原味可颂')!.description, fresh.products!.find(item => item.name === '原味可颂')!.description);
  assert.deepEqual(result.products!.find(item => item.name === '原味可颂')!.faq, croissant.faq);
  assert.equal(result.products![0], input.products![0]);
  assert.equal(result.customers, input.customers);
  assert.equal(result.orders, input.orders);
  assert.equal(result.tasks, input.tasks);
  assert.deepEqual(input, before);
  assert.equal(migrateCompetitionCatalog(result), result);
});

test('人工商品和未知虚拟资料不套用模板，独立加载不共享FAQ对象', () => {
  const input = createCompetitionDemo(emptyState(), now);
  input.products!.push({ ...product('manual-bread'), name: '面包', price: 10, source: 'manual', description: '需要购买的时候', faq: [] });
  input.products!.push({ ...product('unknown-demo'), name: '店员自建商品', source: 'demo', description: '【比赛演示资料】自填说明保留。' });
  assert.equal(migrateCompetitionCatalog(input), input);
  const first = createCompetitionDemo(emptyState(), now);
  first.products![0].faq[0].answer = '改变一个结果不能污染后续创建';
  const second = createCompetitionDemo(emptyState(), now);
  assert.notEqual(second.products![0].faq[0].answer, first.products![0].faq[0].answer);
});

test('演示交易、退款与任务关联有效，全部声明虚拟证据', () => {
  const result = createCompetitionDemo(emptyState(), now);
  validReferences(result);
  assert.equal(result.orders.filter(item => item.type === 'sale').length, 90);
  assert.equal(result.orders.filter(item => item.type === 'refund').length, 4);
  assert.equal(result.tasks.length, 18);
  for (const item of result.orders) {
    assert.equal(item.status, 'confirmed');
    assert.ok(item.amount > 0 && Number.isFinite(item.amount));
    assert.match(item.evidence, /虚拟/);
  }
  assert.ok(bytes(result) < 1_450_000);
});

test('重复加载替换旧演示且不重复新增，真实资料始终保留', () => {
  const first = createCompetitionDemo(state(), now);
  const second = createCompetitionDemo(first, now);
  assert.deepEqual(second, first);
  const later = createCompetitionDemo(second, new Date('2026-11-08T06:00:00.000Z'));
  assert.deepEqual(later.customers.map(item => item.id), first.customers.map(item => item.id));
  assert.deepEqual(later.products?.map(item => item.id), first.products?.map(item => item.id));
  assert.equal(later.orders.length, 95);
  assert.equal(later.tasks.length, 19);
  validReferences(later);
});

test('深冻结输入仍可生成，加载不修改任何传入资料', () => {
  const input = freeze(state());
  const before = structuredClone(input);
  createCompetitionDemo(input, now);
  assert.deepEqual(input, before);
});

test('没有原回复规则时保持总开关关闭与审阅模式，生成店铺资料和欢迎语', () => {
  const result = createCompetitionDemo(emptyState(), now);
  assert.equal(result.demo, false);
  assert.equal(result.settings.storeName, '青禾生活馆');
  assert.equal(result.replySettings?.enabled, false);
  assert.equal(result.replySettings?.mode, 'review');
  assert.deepEqual(result.replySettings?.selectedCustomerIds, []);
  assert.equal(result.replySettings?.autoEnrollNewContacts, true);
  assert.equal(result.replySettings?.welcomeEnabled, true);
  assert.equal(result.replySettings?.debounceSeconds, 10);
  assert.equal(result.replySettings?.storeInfo?.contactName, '林青禾');
  assert.equal(result.replySettings?.storeInfo?.phone, '');
  assert.equal(result.replySettings?.storeInfo?.address, '青禾市拾光路18号');
  assert.doesNotMatch(result.replySettings?.storeInfo?.serviceContent || '', /演示|比赛/);
});

test('旧演示目录迁移只清理商品和完整旧模板，保留聊天及禁发隔离', () => {
  const input = createCompetitionDemo(state(), now);
  input.products = input.products!.map(item => item.source === 'demo' ? { ...item, stock: undefined, restockThreshold: undefined, description: `【比赛演示资料】${item.description}` } : item);
  input.replySettings!.welcomeMessage = '你好，欢迎来到青禾生活馆！这是比赛演示店铺，提供现磨咖啡、每日烘焙、鲜花与生活礼品，也有咖啡体验、花艺体验和礼品包装服务。演示营业时间为每天09:00–21:00，欢迎直接留言咨询商品或服务。';
  input.replySettings!.storeInfo = { phone: '演示电话（未开放）', address: '青禾市拾光路18号（虚构地址）', serviceContent: '比赛演示店铺：现磨咖啡、每日烘焙、鲜花与生活礼品；提供咖啡体验、花艺体验和礼品包装。' };
  const before = structuredClone(input);
  const result = migrateCompetitionCatalog(freeze(input));
  assert.deepEqual(input, before);
  assert.equal(result.customers, input.customers);
  assert.equal(result.orders, input.orders);
  assert.equal(result.tasks, input.tasks);
  assert.equal(result.products![0], input.products![0]);
  assert.equal(result.products!.filter(item => item.source === 'demo' && item.type === 'product' && item.stock! <= item.restockThreshold!).length, 3);
  assert.ok(result.customers.filter(item => item.source === 'demo').every(item => item.autoReplyEnabled === false));
  assert.ok(result.products!.every(item => !item.description.startsWith('【比赛演示资料】')));
  assert.deepEqual(result.replySettings!.storeInfo, { contactName: '林青禾', phone: '', address: '青禾市拾光路18号', serviceContent: '现磨咖啡、每日烘焙、鲜花与生活礼品；提供咖啡体验、花艺体验和礼品包装。' });
  assert.equal(result.replySettings!.welcomeMessage, DEMO_WELCOME);
  assert.equal(migrateCompetitionCatalog(result), result);
});

test('目录迁移保留人工库存、未知库存、自填店铺资料与欢迎语', () => {
  const input = createCompetitionDemo(state(), now);
  const demos = input.products!.filter(item => item.source === 'demo');
  demos[0].stock = 123;
  demos[0].restockThreshold = 20;
  demos[1].stock = null;
  input.products![0].description = '【比赛演示资料】人工商品说明需保留';
  input.replySettings!.welcomeMessage = '你好，这是人工欢迎语。比赛演示资料也属于人工文本。';
  input.replySettings!.storeInfo = { contactName: '人工联系人', phone: '人工电话', address: '人工地址', serviceContent: '我的比赛演示店铺：保留手动说明' };
  const result = migrateCompetitionCatalog(freeze(input));
  assert.equal(result, input);
  assert.equal(result.products!.find(item => item.id === demos[0].id)!.stock, 123);
  assert.equal(result.products!.find(item => item.id === demos[1].id)!.stock, null);
  assert.equal(result.products![0].description, '【比赛演示资料】人工商品说明需保留');
  const withoutContact = structuredClone(input);
  delete withoutContact.replySettings!.storeInfo!.contactName;
  assert.equal(migrateCompetitionCatalog(withoutContact), withoutContact);
});

test('旧规则未设置等待时补10秒，已保存60秒不被演示加载覆盖', () => {
  const legacy = state(); delete legacy.replySettings!.debounceSeconds;
  assert.equal(createCompetitionDemo(legacy, now).replySettings?.debounceSeconds, 10);
  const explicit = state(); explicit.replySettings!.debounceSeconds = 60;
  assert.equal(createCompetitionDemo(explicit, now).replySettings?.debounceSeconds, 60);
});

test('competition前缀属于真实资料时完整保留，并为演示对象避开ID碰撞', () => {
  const input = emptyState();
  const real = customer('competition-customer-1');
  input.customers = [real];
  input.products = [product('competition-product-1')];
  input.orders = [{ ...state().orders[0], id: 'competition-order-0-0', customerId: real.id }];
  input.tasks = [{ ...state().tasks[0], id: 'competition-task-0', customerId: real.id }];
  const before = structuredClone(input);
  const result = createCompetitionDemo(freeze(input), now);
  assert.deepEqual(result.customers.find(item => item.source !== 'demo'), before.customers[0]);
  assert.deepEqual(result.products?.find(item => item.source !== 'demo'), before.products![0]);
  assert.deepEqual(result.orders.find(item => item.customerId === real.id), before.orders[0]);
  assert.deepEqual(result.tasks.find(item => item.customerId === real.id), before.tasks[0]);
  assert.equal(result.customers.length, 31);
  assert.equal(result.products?.length, 23);
  validReferences(result);
  assert.deepEqual(createCompetitionDemo(result, now), result);
  assert.deepEqual(input, before);
});

test('470位真实客户可加载至500位，471位时拒绝且保留输入', () => {
  const input = emptyState();
  input.customers = Array.from({ length: 470 }, (_, index) => ({ ...customer(`real-${index}`), messages: [] }));
  assert.equal(createCompetitionDemo(input, now).customers.length, 500);
  input.customers.push({ ...customer('real-470'), messages: [] });
  const before = structuredClone(input);
  assert.throws(() => createCompetitionDemo(input, now), /500|上限|容量/);
  assert.deepEqual(input, before);
});

test('保留商品加演示最多200项，超出不静默删商品', () => {
  const input = emptyState();
  input.products = Array.from({ length: 178 }, (_, index) => product(`real-product-${index}`));
  assert.equal(createCompetitionDemo(input, now).products?.length, 200);
  input.products.push(product('real-product-178'));
  const before = structuredClone(input);
  assert.throws(() => createCompetitionDemo(input, now), /200|上限|容量|商品/);
  assert.deepEqual(input, before);
});

test('订单与任务各5000条上限在加载前检查，超限保留原资料', () => {
  for (const kind of ['orders', 'tasks'] as const) {
    const input = emptyState();
    input.customers = [{ ...customer(), messages: [] }];
    const retained = kind === 'orders' ? 4906 : 4982;
    if (kind === 'orders') input.orders = Array.from({ length: retained }, (_, index) => ({ ...state().orders[0], id: `real-order-${index}` }));
    else input.tasks = Array.from({ length: retained }, (_, index) => ({ ...state().tasks[0], id: `real-task-${index}` }));
    assert.equal(createCompetitionDemo(input, now)[kind].length, 5000);
    if (kind === 'orders') input.orders.push({ ...state().orders[0], id: 'real-extra-order' });
    else input.tasks.push({ ...state().tasks[0], id: 'real-extra-task' });
    const before = structuredClone(input);
    assert.throws(() => createCompetitionDemo(input, now), /5000|上限|容量|订单|任务/);
    assert.deepEqual(input, before);
  }
});

test('新增60条演示聊天计入12000条总容量，超限不会截断聊天', () => {
  const input = emptyState();
  input.customers = Array.from({ length: 8 }, (_, index) => ({ ...customer(`real-${index}`), messages: Array.from({ length: index < 4 ? 1493 : 1492 }, (_, item) => ({ id: `m-${index}-${item}`, sender: 'customer' as const, text: '合成', date: '' })) }));
  const result = createCompetitionDemo(input, now);
  assert.equal(result.customers.reduce((total, item) => total + item.messages.length, 0), 12000);
  input.customers[0].messages.push({ id: 'm-extra', sender: 'customer', text: '合成', date: '' });
  const before = structuredClone(input);
  assert.throws(() => createCompetitionDemo(input, now), /12000|上限|容量|聊天/);
  assert.deepEqual(input, before);
});

test('UTF-8字节容量计入中文资料，接近上限时拒绝且不删减真实文本', () => {
  const input = emptyState();
  input.customers = Array.from({ length: 42 }, (_, index) => ({ ...customer(`real-${index}`), messages: [], note: '' }));
  for (const item of input.customers) item.note = '中'.repeat(Math.min(12_000, Math.max(0, Math.floor((1_440_000 - bytes(input)) / 3))));
  assert.ok(bytes(input) <= 1_450_000 && bytes(input) > 1_400_000);
  const before = structuredClone(input);
  assert.throws(() => createCompetitionDemo(input, now), /容量|字节|大小|上限|超/);
  assert.deepEqual(input, before);
});
