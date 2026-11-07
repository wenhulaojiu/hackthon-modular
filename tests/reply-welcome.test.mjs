import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createReplyEngine, DEFAULT_REPLY_SETTINGS, DEFAULT_WELCOME_MESSAGE } from '../scripts/local-wechat/reply-engine.mjs';

const initialTime = Date.parse('2026-11-07T02:00:00.000Z');
const intro = '您好，欢迎来到合成门店！可以在这里咨询已上架的商品与服务。';
const reply = { action: 'reply', reply: '您好，咖啡礼盒100元。', reason: '门店商品价格。', productIds: ['coffee'] };
const config = (mode = 'auto') => ({ settings: { ...structuredClone(DEFAULT_REPLY_SETTINGS), enabled: true, mode, selectedCustomerIds: ['old'], welcomeMessage: intro, debounceSeconds: 60, cooldownSeconds: 0, businessHours: { enabled: false, start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5, 6] } }, customers: [{ id: 'old', wechatId: 'wxid_old', name: '旧客户', autoReplyEnabled: true }], products: [{ id: 'coffee', name: '咖啡礼盒', type: 'product', price: 100, description: '', faq: [], enabled: true }], storeName: '合成门店', industry: '零售' });
const welcomeEvent = (extra = {}) => ({ chatId: 'wxid_new', eventId: 'native-friend-event', date: new Date(initialTime).toISOString(), ...extra });
const incoming = (id, extra = {}) => ({ id, chatId: 'wxid_new', sender: 'customer', text: '请问咖啡礼盒多少钱？', date: new Date(initialTime).toISOString(), source: 'realtime', kind: 'text', ...extra });
const addCustomer = async engine => {
  const current = await engine.getConfig();
  const next = { ...current, settings: { ...current.settings, selectedCustomerIds: [...current.settings.selectedCustomerIds, 'new'] }, customers: [...current.customers, { id: 'new', wechatId: 'wxid_new', name: '新客户', autoReplyEnabled: true, humanTakeover: false }] };
  await engine.enrollCustomers(next);
};

async function fixture(t, options = {}) {
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, 'kexu-welcome-test-'));
  const engines = [];
  const create = async (overrides = {}) => { const engine = await createReplyEngine({ directory, now: () => initialTime, tickMs: 5, ...options, ...overrides }); engines.push(engine); return engine; };
  const engine = await create();
  t.after(async () => {
    for (const item of engines) await item.close();
    const actual = await realpath(directory);
    assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(actual).startsWith('kexu-welcome-test-'));
    // 仅清理本次合成测试创建的目录，不读取或操作实际微信数据。
    await rm(actual, { recursive: true, force: true });
  });
  return { engine, create, directory, filename: path.join(directory, 'queue.json') };
}

async function until(engine, check) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await engine.status();
    if (check(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('合成欢迎任务未达到预期状态');
}

test('欢迎固定使用保存文案且不调用AI，先发送欢迎，普通两条咨询仍合并等待60秒', async t => {
  let clock = initialTime; const sent = []; const generated = [];
  const { engine } = await fixture(t, { now: () => clock, generate: async work => { generated.push(work); return reply; }, send: async input => { sent.push(input); return { status: 'sent', messageId: `sent-${sent.length}` }; } });
  await engine.syncConfig(config()); await engine.start(); await addCustomer(engine);
  assert.equal((await engine.enqueueWelcome(welcomeEvent())).accepted, true);
  await engine.ingest(incoming('part-one'));
  clock += 2000; await engine.ingest(incoming('part-two', { text: '有现货吗？' }));
  const state = await until(engine, result => result.counts.sent === 1);
  assert.equal(sent[0].text, intro); assert.equal(generated.length, 0);
  const welcome = state.jobs.find(job => job.kind === 'welcome');
  const normal = state.jobs.find(job => job.kind === 'reply');
  assert.equal(welcome.status, 'sent'); assert.equal(welcome.messages.length, 1);
  assert.deepEqual(normal.messages.map(message => message.id), ['part-one', 'part-two']);
  assert.equal(Date.parse(normal.quietUntil), clock + 60_000);
  assert.ok(!normal.message.text.includes('首次接待'));
  clock += 59_999;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, 1); assert.equal(generated.length, 0);
  clock++;
  await until(engine, result => result.counts.sent === 2);
  assert.equal(generated.length, 1); assert.equal(sent[1].text, reply.reply);
  assert.equal((await engine.enqueueWelcome(welcomeEvent({ eventId: 'another-friend-event' }))).duplicate, true);
});

