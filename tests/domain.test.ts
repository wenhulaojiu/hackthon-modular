import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { customerStats, extractCandidates, overviewStats, parseChatImport, shiftDate, today } from '../lib/domain.ts';
import { demoSeed } from '../lib/seed.ts';
import type { Customer, Order } from '../lib/types';

test('上海经营日期与跨月日期偏移', () => {
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(shiftDate(1, '2026-01-31'), '2026-02-01');
  assert.equal(shiftDate(-1, '2024-03-01'), '2024-02-29');
});

test('只有确认销售计次数，确认退款扣金额，候选与排除记录不入账', () => {
  const customer = demoSeed().customers[0];
  const base: Order = { id: 'sale', customerId: customer.id, description: '测试商品', amount: 100.1, date: '2026-11-01', type: 'sale', status: 'confirmed', evidence: '已核对' };
  const orders: Order[] = [base, { ...base, id: 'sale-2', amount: 50.2, date: '2026-11-02' }, { ...base, id: 'refund', amount: 20, type: 'refund' }, { ...base, id: 'pending', amount: 900, status: 'pending' }, { ...base, id: 'rejected', amount: 800, status: 'rejected' }, { ...base, id: 'other', customerId: 'other', amount: 999 }];
  assert.deepEqual(customerStats(customer.id, orders), { total: 130.3, visits: 2, lastPurchaseAt: '2026-11-02' });
});

test('概览包含时间范围边界，排除范围外与未来交易', () => {
  const state = demoSeed();
  const base = state.orders[0];
  state.orders = [
    { ...base, id: 'start', amount: 100, date: shiftDate(-6), type: 'sale' },
    { ...base, id: 'end', amount: 200, date: today(), type: 'sale' },
    { ...base, id: 'refund', amount: 30, date: today(), type: 'refund' },
    { ...base, id: 'old', amount: 500, date: shiftDate(-7) },
    { ...base, id: 'future', amount: 500, date: shiftDate(1) },
    { ...base, id: 'pending', amount: 500, date: today(), status: 'pending' },
  ];
  const stats = overviewStats(state, 7);
  assert.equal(stats.revenue, 300);
  assert.equal(stats.refunds, 30);
  assert.equal(stats.netRevenue, 270);
  assert.equal(stats.orderCount, 2);
  assert.equal(stats.todayRevenue, 170);
  assert.equal(stats.series.length, 7);
  assert.equal(stats.series[0].date, shiftDate(-6));
});

test('JSON 会话以微信号合并，重复导入不重复消息，也不误并同名客户', () => {
  const existing = demoSeed().customers.slice(0, 1);
  // 演示消息随经营日期变化，导入时间相对初始消息安排，跨日后仍能验证时间排序。
  const latestSeedDate = existing[0].messages.map(message => message.date).sort().at(-1)!;
  const newMessageDay = shiftDate(1, latestSeedDate);
  const payload = JSON.stringify({ customers: [
    { name: existing[0].name, wechatId: existing[0].wechatId, messages: [{ sender: 'customer', content: '同一微信号的新消息', timestamp: `${newMessageDay}T09:00:00+08:00` }] },
    { name: existing[0].name, messages: [{ sender: 'customer', content: '同名但没有身份凭据', date: newMessageDay }] },
  ] });
  const first = parseChatImport(payload, 'chat.json', existing);
  assert.equal(first.customers.length, 2);
  assert.equal(first.record.messageCount, 2);
  assert.equal(first.customers[0].messages.at(-1)?.text, '同一微信号的新消息');
  assert.ok(first.warnings.some(warning => warning.includes('昵称相同')));
  const knownOnly = JSON.stringify({ customers: [JSON.parse(payload).customers[0]] });
  const second = parseChatImport(knownOnly, 'different-file.json', first.customers);
  assert.equal(second.customers.length, 2);
  assert.equal(second.record.messageCount, 0);
  assert.ok(second.warnings.some(warning => warning.includes('重复消息')));
});

test('重复源ID不能覆盖或合并不同微信号客户', () => {
  const payload = JSON.stringify([{ id: 'duplicate', name: '同名', wechatId: 'wx_a', messages: [{ text: '甲', date: '2026-11-07' }] }, { id: 'duplicate', name: '同名', wechatId: 'wx_b', messages: [{ text: '乙', date: '2026-11-07' }] }]);
  const result = parseChatImport(payload, 'duplicates.json', []);
  assert.equal(result.customers.length, 2);
  assert.notEqual(result.customers[0].id, result.customers[1].id);
  assert.ok(result.warnings.some(warning => warning.includes('重复客户 ID')));
});

test('CSV 接受 BOM、引号中的逗号、双引号与跨行消息', () => {
  const csv = '\uFEFFcustomer_id,customer_name,wechat_id,timestamp,sender,content\r\nc1,示例,wx_csv,2026-11-07,customer,"需要咖啡,茶\n包装写""谢谢"""\r\n';
  const result = parseChatImport(csv, 'example.csv', []);
  assert.equal(result.customers.length, 1);
  assert.equal(result.customers[0].wechatId, 'wx_csv');
  assert.equal(result.customers[0].messages[0].text, '需要咖啡,茶\n包装写"谢谢"');
  assert.throws(() => parseChatImport('content\n"没有闭合', 'bad.csv', []), /未闭合/);
});

