import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createReplyEngine, DEFAULT_REPLY_SETTINGS } from '../scripts/local-wechat/reply-engine.mjs';
import { GENERATION_FAILURES, GenerationError, normalizeGenerationFailure } from '../scripts/local-wechat/reply-generation-errors.mjs';

const RAW_SECRET = 'SYNTHETIC_PROVIDER_SECRET_DO_NOT_PERSIST';
const RAW_CHAT = 'SYNTHETIC_PROVIDER_CHAT_DO_NOT_PERSIST';
const timestamp = Date.parse('2026-11-07T02:00:00.000Z');
const configuration = () => ({
  settings: { ...structuredClone(DEFAULT_REPLY_SETTINGS), enabled: true, mode: 'auto', selectedCustomerIds: ['c1'], businessHours: { enabled: false, start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5, 6] }, debounceSeconds: 0, cooldownSeconds: 0 },
  customers: [{ id: 'c1', wechatId: 'wxid_c1', name: '合成客户', autoReplyEnabled: true }],
  products: [{ id: 'coffee', name: '咖啡', type: 'product', price: 18, description: '合成测试资料。', faq: [], enabled: true }], storeName: '合成门店', industry: '零售',
});
const incoming = () => ({ id: 'synthetic-question', chatId: 'wxid_c1', sender: 'customer', text: '咖啡多少钱？', date: new Date(timestamp).toISOString(), kind: 'text', source: 'realtime' });