test('审阅模式欢迎仅生成固定草稿，不进入AI工作租约，批准后才发送', async t => {
  let sends = 0; let generations = 0;
  const { engine } = await fixture(t, { generate: async () => { generations++; return reply; }, send: async () => ({ status: 'sent', messageId: `sent-${++sends}` }) });
  await engine.syncConfig(config('review')); await engine.start(); await addCustomer(engine);
  await engine.enqueueWelcome(welcomeEvent());
  const state = await until(engine, result => result.counts.draft === 1);
  assert.equal(state.jobs[0].kind, 'welcome'); assert.equal(state.jobs[0].reply, intro);
  assert.equal(generations, 0); assert.equal(sends, 0); assert.deepEqual(await engine.claimWork(), { jobs: [] });
  await engine.approve(state.jobs[0].id);
  await until(engine, result => result.counts.sent === 1);
  assert.equal(sends, 1); assert.equal(generations, 0);
});

test('欢迎营业时间外保留queued直到开门，普通咨询闭店行为仍为ignored', async t => {
  let clock = initialTime; let sends = 0;
  const { engine } = await fixture(t, { now: () => clock, send: async () => ({ status: 'sent', messageId: `sent-${++sends}` }) });
  const initial = config(); initial.settings.businessHours.enabled = true; initial.settings.businessHours.days = [1];
  await engine.syncConfig(initial); await engine.start(); await addCustomer(engine);
  await engine.enqueueWelcome(welcomeEvent());
  assert.equal((await engine.ingest(incoming('closed-consultation'))).status, 'ignored');
  await new Promise(resolve => setTimeout(resolve, 20));
  const closed = await engine.status();
  assert.equal(closed.jobs.find(job => job.kind === 'welcome').status, 'queued'); assert.equal(sends, 0);
  clock = Date.parse('2026-11-09T02:00:00.000Z');
  await until(engine, result => result.counts.sent === 1);
  assert.equal(sends, 1); assert.equal((await engine.status()).counts.ignored, 1);
});

for (const outcome of ['sent', 'unknown']) test(`欢迎${outcome}后跨重启仍只保留一次，重复事件不重新发送`, async t => {
  let sends = 0;
  const f = await fixture(t, { send: async () => { sends++; return outcome === 'sent' ? { status: 'sent', messageId: 'confirmed-once' } : { status: 'unknown' }; } });
  await f.engine.syncConfig(config()); await f.engine.start(); await addCustomer(f.engine);
  await f.engine.enqueueWelcome(welcomeEvent());
  await until(f.engine, result => result.counts[outcome] === 1);
  await f.engine.close(); const reopened = await f.create(); await reopened.start();
  assert.equal((await reopened.enqueueWelcome(welcomeEvent({ eventId: 'new-event-after-restart' }))).duplicate, true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await reopened.status()).jobs.length, 1); assert.equal(sends, 1);
});

test('旧客户不补发，暂停、非法事件及自定义正文不能绕过新客户欢迎资格', async t => {
  const { engine } = await fixture(t, { send: async () => { assert.fail('此测试不得发送'); } });
  await engine.syncConfig(config()); await engine.start();
  assert.equal((await engine.enqueueWelcome(welcomeEvent({ chatId: 'wxid_old' }))).accepted, false);
  await addCustomer(engine);
  for (const bad of [welcomeEvent({ text: '外部任意正文' }), welcomeEvent({ eventId: '' }), welcomeEvent({ date: 'not-date' }), welcomeEvent({ chatId: 'filehelper' }), welcomeEvent({ chatId: 'room@chatroom' })]) await assert.rejects(engine.enqueueWelcome(bad), /格式不正确/);
  await engine.pause();
  assert.equal((await engine.enqueueWelcome(welcomeEvent())).accepted, false);
  assert.equal((await engine.status()).jobs.length, 0);
});