test('JSONL 消息按会话分组并识别商家角色', () => {
  const text = [{ chat_id: 'chat-1', customer_name: '甲', timestamp: '2026-11-07', sender: 'customer', content: '问一下商品' }, { chat_id: 'chat-1', customer_name: '甲', timestamp: '2026-11-07', sender: 'merchant', content: '可以，我发您资料' }, { chat_id: 'chat-2', customer_name: '甲', timestamp: 1794000000, sender: 'customer', content: '另一个会话' }].map(value => JSON.stringify(value)).join('\n');
  const result = parseChatImport(text, 'chat.jsonl', []);
  assert.equal(result.customers.length, 2);
  assert.equal(result.record.messageCount, 3);
  assert.equal(result.customers[0].messages[1].sender, 'merchant');
});

test('ISO 时间与时间戳按上海日期归一，不允许无效日期自动进位', () => {
  const result = parseChatImport(JSON.stringify({ name: '时区示例', wechatId: 'wx_timezone', messages: [
    { sender: 'customer', text: '已付款100元', timestamp: '2026-11-06T18:00:00Z' },
    { sender: 'customer', text: '无效日期需要核对', timestamp: '2026-02-31T10:00:00+08:00' },
  ] }), 'time.json', []);
  const paid = result.customers[0].messages.find(message => message.text === '已付款100元')!;
  assert.equal(paid.date, '2026-11-07T02:00:00.000+08:00');
  assert.equal(extractCandidates(result.customers[0])[0].date, '2026-11-07');
  assert.ok(result.warnings.some(warning => warning.includes('缺少有效时间')));
});

test('TXT 明确按单联系人解析并提示缺失时间，不接受空文件', () => {
  const result = parseChatImport('2026-11-07 09:00 小夏：想了解一下咖啡礼盒\n我还没有决定', '小夏聊天.txt', []);
  assert.equal(result.customers.length, 1);
  assert.equal(result.customers[0].name, '小夏');
  assert.equal(result.customers[0].messages.length, 2);
  assert.ok(result.warnings.some(warning => warning.includes('TXT')));
  assert.ok(result.warnings.some(warning => warning.includes('缺少有效时间')));
  assert.throws(() => parseChatImport('\uFEFF   ', 'empty.json', []), /为空/);
});

test('Markdown 文本与 UTF-8 字节容量限制和页面一致', () => {
  const result = parseChatImport('2026-11-07 客户：想了解一下产品', '小夏.md', []);
  assert.equal(result.customers[0].name, '小夏');
  assert.throws(() => parseChatImport('汉'.repeat(700000), 'too-large.txt', []), /2 MB/);
  assert.throws(() => parseChatImport(JSON.stringify({ name: '示例', messages: [{ text: '字'.repeat(8001) }] }), 'too-long.json', []), /8000/);
});

test('付款规则仅生成明确已付待确认候选，拒绝报价、意向、疑问和否定', () => {
  const customer: Customer = { ...demoSeed().customers[0], messages: [
    { id: '1', sender: 'customer', text: '已经支付298元，谢谢', date: '2026-11-07' },
    { id: '2', sender: 'merchant', text: '收到您的付款298元，谢谢', date: '2026-11-07' },
    { id: '3', sender: 'customer', text: '这款报价398元，我想买', date: '2026-11-07' },
    { id: '4', sender: 'customer', text: '如果已付款398元，可以退吗？', date: '2026-11-07' },
    { id: '5', sender: 'merchant', text: '未收到付款398元', date: '2026-11-07' },
    { id: '6', sender: 'merchant', text: '已退款68元，请核对', date: '2026-11-07' },
    { id: '7', sender: 'customer', text: '预计已付款500元', date: '2026-11-07' },
  ] };
  const orders = extractCandidates(customer);
  assert.equal(orders.length, 2);
  assert.deepEqual(orders.map(order => [order.type, order.amount, order.status]), [['sale', 298, 'pending'], ['refund', 68, 'pending']]);
  assert.equal(customerStats(customer.id, orders).total, 0);
});

test('示例文件可以实际导入，并且提供同一微信号的一致数据', () => {
  const json = readFileSync(new URL('../public/chat-import-example.json', import.meta.url), 'utf8');
  const csv = readFileSync(new URL('../public/chat-import-example.csv', import.meta.url), 'utf8');
  const first = parseChatImport(json, 'example.json', []);
  const second = parseChatImport(csv, 'example.csv', first.customers);
  assert.equal(first.customers.length, 2);
  assert.equal(second.customers.length, 2);
  assert.equal(first.record.messageCount, 5);
});

