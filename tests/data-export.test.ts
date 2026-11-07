import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSeed } from '../lib/seed.ts';
import { buildFullDataJson, buildCustomersCsv, buildOrdersCsv, buildTasksCsv, csvCell, buildCsv, CUSTOMER_CSV_HEADERS, ORDER_CSV_HEADERS } from '../lib/data-export.ts';
import type { AppState, Order } from '../lib/types';

// 按RFC4180读取导出结果，验证引号、逗号与多行文字没有错列。
function rowsFrom(csv: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let value = ''; let quoted = false;
  const data = csv.replace(/^\uFEFF/, '');
  for (let i = 0; i < data.length; i++) {
    const char = data[i];
    if (quoted) { if (char === '"' && data[i + 1] === '"') { value += '"'; i++; } else if (char === '"') quoted = false; else value += char; }
    else if (char === '"') quoted = true;
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\r' && data[i + 1] === '\n' || char === '\n') { if (char === '\r') i++; row.push(value); rows.push(row); row = []; value = ''; }
    else value += char;
  }
  if (row.length || value) { row.push(value); rows.push(row); }
  assert.equal(quoted, false);
  return rows;
}

test('UTF8 BOM、中文和包含引号逗号换行的文字均可往返', () => {
  const value = '中文,"画像"\n第二行，客户偏好😀';
  const csv = buildCsv(['客户备注', '金额'], [[value, 128.5]]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.deepEqual(rowsFrom(csv), [['客户备注', '金额'], [value, '128.5']]);
});

test('客户文字不能触发CSV公式，真正的数值保留正负号', () => {
  for (const value of ['=1+1', '+SUM(1,2)', '-1+2', '@SUM(A1)', ' \t=HYPERLINK("https://example.invalid")', '\n=1+1', '\r\t+1', '\uFEFF=1+1']) {
    const cell = rowsFrom(`列\r\n${csvCell(value)}\r\n`)[1][0];
    assert.ok(cell.startsWith("'"), `危险文字没有转为文本：${JSON.stringify(value)}`);
  }
  assert.equal(Number(rowsFrom(`列\r\n${csvCell(-12.5)}\r\n`)[1][0]), -12.5);
});

test('完整JSON保留聊天画像业务资料，白名单排除所有对象额外密钥且不改原数据', () => {
  const original = demoSeed();
  original.customers[0].messages = [{ id: 'unicode-msg', sender: 'customer', text: '喜欢原木色，周末到店\n想了解服务😀', date: '2026-11-07T11:00:00+08:00' }];
  original.products = [{ id: 'product-one', name: '通用服务', type: 'service', price: null, description: '价格由门店确认', enabled: true, faq: [{ question: '如何预约', answer: '提前一天预约' }] }];
  const extra = structuredClone(original) as AppState & Record<string, unknown>;
  const secret = 'SYNTHETIC_SECRET_NEVER_EXPORT';
  extra.apiKey = secret;
  (extra.settings.ai as unknown as Record<string, unknown>).apiKey = secret;
  (extra.customers[0] as unknown as Record<string, unknown>).token = secret;
  (extra.products![0].faq[0] as unknown as Record<string, unknown>).ciphertext = secret;
  extra.settings.ai.baseUrl = `https://user:${secret}@api.example.com/v1?api_key=${secret}#${secret}`;
  const before = JSON.stringify(extra);
  const result = buildFullDataJson(extra);
  assert.ok(!result.includes(secret));
  const exported = JSON.parse(result);
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.settings.ai.baseUrl, 'https://api.example.com/v1');
  assert.deepEqual(exported.customers[0].messages, original.customers[0].messages);
  assert.deepEqual(exported.products, original.products);
  assert.deepEqual(exported.orders, original.orders);
  assert.deepEqual(exported.tasks, original.tasks);
  assert.equal(JSON.stringify(extra), before);
});

