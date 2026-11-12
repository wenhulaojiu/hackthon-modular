import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeValueTier, findCustomerByIdentity, linkShopRecords, parseShopRecords, parseSpokenNote, recommendationForTier } from '../lib/customer-profile.ts';
import type { AppState, Customer, Order, Product } from '../lib/types.ts';

const customer = (patch: Partial<Customer> = {}): Customer => ({
  id: 'c1', name: '林女士', wechatId: '', color: '#123456', stage: '新客户', tags: [], manualTags: [],
  summary: '', preferences: '', budget: '', note: '', createdAt: '2026-11-01', lastContactAt: '', nextFollowUpAt: '',
  source: 'manual', evidence: [], messages: [], ...patch,
});
const order = (patch: Partial<Order> = {}): Order => ({
  id: 'o1', customerId: 'c1', description: '营养包', amount: 100, date: '2026-11-01',
  status: 'confirmed', type: 'sale', evidence: '店铺数据', ...patch,
});
const state = (patch: Partial<AppState> = {}): AppState => ({
  schemaVersion: 1, customers: [], orders: [], tasks: [], imports: [], demo: false,
  settings: { storeName: '合成门店', industry: '', followupDays: 30, ai: { baseUrl: '', model: '', temperature: 0, profilePrompt: '', marketingPrompt: '', extractionPrompt: '' } },
  ...patch,
});
const product = (name: string, price: number | null): Product => ({ id: name, name, type: 'product', price, description: '', faq: [], enabled: true });

test('消费档次只统计已确认记录，候选与拒绝记录不计入', () => {
  assert.equal(computeValueTier([], 'c1'), 'new');
  assert.equal(computeValueTier([order({ amount: 50 })], 'c1'), 'low');
  assert.equal(computeValueTier([order({ amount: 150 }), order({ id: 'o2', amount: 150 })], 'c1'), 'mid');
  assert.equal(computeValueTier([order({ amount: 400 })], 'c1'), 'high');
  assert.equal(computeValueTier([order({ amount: 400, status: 'pending' })], 'c1'), 'new');
  assert.equal(computeValueTier([order({ amount: 400, status: 'rejected' })], 'c1'), 'new');
  assert.equal(computeValueTier([order({ amount: 400, type: 'refund' })], 'c1'), 'new');
});

test('只有唯一身份匹配才绑定客户，避免合并两位客户的消费', () => {
  const rows = [customer({ id: 'a', memberId: 'A1024', phone: '13800000000' })];
  assert.equal(findCustomerByIdentity(rows, 'a-1024', '')?.id, 'a');
  assert.equal(findCustomerByIdentity(rows, '', '138-0000-0000')?.id, 'a');
  assert.equal(findCustomerByIdentity(rows, '', ''), null);
  assert.equal(findCustomerByIdentity([...rows, customer({ id: 'b', phone: '13800000000' })], '', '13800000000'), null);
});

test('店铺现有数据支持带表头 CSV 与 JSON 数组，并跳过无效行', () => {
  const csv = '会员卡号,电话,姓名,日期,商品,金额,类型\nA1024,13800000000,林女士,2026-10-01,营养包,328,sale\nA1024,13800000000,林女士,日期错误,营养包,328,sale';
  const parsed = parseShopRecords(csv);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].amount, 328);
  assert.equal(parsed.warnings.length, 1);
  const json = parseShopRecords(JSON.stringify([{ memberId: 'A1024', phone: '13800000000', name: '林女士', date: '2026-10-02', description: '小罐装', amount: 99, type: 'refund' }]));
  assert.equal(json.rows[0].type, 'refund');
  assert.equal(parseShopRecords('').rows.length, 0);
  assert.equal(parseShopRecords('不是数组').warnings.length, 1);
});

test('按会员卡或电话绑定消费记录，不覆盖已有姓名与聊天资料', () => {
  let sequence = 0;
  const makeId = () => `generated-${++sequence}`;
  const base = state({ customers: [customer({ name: '原有称呼', memberId: 'A1024', phone: '13800000000', messages: [{ id: 'm1', sender: 'customer', text: '合成消息', date: '2026-11-01' }] })], orders: [], imports: [] });
  const rows = [
    { memberId: 'A1024', phone: '13800000000', name: '表格姓名', date: '2026-10-01', description: '营养包', amount: 328, type: 'sale' as const },
    { memberId: 'A1024', phone: '13800000000', name: '表格姓名', date: '2026-10-01', description: '营养包', amount: 328, type: 'sale' as const },
    { memberId: 'B2048', phone: '13900000000', name: '王女士', date: '2026-10-02', description: '小罐装', amount: 99, type: 'sale' as const },
  ];
  const result = linkShopRecords(base, rows, { fileName: '店铺现有消费数据', makeId, now: () => '2026-11-12' });
  assert.equal(result.addedCustomers, 1);
  assert.equal(result.addedOrders, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.state.customers[0].name, '原有称呼');
  assert.equal(result.state.customers[0].memberId, 'A1024');
  assert.equal(result.state.customers[0].messages.length, 1);
  assert.ok(result.state.orders.every(item => item.status === 'confirmed'));
  assert.equal(result.state.imports.length, 1);
});

test('精准推荐只按已确认档次与目录标价排序，并写明需人工确认', () => {
  const products = [product('入门装', 50), product('进阶装', 180), product('高阶装', 680), product('停用品', 999)];
  products[3].enabled = false;
  assert.equal(recommendationForTier('low', products).names[0], '入门装');
  assert.equal(recommendationForTier('high', products).names[0], '高阶装');
  assert.equal(recommendationForTier('new', products).names.length, 0);
  assert.match(recommendationForTier('high', products).note, /不代表适用或效果|需人工确认/u);
});

test('语音口述解析生成待核对草稿，症状只记录现象', () => {
  const draft = parseSpokenNote('客户叫林女士，会员卡号 A1024，电话 13800000000，宝宝 8 个月，问过 DHA 和鱼油的区别，预算 300 元左右', [product('营养包', 100)]);
  assert.equal(draft.name, '林女士');
  assert.equal(draft.memberId, 'A1024');
  assert.equal(draft.phone, '13800000000');
  assert.ok(draft.tags.includes('8个月'));
  assert.ok(draft.tags.includes('DHA'));
  assert.ok(draft.budget.includes('300'));
  assert.ok(draft.note.startsWith('口述记录（需导购核对）'));
  assert.equal(parseSpokenNote('林女士咨询DHA和鱼油').name, '林女士');
  assert.equal(parseSpokenNote('客户是王女士，宝宝八个月').name, '王女士');
  const symptom = parseSpokenNote('客户叫王女士，宝宝有点腹泻');
  assert.ok(symptom.warnings.some(warning => warning.includes('咨询医生')));
});
