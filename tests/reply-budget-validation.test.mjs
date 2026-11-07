import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createReplyEngine, DEFAULT_REPLY_SETTINGS } from '../scripts/local-wechat/reply-engine.mjs';

const timestamp = Date.parse('2026-11-08T02:00:00.000Z');
const configuration = () => ({
  settings: { ...structuredClone(DEFAULT_REPLY_SETTINGS), enabled: true, mode: 'review', selectedCustomerIds: ['c1', 'c2'], businessHours: { enabled: false, start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5, 6] }, debounceSeconds: 0, cooldownSeconds: 0 },
  customers: [{ id: 'c1', wechatId: 'wxid_c1', name: '合成客户甲', autoReplyEnabled: true }, { id: 'c2', wechatId: 'wxid_c2', name: '合成客户乙', autoReplyEnabled: true }],
  products: [{ id: 'bread', name: '面包', type: 'product', price: 10, description: '', faq: [], enabled: true }, { id: 'coffee', name: '美式咖啡', type: 'product', price: 18, description: '', faq: [], enabled: true }], storeName: '合成门店', industry: '零售',
});
const turn = (id, sender, text, offset = -30_000) => ({ id, sender, text, date: new Date(timestamp + offset).toISOString() });
const event = (id = 'synthetic-current', text = '你好，有什么推荐') => ({ id, chatId: 'wxid_c1', sender: 'customer', text, date: new Date(timestamp).toISOString(), kind: 'text', source: 'realtime' });
const result = reply => ({ action: 'reply', reply, reason: '仅依据合成门店结构价格及客户预算。', productIds: [] });
const budgetReply = '您的预算20元，可了解面包10元与美式咖啡18元。';

async function fixture(t, history = {}, config = configuration()) {
  const temporary = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporary, 'kexu-budget-validation-'));
  const engines = []; const sent = [];
  const create = async () => {
    const engine = await createReplyEngine({ directory, now: () => timestamp, tickMs: 10, send: async packet => { sent.push(packet); return { status: 'sent', messageId: `synthetic-sent-${sent.length}` }; } });
    engines.push(engine); return engine;
  };
  const f = { engine: await create(), directory, sent };
  f.rewrite = async rewrite => {
    // 队列只能在引擎关闭后修改，并且仅限本测试的独立临时目录。
    await f.engine.close();
    const filename = path.join(directory, 'queue.json'); const saved = JSON.parse(await readFile(filename, 'utf8'));
    rewrite(saved); await writeFile(filename, JSON.stringify(saved), 'utf8');
    f.engine = await create();
  };
  t.after(async () => {
    for (const engine of engines) await engine.close();
    const actual = await realpath(directory);
    assert.equal(path.dirname(actual).toLowerCase(), temporary.toLowerCase());
    assert.ok(path.basename(actual).startsWith('kexu-budget-validation-'));
    await rm(actual, { recursive: true, force: true });
  });
  await f.engine.syncConfig(config);
  if (Object.keys(history).length) await f.rewrite(saved => { saved.history = history; });
  return f;
}