for (const change of [initial => { initial.settings.welcomeEnabled = false; }, initial => { initial.settings.welcomeMessage = ''; }]) test('欢迎关闭或明确空文案时记录跳过，日后重新开启不补发旧欢迎', async t => {
  const { engine } = await fixture(t, { send: async () => { assert.fail('关闭或空文案不得发送'); } });
  const initial = config(); change(initial);
  await engine.syncConfig(initial); await engine.start(); await addCustomer(engine);
  assert.equal((await engine.enqueueWelcome(welcomeEvent())).accepted, false);
  const next = await engine.getConfig(); next.settings.welcomeEnabled = true; next.settings.welcomeMessage = intro;
  await engine.syncConfig(next);
  assert.equal((await engine.enqueueWelcome(welcomeEvent({ eventId: 'after-enable' }))).duplicate, true);
  assert.equal((await engine.status()).jobs.length, 0);
});

test('欢迎当前文案改变、人工接管或敏感咨询都阻止旧文案自动发送', async t => {
  for (const scenario of ['changed-copy', 'takeover', 'sensitive-incoming']) await t.test(scenario, async subtest => {
    let sends = 0;
    const { engine } = await fixture(subtest, { send: async () => { sends++; return { status: 'sent', messageId: 'unexpected' }; } });
    const initial = config(); if (scenario !== 'sensitive-incoming') initial.settings.businessHours = { enabled: true, start: '23:00', end: '23:30', days: [6] };
    await engine.syncConfig(initial); await engine.start(); await addCustomer(engine); await engine.enqueueWelcome(welcomeEvent());
    if (scenario === 'changed-copy') { const next = await engine.getConfig(); next.settings.welcomeMessage = '更新后的店铺介绍'; await engine.syncConfig(next); }
    if (scenario === 'takeover') await engine.takeover({ customerId: 'new', enabled: true });
    if (scenario === 'sensitive-incoming') await engine.ingest(incoming('refund-request', { text: '我要退款，请转人工。' }));
    const state = await until(engine, result => result.jobs.find(job => job.kind === 'welcome').status === 'handoff');
    assert.equal(sends, 0); assert.equal(state.jobs.find(job => job.kind === 'welcome').reply, intro);
    assert.equal((await engine.enqueueWelcome(welcomeEvent({ eventId: 'repeat' }))).duplicate, true);
  });
});

test('欢迎设置严格校验，缺省文案兼容旧规则，旧队列不向已有客户补发', async t => {
  const f = await fixture(t);
  const initial = config('review'); delete initial.settings.welcomeEnabled; delete initial.settings.welcomeMessage;
  await f.engine.syncConfig(initial);
  const normalized = await f.engine.getConfig(); assert.equal(normalized.settings.welcomeEnabled, true); assert.equal(normalized.settings.welcomeMessage, DEFAULT_WELCOME_MESSAGE);
  for (const value of [null, 'true', 1]) { const next = config('review'); next.settings.welcomeEnabled = value; await assert.rejects(f.engine.syncConfig(next), /首次店铺介绍/); }
  for (const value of [null, 1, '中'.repeat(301), 'bad\0text', '\ud800']) { const next = config('review'); next.settings.welcomeMessage = value; await assert.rejects(f.engine.syncConfig(next), /首次店铺介绍/); }
  await f.engine.close(); const legacy = JSON.parse(await readFile(f.filename, 'utf8')); delete legacy.welcomeOnce; delete legacy.config.settings.welcomeEnabled; delete legacy.config.settings.welcomeMessage;
  await writeFile(f.filename, JSON.stringify(legacy), 'utf8'); const reopened = await f.create(); await reopened.start();
  assert.equal((await reopened.enqueueWelcome(welcomeEvent({ chatId: 'wxid_old' }))).accepted, false);
  await addCustomer(reopened);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(f.filename, 'utf8')).welcomeOnce), ['wxid_new']);
});