async function fixture(t, options = {}) {
  const temporary = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporary, 'kexu-generation-failure-'));
  const engines = [];
  const create = async overrides => {
    const engine = await createReplyEngine({ directory, now: () => timestamp, tickMs: 10, ...options, ...overrides });
    engines.push(engine); return engine;
  };
  t.after(async () => {
    for (const engine of engines) await engine.close();
    const actual = await realpath(directory);
    // 仅清理本次创建并已核实属于系统临时目录的测试目录。
    assert.equal(path.dirname(actual).toLowerCase(), temporary.toLowerCase());
    assert.ok(path.basename(actual).startsWith('kexu-generation-failure-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { engine: await create(), create, directory };
}

async function until(engine, condition) {
  for (let count = 0; count < 600; count += 1) {
    const state = await engine.status();
    if (condition(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('合成生成任务未进入预期状态');
}

const cases = [
  ['AI_KEY_MISSING', 400], ['AI_AUTH_REJECTED', 502], ['AI_RATE_LIMITED', 429],
  ['AI_TIMEOUT', 504], ['AI_NETWORK_UNREACHABLE', 502], ['AI_RESPONSE_FORMAT', 502],
];

test('生成错误只按白名单分类，供应商错误正文和原因不会进入固定提示', () => {
  for (const code of Object.keys(GENERATION_FAILURES)) {
    const failure = normalizeGenerationFailure({ code, status: 502, message: RAW_SECRET, cause: { message: RAW_CHAT }, body: RAW_CHAT });
    assert.equal(failure.code, code); assert.equal(failure.reason, GENERATION_FAILURES[code]);
    assert.ok(!JSON.stringify(failure).includes(RAW_SECRET)); assert.ok(!JSON.stringify(failure).includes(RAW_CHAT));
    const thrown = new GenerationError(code, 502); thrown.message = RAW_SECRET; thrown.cause = { message: RAW_CHAT };
    assert.equal(normalizeGenerationFailure(thrown).reason, GENERATION_FAILURES[code]);
  }
  for (const error of [undefined, null, RAW_SECRET, new Error(RAW_SECRET), { code: RAW_SECRET, message: RAW_CHAT }, { code: 'toString' }, { code: '__proto__' }]) {
    const failure = normalizeGenerationFailure(error); assert.equal(failure.code, 'AI_UNKNOWN'); assert.equal(failure.reason, GENERATION_FAILURES.AI_UNKNOWN);
    assert.ok(!JSON.stringify(failure).includes(RAW_SECRET)); assert.ok(!JSON.stringify(failure).includes(RAW_CHAT));
  }
});

test('缺密钥认证限额超时网络格式及未知失败均保留安全原因，不发送不重试且重启保留', async t => {
  for (const [code, status] of [...cases, ['AI_UNKNOWN', 502]]) await t.test(code, async child => {
    let generations = 0; let sends = 0;
    const f = await fixture(child, {
      generate: async () => {
        generations++;
        if (code === 'AI_UNKNOWN') throw Object.assign(new Error(`${RAW_SECRET}: ${RAW_CHAT}`), { code: 'MALICIOUS_PROVIDER_CODE', status, body: RAW_SECRET });
        const error = new GenerationError(code, status); error.message = `${RAW_SECRET}: ${RAW_CHAT}`; error.cause = { message: RAW_CHAT };
        throw error;
      },
      send: async () => { sends++; assert.fail('生成失败不得调用发送组件'); },
    });
    await f.engine.syncConfig(configuration()); await f.engine.start(); await f.engine.ingest(incoming());
    const failed = await until(f.engine, state => state.counts.failed === 1);
    assert.equal(failed.jobs[0].failureCode, code); assert.equal(failed.jobs[0].reason, GENERATION_FAILURES[code]);
    assert.equal(failed.jobs[0].status, 'failed'); assert.equal(sends, 0);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(generations, 1); assert.equal(sends, 0);
    const saved = await readFile(path.join(f.directory, 'queue.json'), 'utf8');
    assert.ok(!saved.includes(RAW_SECRET)); assert.ok(!saved.includes(RAW_CHAT));
    assert.equal(JSON.parse(saved).jobs[0].failureCode, code);
    await f.engine.close();
    const reopened = await f.create(); const restored = await reopened.status();
    assert.equal(restored.running, false); assert.equal(restored.jobs[0].failureCode, code); assert.equal(restored.jobs[0].reason, GENERATION_FAILURES[code]);
    assert.equal(generations, 1); assert.equal(sends, 0);
  });
});

test('旧队列没有错误码仍能读取，不凭旧通用提示推断密钥或网络故障', async t => {
  const f = await fixture(t);
  const config = configuration(); config.settings.mode = 'review';
  await f.engine.syncConfig(config); await f.engine.start(); await f.engine.ingest(incoming());
  const work = (await f.engine.claimWork()).jobs[0];
  await f.engine.completeWork({ jobId: work.id, leaseId: work.leaseId, error: '旧版未记录具体生成原因。' });
  await f.engine.close();
  const filename = path.join(f.directory, 'queue.json'); const saved = JSON.parse(await readFile(filename, 'utf8'));
  delete saved.jobs[0].failureCode; saved.jobs[0].reason = '旧版未记录具体生成原因。';
  await writeFile(filename, JSON.stringify(saved), 'utf8');
  const reopened = await f.create(); const restored = await reopened.status();
  assert.equal(restored.jobs[0].status, 'failed'); assert.equal(restored.jobs[0].failureCode, undefined); assert.equal(restored.jobs[0].reason, '旧版未记录具体生成原因。');
});

test('生成中人工接管后迟到错误不覆盖会话保护或生成新的失败任务', async t => {
  let rejectGeneration; let sends = 0;
  const f = await fixture(t, {
    generate: () => new Promise((resolve, reject) => { rejectGeneration = reject; }),
    send: async () => { sends++; assert.fail('已接管会话不得发送'); },
  });
  await f.engine.syncConfig(configuration()); await f.engine.start(); await f.engine.ingest(incoming());
  await until(f.engine, state => state.counts.generating === 1 && typeof rejectGeneration === 'function');
  await f.engine.takeover({ customerId: 'c1', enabled: true });
  rejectGeneration(new GenerationError('AI_TIMEOUT', 504));
  await new Promise(resolve => setTimeout(resolve, 40));
  const state = await f.engine.status();
  assert.equal(state.counts.failed, 0); assert.equal(state.jobs[0].status, 'handoff'); assert.equal(state.jobs[0].failureCode, undefined);
  assert.match(state.jobs[0].reason, /商户已接管/); assert.deepEqual(state.takeovers, ['c1']); assert.equal(sends, 0);
});


test('暂停期间生成失败可记录固定原因，但不能重新启动或发送', async t => {
  let rejectGeneration; let sends = 0;
  const f = await fixture(t, { generate: () => new Promise((resolve, reject) => { rejectGeneration = reject; }), send: async () => { sends++; assert.fail('暂停后不得发送'); } });
  await f.engine.syncConfig(configuration()); await f.engine.start(); await f.engine.ingest(incoming());
  await until(f.engine, state => state.counts.generating === 1 && typeof rejectGeneration === 'function');
  await f.engine.pause(); rejectGeneration(new GenerationError('AI_NETWORK_UNREACHABLE', 502));
  const state = await until(f.engine, current => current.counts.failed === 1);
  assert.equal(state.running, false); assert.equal(state.jobs[0].failureCode, 'AI_NETWORK_UNREACHABLE'); assert.equal(sends, 0);
});

test('新消息使旧租约失效时迟到生成错误不能覆盖新批次', async t => {
  let rejectOld; let generations = 0; let sends = 0;
  const f = await fixture(t, {
    generate: async () => {
      generations++;
      if (generations === 1) return new Promise((resolve, reject) => { rejectOld = reject; });
      return { action: 'ignore', reply: '', reason: '合成后续问题独立处理，无需发送。', productIds: [] };
    },
    send: async () => { sends++; assert.fail('租约测试不能发送'); },
  });
  await f.engine.syncConfig(configuration()); await f.engine.start(); await f.engine.ingest(incoming());
  await until(f.engine, state => state.counts.generating === 1 && typeof rejectOld === 'function');
  await f.engine.ingest({ ...incoming(), id: 'synthetic-next-question', text: '还有其他商品吗？', date: new Date(timestamp + 1000).toISOString() });
  rejectOld(new GenerationError('AI_TIMEOUT', 504));
  const state = await until(f.engine, current => current.counts.ignored === 1);
  assert.equal(state.counts.failed, 0); assert.equal(generations, 2); assert.equal(sends, 0);
  assert.ok(state.jobs.every(job => job.failureCode === undefined));
});