test('wechat-chat-export 私聊 JSON 保留真实客户身份、角色、时间与多行正文', () => {
  const text = readFileSync(new URL('../public/wechat-chat-export-example.json', import.meta.url), 'utf8');
  const imported = parseChatImport(text, '聊天记录.json', []);
  const customer = imported.customers[0];
  assert.equal(customer.name, '示例客户·林悦');
  assert.equal(customer.wechatId, 'wxid_example_linyue');
  assert.equal(imported.record.messageCount, 5);
  assert.equal(customer.messages[0].sender, 'customer');
  assert.equal(customer.messages[1].sender, 'merchant');
  assert.equal(customer.messages[0].date, '2026-10-22T16:10:00.000+08:00');
  assert.ok(customer.messages[0].text.includes('\n包装简单一点'));
  assert.ok(customer.messages.some(message => message.text.startsWith('【转账/收款卡片，到账状态未核实】')));
  assert.ok(customer.messages.some(message => message.text.startsWith('【引用资料，非客户本人陈述】')));
  assert.ok(!customer.messages.some(message => message.text === '已经支付999元'));
  assert.ok(imported.warnings.some(warning => warning.includes('合并转发')));
  assert.deepEqual(extractCandidates(customer), []);
  const repeated = parseChatImport(text, '重叠时间段.json', imported.customers);
  assert.equal(repeated.customers.length, 1);
  assert.equal(repeated.record.messageCount, 0);
});

test('wechat-chat-export 原生消息ID保留同秒同文不同消息，重名私聊不误合并', () => {
  const fixture = JSON.parse(readFileSync(new URL('../public/wechat-chat-export-example.json', import.meta.url), 'utf8'));
  fixture.messages = [fixture.messages[0], { ...fixture.messages[0], local_id: 99, server_id: '900000000000000099' }];
  const first = parseChatImport(JSON.stringify(fixture), 'first.json', []);
  assert.equal(first.record.messageCount, 2);
  assert.notEqual(first.customers[0].messages[0].id, first.customers[0].messages[1].id);
  fixture.metadata.chat_username = 'wxid_example_another';
  fixture.messages = fixture.messages.map((message: Record<string, unknown>) => ({ ...message, sender_username: 'wxid_example_another', chat_username: 'wxid_example_another' }));
  const second = parseChatImport(JSON.stringify(fixture), 'second.json', first.customers);
  assert.equal(second.customers.length, 2);
  assert.equal(second.customers[0].name, second.customers[1].name);
  assert.notEqual(second.customers[0].wechatId, second.customers[1].wechatId);
});

test('wechat-chat-export 群聊与文件传输助手显式拒绝，防止归属错误', () => {
  const group = { metadata: { chat: '项目群', chat_username: '12345@chatroom', chat_type: 'group' }, messages: [] };
  assert.throws(() => parseChatImport(JSON.stringify(group), 'group.json', []), /好友私聊/);
  const helper = { metadata: { chat: '文件传输助手', chat_username: 'filehelper', chat_type: 'private' }, messages: [] };
  assert.throws(() => parseChatImport(JSON.stringify(helper), 'helper.json', []), /文件传输助手/);
});

test('wechat-chat-export TXT 按消息块还原多行，跳过前言、系统与转发', () => {
  const text = readFileSync(new URL('../public/wechat-chat-export-example.txt', import.meta.url), 'utf8');
  const result = parseChatImport(text, '聊天记录.txt', []);
  const customer = result.customers[0];
  assert.equal(customer.name, '示例客户·林悦');
  assert.equal(customer.wechatId, '');
  assert.equal(result.record.messageCount, 5);
  assert.equal(customer.messages[1].sender, 'merchant');
  assert.ok(customer.messages[0].text.includes('\n包装简单一点'));
  assert.ok(!customer.messages.some(message => message.text.includes('结束时刻不含')));
  assert.ok(!customer.messages.some(message => message.text === '已经支付999元'));
  assert.ok(result.warnings.some(warning => warning.includes('TXT 不携带微信号及会话类型')));
  assert.deepEqual(extractCandidates(customer), []);
});

test('演示数据完整且每次调用相互独立', () => {
  const first = demoSeed();
  const second = demoSeed();
  assert.equal(first.demo, true);
  assert.equal(first.customers.length, 16);
  assert.equal(first.tasks.length, 8);
  assert.ok(first.customers.every(customer => customer.source === 'demo' && customer.messages.length >= 3 && customer.evidence.length >= 2));
  assert.ok(first.orders.some(order => order.type === 'refund' && order.status === 'pending'));
  assert.ok(first.orders.some(order => order.date === today() && order.status === 'confirmed'));
  assert.equal(overviewStats(first, 7).newCustomers, 4);
  assert.equal(overviewStats(first, 30).newCustomers, 16);
  assert.equal(overviewStats(first, 7).todayRevenue, 864);
  assert.ok(first.orders.every(order => order.date >= first.customers.find(customer => customer.id === order.customerId)!.createdAt));
  assert.ok(first.customers.every(customer => customer.messages.every(message => message.date >= customer.createdAt)));
  assert.ok(first.customers.every(customer => customer.nextFollowUpAt === (first.tasks.filter(task => task.customerId === customer.id && task.status === 'todo').map(task => task.date).sort()[0] || '')));
  first.settings.ai.model = 'changed';
  assert.equal(second.settings.ai.model, 'deepseek-chat');
});