test('完整JSON导出保留联系人和库存，未填写库存不会变为零且额外凭据被过滤', () => {
  const state = demoSeed();
  const product = { id: 'stock-known', name: '合成商品', type: 'product' as const, price: 18, description: '库存契约测试', enabled: true, faq: [] };
  state.products = [{ ...product, stock: 0, restockThreshold: 0 }, { ...product, id: 'stock-unknown', stock: null }, { ...product, id: 'stock-legacy' }];
  state.replySettings = { enabled: false, mode: 'review', selectedCustomerIds: [], businessHours: { enabled: false, start: '09:00', end: '18:00', days: [1] }, faq: [], handoffKeywords: [], maxReplyChars: 300, cooldownSeconds: 30, prompt: '', storeInfo: { contactName: '合成联系人', phone: '', address: '', serviceContent: '' } };
  (state.replySettings.storeInfo as unknown as Record<string, unknown>).apiKey = 'SYNTHETIC_SECRET_NEVER_EXPORT';
  (state.products[0] as unknown as Record<string, unknown>).token = 'SYNTHETIC_SECRET_NEVER_EXPORT';
  const result = buildFullDataJson(state);
  const exported = JSON.parse(result);
  assert.equal(exported.products[0].stock, 0);
  assert.equal(exported.products[0].restockThreshold, 0);
  assert.equal(exported.products[1].stock, null);
  assert.equal(Object.hasOwn(exported.products[2], 'stock'), false);
  assert.equal(Object.hasOwn(exported.products[2], 'restockThreshold'), false);
  assert.equal(exported.replySettings.storeInfo.contactName, '合成联系人');
  assert.ok(!result.includes('SYNTHETIC_SECRET_NEVER_EXPORT'));
});

test('消费和客户导出按确认销售与退款计算，任务保留话术和日期', () => {
  const state = demoSeed();
  state.customers = [state.customers[0]];
  state.customers[0].name = '导出语义测试客户';
  const customerId = state.customers[0].id;
  const base: Order = { id: 'sale-1', customerId, description: '确认消费', amount: 100.1, date: '2026-11-07', status: 'confirmed', type: 'sale', evidence: '合成证据' };
  state.orders = [base, { ...base, id: 'sale-2', amount: 50.2 }, { ...base, id: 'refund', amount: 20, type: 'refund' }, { ...base, id: 'pending', amount: 900, status: 'pending' }, { ...base, id: 'rejected', amount: 800, status: 'rejected' }];
  state.tasks = [{ id: 'followup-one', customerId, title: '预约提醒', date: '2026-11-10', kind: 'followup', status: 'todo', priority: 'high', script: '您好，周二方便到店吗？\n可回复预约时间。' }];
  const customers = rowsFrom(buildCustomersCsv(state));
  assert.equal(customers.length, 2);
  assert.equal(Number(customers[1][CUSTOMER_CSV_HEADERS.indexOf('累计净消费（元）')]), 130.3);
  assert.equal(Number(customers[1][CUSTOMER_CSV_HEADERS.indexOf('确认消费次数')]), 2);
  const orders = rowsFrom(buildOrdersCsv(state));
  assert.equal(orders.length, 6);
  const column = (recordId: string, name: string) => orders.find(row => row[0] === recordId)![ORDER_CSV_HEADERS.indexOf(name)];
  assert.equal(Number(column('refund', '记录金额（元）')), 20);
  assert.equal(Number(column('refund', '计入净消费（元）')), -20);
  assert.equal(Number(column('refund', '计入消费次数')), 0);
  for (const record of ['pending', 'rejected']) {
    assert.equal(Number(column(record, '计入净消费（元）')), 0);
    assert.equal(Number(column(record, '计入消费次数')), 0);
  }
  const tasks = rowsFrom(buildTasksCsv(state));
  assert.equal(tasks.length, 2);
  assert.ok(tasks[1].includes(state.tasks[0].script));
  assert.ok(tasks[1].includes('2026-11-10'));
});