async function until(engine, condition) {
  for (let count = 0; count < 600; count += 1) {
    const state = await engine.status();
    if (condition(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('合成预算回复任务未进入预期状态');
}

async function generate(f, reply, message = event()) {
  await f.engine.start(); await f.engine.ingest(message);
  const work = (await f.engine.claimWork()).jobs[0]; assert.ok(work);
  const completed = await f.engine.completeWork({ jobId: work.id, leaseId: work.leaseId, result: result(reply) });
  return { work, completed };
}

test('同会话客户历史预算可用于当前推荐，审阅批准和发送前核验均通过', async t => {
  const f = await fixture(t, { wxid_c1: [turn('synthetic-budget', 'customer', '我的预算只有20元。')] });
  const { completed } = await generate(f, budgetReply);
  assert.equal(completed.status, 'draft'); assert.equal(completed.reply, budgetReply);
  const persisted = JSON.parse(await readFile(path.join(f.directory, 'queue.json'), 'utf8'));
  assert.equal(Object.hasOwn(persisted.jobs[0], 'context'), false);
  await f.engine.approve(completed.id);
  await until(f.engine, state => state.counts.sent === 1);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].text, budgetReply);
});

test('客户预算仅豁免明确预算引用，不能为同金额的面包新报价背书', async t => {
  const f = await fixture(t, { wxid_c1: [turn('synthetic-budget', 'customer', '预算20元。')] });
  const { completed } = await generate(f, '预算20元，面包20元。');
  assert.equal(completed.status, 'handoff'); assert.equal(f.sent.length, 0);
});

test('未知冲突商家及其他会话预算均不能为本次预算引用背书', async t => {
  const scenarios = [
    ['未知预算', {}],
    ['冲突预算', { wxid_c1: [turn('budget-one', 'customer', '预算20元。'), turn('budget-two', 'customer', '预算30元。', -20_000)] }],
    ['商家预算', { wxid_c1: [turn('merchant-budget', 'merchant', '您的预算20元。')] }],
    ['其他会话预算', { wxid_c2: [turn('other-budget', 'customer', '预算20元。')] }],
  ];
  for (const [name, history] of scenarios) await t.test(name, async child => {
    const f = await fixture(child, history); const { completed } = await generate(f, budgetReply);
    assert.equal(completed.status, 'handoff'); assert.equal(f.sent.length, 0);
  });
});

test('完整精度金额不会截成小数尾部，畸形货币数字保守拒绝', async t => {
  for (const scenario of [
    { name: '精确价格通过', prices: [1.005], reply: '样品标价1.005元。', expected: 'draft' },
    { name: '不能把1.005当作1', prices: [1], reply: '样品标价1.005元。', expected: 'handoff' },
    { name: '不能只核对小数尾部', prices: [0.005], reply: '样品标价1.005元。', expected: 'handoff' },
    { name: '畸形数字不是两段合法金额', prices: [1.2, 3], reply: '样品标价￥1.2.3元。', expected: 'handoff' },
  ]) await t.test(scenario.name, async child => {
    const config = configuration(); config.products = scenario.prices.map((price, index) => ({ id: `sample-${index}`, name: `样品${index}`, type: 'product', price, description: '', faq: [], enabled: true }));
    const f = await fixture(child, {}, config); const { completed } = await generate(f, scenario.reply);
    assert.equal(completed.status, scenario.expected); assert.equal(f.sent.length, 0);
  });
});

test('主动跟进不能借用聊天预算，门店已核对价格仍可发送', async t => {
  const f = await fixture(t, { wxid_c1: [turn('synthetic-budget', 'customer', '预算20元。')] });
  await f.engine.start();
  await assert.rejects(f.engine.enqueueFollowup({ taskId: 'synthetic-budget-followup', customerId: 'c1', text: budgetReply }), /价格|金额/);
  assert.equal(f.sent.length, 0); assert.equal((await f.engine.status()).submittedFollowups.length, 0);
  await f.engine.enqueueFollowup({ taskId: 'synthetic-known-price-followup', customerId: 'c1', text: '面包标价10元，欢迎咨询。' });
  await until(f.engine, state => state.counts.sent === 1); assert.equal(f.sent[0].text, '面包标价10元，欢迎咨询。');
});

test('批准草稿时立即按新价格核验，不能批准已失效旧价', async t => {
  const f = await fixture(t); const { completed } = await generate(f, '面包标价10元。'); assert.equal(completed.status, 'draft');
  const changed = configuration(); changed.products[0].price = 11; await f.engine.syncConfig(changed);
  await assert.rejects(f.engine.approve(completed.id), /价格|金额|资料/);
  assert.equal(f.sent.length, 0); assert.equal((await f.engine.getJob(completed.id)).status, 'draft');
});

test('批准后暂停再改价，恢复时发送前二次核验阻止旧价格', async t => {
  const f = await fixture(t); const { completed } = await generate(f, '面包标价10元。');
  await f.engine.approve(completed.id); await f.engine.pause();
  assert.equal(f.sent.length, 0); assert.equal((await f.engine.getJob(completed.id)).status, 'ready');
  const changed = configuration(); changed.products[0].price = 11; await f.engine.syncConfig(changed); await f.engine.start();
  await until(f.engine, state => state.counts.handoff === 1);
  assert.equal(f.sent.length, 0); assert.equal((await f.engine.getJob(completed.id)).status, 'handoff');
});

test('预算不能来自当前消息之后的历史，截止消息缺失时也不能借整个历史', async t => {
  for (const missing of [false, true]) await t.test(missing ? '截止消息缺失' : '未来历史预算', async child => {
    const f = await fixture(child); await f.engine.start(); const current = event(); await f.engine.ingest(current);
    await f.rewrite(saved => {
      const currentHistory = saved.history.wxid_c1.find(message => message.id === current.id);
      saved.history.wxid_c1 = missing ? [turn('untrusted-history-budget', 'customer', '预算20元。')] : [currentHistory, turn('future-budget', 'customer', '预算20元。', 30_000)];
    });
    await f.engine.start(); const work = (await f.engine.claimWork()).jobs[0]; assert.ok(work);
    const completed = await f.engine.completeWork({ jobId: work.id, leaseId: work.leaseId, result: result(budgetReply) });
    assert.equal(completed.status, 'handoff'); assert.equal(f.sent.length, 0);
  });
});

test('截止消息缺失仍可信原始本批预算，不需要保存独立上下文字段', async t => {
  const f = await fixture(t); await f.engine.start();
  await f.engine.ingest(event('batch-budget', '预算20元。')); await f.engine.ingest(event('batch-question', '你好，有什么推荐'));
  await f.rewrite(saved => { saved.history.wxid_c1 = []; });
  await f.engine.start(); const work = (await f.engine.claimWork()).jobs[0]; assert.ok(work);
  assert.ok(work.messages.some(message => message.text === '预算20元。'));
  const completed = await f.engine.completeWork({ jobId: work.id, leaseId: work.leaseId, result: result(budgetReply) });
  assert.equal(completed.status, 'draft'); assert.equal(f.sent.length, 0);
});