test('欢迎防重记录最多500个会话，容量满不覆盖旧记录或半写新接待配置', async t => {
  const f = await fixture(t);
  await f.engine.syncConfig(config('review')); await f.engine.close();
  const stored = JSON.parse(await readFile(f.filename, 'utf8'));
  stored.welcomeOnce = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`wxid_used_${index}`, { customerId: `used-${index}`, enrolledAt: new Date(initialTime).toISOString(), state: 'skipped' }]));
  await writeFile(f.filename, JSON.stringify(stored), 'utf8'); const reopened = await f.create(); await reopened.start();
  await assert.rejects(addCustomer(reopened), /防重容量已满/);
  assert.equal((await reopened.getConfig()).customers.length, 1);
  assert.equal(Object.keys(JSON.parse(await readFile(f.filename, 'utf8')).welcomeOnce).length, 500);
});

test('欢迎发送后120秒内纯标点、空白和整句招呼不再调用AI，入站审计和防重仍保留', async t => {
  let clock = initialTime; let generations = 0; let sends = 0;
  const f = await fixture(t, { now: () => clock, generate: async () => { generations++; return reply; }, send: async () => ({ status: 'sent', messageId: `sent-${++sends}` }) });
  await f.engine.syncConfig(config()); await f.engine.start(); await addCustomer(f.engine); await f.engine.enqueueWelcome(welcomeEvent());
  await until(f.engine, result => result.counts.sent === 1);
  const texts = ['。', '，！？…', '  \n\t ', '', '你好！', '您好', 'HI', 'hello.', '哈喽', '嗨'];
  for (const [index, text] of texts.entries()) {
    clock += 1000;
    const result = await f.engine.ingest(incoming(`greeting-${index}`, { text, nativeMessageId: `native-${index}` }));
    assert.equal(result.status, 'ignored'); assert.match(result.reason, /不再生成重复介绍/);
  }
  clock = initialTime + 120_000;
  assert.equal((await f.engine.ingest(incoming('exact-boundary', { text: '你好。' }))).status, 'ignored');
  const stored = JSON.parse(await readFile(f.filename, 'utf8'));
  assert.deepEqual(stored.history.wxid_new.filter(message => message.sender === 'customer').map(message => message.text), [...texts, '你好。']);
  assert.ok(stored.seen.includes('wxid_new\u0000greeting-0')); assert.ok(stored.seen.includes('wxid_new\u0000native:native-0'));
  assert.equal((await f.engine.ingest(incoming('greeting-0', { text: '。', nativeMessageId: 'native-0' }))).duplicate, true);
  assert.equal((await f.engine.status()).jobs.length, 1); assert.equal(generations, 0); assert.equal(sends, 1);
});

test('欢迎待审核时简单招呼不新建咨询，也不重置已有实质问题的60秒截止', async t => {
  let clock = initialTime; let generations = 0;
  const f = await fixture(t, { now: () => clock, generate: async () => { generations++; return reply; } });
  await f.engine.syncConfig(config('review')); await f.engine.start(); await addCustomer(f.engine); await f.engine.enqueueWelcome(welcomeEvent());
  await until(f.engine, result => result.counts.draft === 1);
  assert.equal((await f.engine.ingest(incoming('question', { text: '你好，美式多少钱？' }))).accepted, true);
  const before = (await f.engine.status()).jobs.find(job => job.kind === 'reply');
  clock += 5000;
  assert.equal((await f.engine.ingest(incoming('just-hi', { text: '你好！' }))).status, 'ignored');
  const after = (await f.engine.status()).jobs.find(job => job.kind === 'reply');
  assert.equal(after.quietUntil, before.quietUntil); assert.deepEqual(after.messages, before.messages);
  assert.equal(after.message.text, '你好，美式多少钱？'); assert.equal(generations, 0);
  assert.equal((await f.engine.status()).jobs.length, 2);
});

test('欢迎营业外queued和原生发送在途时，短招呼均不创建第二份介绍', async t => {
  await t.test('营业外排队', async subtest => {
    const f = await fixture(subtest);
    const initial = config('review'); initial.settings.businessHours = { enabled: true, start: '23:00', end: '23:30', days: [6] };
    await f.engine.syncConfig(initial); await f.engine.start(); await addCustomer(f.engine); await f.engine.enqueueWelcome(welcomeEvent());
    assert.equal((await f.engine.ingest(incoming('queued-hi', { text: '您好。' }))).status, 'ignored');
    assert.equal((await f.engine.status()).jobs.length, 1); assert.equal((await f.engine.status()).jobs[0].status, 'queued');
  });
  await t.test('发送中', async subtest => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const f = await fixture(subtest, { send: async () => pending });
    try {
      await f.engine.syncConfig(config()); await f.engine.start(); await addCustomer(f.engine); await f.engine.enqueueWelcome(welcomeEvent());
      await until(f.engine, result => result.counts.sending === 1);
      assert.equal((await f.engine.ingest(incoming('sending-hi', { text: '。' }))).status, 'ignored');
      assert.equal((await f.engine.status()).jobs.length, 1);
    } finally { finish({ status: 'sent', messageId: 'finished-welcome' }); }
  });
});

test('超过120秒或普通会话的招呼照常入队，欢迎以外的空白仍拒绝', async t => {
  let clock = initialTime;
  const f = await fixture(t, { now: () => clock, send: async () => ({ status: 'sent', messageId: 'welcome-sent' }) });
  await f.engine.syncConfig(config()); await f.engine.start(); await addCustomer(f.engine); await f.engine.enqueueWelcome(welcomeEvent());
  await until(f.engine, result => result.counts.sent === 1);
  clock += 120_001;
  assert.equal((await f.engine.ingest(incoming('late-hi', { text: '你好' }))).accepted, true);
  assert.equal((await f.engine.ingest(incoming('ordinary-hi', { chatId: 'wxid_old', text: 'hello' }))).accepted, true);
  await assert.rejects(f.engine.ingest(incoming('ordinary-blank', { chatId: 'wxid_old', text: ' \n ' })), /缺少稳定标识或有效内容/);
});

test('明确诉求、退款人工及自定义转人工关键词不被简单招呼过滤绕过', async t => {
  const f = await fixture(t);
  const initial = config('review'); initial.settings.handoffKeywords.push('hello');
  await f.engine.syncConfig(initial); await f.engine.start(); await addCustomer(f.engine); await f.engine.enqueueWelcome(welcomeEvent());
  await until(f.engine, result => result.counts.draft === 1);
  assert.equal((await f.engine.ingest(incoming('real-question', { text: '你好，美式多少钱？' }))).accepted, true);
  assert.equal((await f.engine.ingest(incoming('keyword-greeting', { text: 'hello' }))).status, 'handoff');
  assert.equal((await f.engine.ingest(incoming('refund', { text: '你好，我要退款，请转人工。' }))).status, 'handoff');
  const state = await f.engine.status(); assert.ok(state.takeovers.includes('new')); assert.equal(state.counts.sent, 0);
});

for (const status of ['failed', 'unknown', 'cancelled']) test(`欢迎${status}后不压制客户招呼`, async t => {
  const f = await fixture(t, { send: async () => ({ status }) });
  await f.engine.syncConfig(config(status === 'cancelled' ? 'review' : 'auto')); await f.engine.start(); await addCustomer(f.engine); await f.engine.enqueueWelcome(welcomeEvent());
  if (status === 'cancelled') { const state = await until(f.engine, result => result.counts.draft === 1); await f.engine.reject(state.jobs[0].id); }
  else { await until(f.engine, result => result.counts[status] === 1); await f.engine.takeover({ customerId: 'new', enabled: false }); }
  assert.equal((await f.engine.ingest(incoming(`hi-after-${status}`, { text: '你好' }))).accepted, true);
});
