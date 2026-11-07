import assert from 'node:assert/strict';
import test from 'node:test';
import { assertImportBatchAvailable, createImportQueue, drainImportQueue, importQueueView, pendingImportIds, selectImportResults, type LocalImportJob, type LocalImportQueue } from '../app/components/local-import-queue.ts';

type QueueIO = Parameters<typeof drainImportQueue>[1];
const ids = (count: number) => Array.from({ length: count }, (_, index) => `synthetic_${index + 1}`);

function harness(queue: LocalImportQueue) {
  const created: string[][] = [];
  const saved: string[][] = [];
  const pending: string[][] = [];
  const jobs = new Map<string, string[]>();
  const io: QueueIO = {
    assertActive: () => {},
    createExport: async selection => { created.push([...selection]); const id = `job-${created.length}`; jobs.set(id, [...selection]); return id; },
    readJob: async id => ({ status: 'complete', exports: jobs.get(id)!.map(chatId => ({ chatId, messages: [{ text: '合成消息' }] })) }),
    importExports: async exports => { saved.push(exports.map(value => (value as { chatId: string }).chatId)); return true; },
    wait: async () => {},
    update: () => {},
    completed: () => { pending.push(pendingImportIds(queue)); },
  };
  return { io, created, saved, pending };
}

test('全选超过20位当前结果，保留筛选外选择并去重', () => {
  const visible = ids(45);
  const selected = selectImportResults(['outside', visible[0]], visible, true);
  assert.deepEqual(selected, ['outside', ...visible]);
  assert.equal(selected.length, 46);
  assert.deepEqual(selectImportResults(selected, visible, false), ['outside']);
  assert.deepEqual(selectImportResults(['outside'], [], true), ['outside']);
});

test('45位按20、20、5串行提取，上一批持久化完成前不创建下一批', async () => {
  const queue = createImportQueue(ids(45), '2026-11-01', '2026-11-07');
  const run = harness(queue);
  let release!: () => void;
  const save = run.io.importExports;
  let first = true;
  run.io.importExports = async exports => {
    if (first) { first = false; await new Promise<void>(resolve => { release = resolve; }); }
    return save(exports);
  };
  const pending = drainImportQueue(queue, run.io);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(run.created.length, 1);
  assert.equal(queue.completedPeople, 0);
  release(); await pending;
  assert.deepEqual(run.created.map(batch => batch.length), [20, 20, 5]);
  assert.deepEqual(run.saved.flat(), ids(45));
  assert.deepEqual(run.pending.map(batch => batch.length), [25, 5, 0]);
  assert.equal(importQueueView(queue).completedPeople, 45);
  assert.equal(queue.messages, 45);
});

test('保存失败停止后续批次，继续时复用本批任务且不重做已完成批次', async () => {
  const queue = createImportQueue(ids(45), '2026-11-01', '2026-11-07');
  const run = harness(queue);
  const save = run.io.importExports;
  let fail = true;
  run.io.importExports = async exports => {
    if (queue.index === 1 && fail) { fail = false; return false; }
    return save(exports);
  };
  await assert.rejects(drainImportQueue(queue, run.io), /未能保存/);
  assert.equal(queue.completedPeople, 20);
  assert.equal(queue.jobId, 'job-2');
  assert.equal(run.created.length, 2);
  assert.deepEqual(pendingImportIds(queue), ids(45).slice(20));
  await drainImportQueue(queue, run.io);
  assert.equal(run.created.length, 3);
  assert.deepEqual(run.saved.flat(), ids(45));
});

test('查询断线保留任务编号，恢复时不重复提交导出', async () => {
  const queue = createImportQueue(ids(25), '2026-11-01', '2026-11-07');
  const run = harness(queue);
  const read = run.io.readJob;
  let fail = true;
  run.io.readJob = async id => { if (id === 'job-2' && fail) { fail = false; throw new Error('合成网络中断'); } return read(id); };
  await assert.rejects(drainImportQueue(queue, run.io), /网络中断/);
  assert.equal(queue.jobId, 'job-2');
  await drainImportQueue(queue, run.io);
  assert.equal(run.created.length, 2);
  assert.deepEqual(run.saved.flat(), ids(25));
});

test('404和410任务失效只重建未保存批次，不重做前面已导入联系人', async () => {
  for (const status of [404, 410]) {
    const queue = createImportQueue(ids(25), '2026-11-01', '2026-11-07');
    const run = harness(queue); const read = run.io.readJob;
    let expired = true;
    run.io.readJob = async id => { if (id === 'job-2' && expired) { expired = false; throw Object.assign(new Error('合成任务已过期'), { status }); } return read(id); };
    await assert.rejects(drainImportQueue(queue, run.io), /任务已过期/);
    assert.equal(queue.jobId, null); assert.equal(queue.completedPeople, 20);
    assert.deepEqual(pendingImportIds(queue), ids(25).slice(20));
    await drainImportQueue(queue, run.io);
    assert.deepEqual(run.created.map(batch => batch.length), [20, 5, 5]);
    assert.deepEqual(run.saved.flat(), ids(25));
  }
});

test('每批重新取得目录后核对全部私聊，失效或类型改变不能提交下一批', async () => {
  assert.doesNotThrow(() => assertImportBatchAvailable(['one', 'two'], [{ id: 'two', type: 'private' }, { id: 'one', type: 'private' }]));
  for (const chats of [undefined, [], [{ id: 'one', type: 'private' }, { id: 'two', type: 'group' }]]) assert.throws(() => assertImportBatchAvailable(['one', 'two'], chats), /核验|目录/);
  assert.throws(() => assertImportBatchAvailable(['filehelper'], [{ id: 'filehelper', type: 'private' }]), /目录/);
});

test('服务确认失败后只重新提交失败批次，已保存选择仍被移除', async () => {
  const queue = createImportQueue(ids(25), '2026-11-01', '2026-11-07');
  const run = harness(queue);
  const read = run.io.readJob;
  let fail = true;
  run.io.readJob = async id => id === 'job-2' && fail ? { status: 'failed', error: '合成范围错误' } : read(id);
  await assert.rejects(drainImportQueue(queue, run.io), /范围错误/);
  assert.equal(queue.jobId, null);
  assert.deepEqual(pendingImportIds(queue), ids(25).slice(20));
  fail = false; await drainImportQueue(queue, run.io);
  assert.deepEqual(run.created.map(batch => batch.length), [20, 5, 5]);
  assert.deepEqual(run.saved.flat(), ids(25));
});

test('没有消息的批次直接完成检查，不伪造导入记录', async () => {
  const queue = createImportQueue(ids(21), '2026-11-01', '2026-11-07');
  const run = harness(queue);
  run.io.readJob = async (): Promise<LocalImportJob> => ({ status: 'complete', exports: [{ messages: [] }] });
  await drainImportQueue(queue, run.io);
  assert.equal(queue.completedPeople, 21);
  assert.equal(queue.files, 0);
  assert.equal(queue.messages, 0);
  assert.equal(run.saved.length, 0);
});

test('工作区失效时停止后续读取和导入，已确认保存的批次仍记为完成', async () => {
  const queue = createImportQueue(ids(45), '2026-11-01', '2026-11-07');
  const run = harness(queue);
  const save = run.io.importExports;
  let active = true;
  run.io.assertActive = () => { if (!active) throw new Error('工作区已失效'); };
  run.io.importExports = async exports => { const result = await save(exports); active = false; return result; };
  await assert.rejects(drainImportQueue(queue, run.io), /工作区已失效/);
  assert.equal(run.created.length, 1);
  assert.equal(queue.completedPeople, 20);
  assert.deepEqual(pendingImportIds(queue), ids(45).slice(20));
});

test('等待中的任务先查询至完成，再保存并推进下一批', async () => {
  const queue = createImportQueue(ids(21), '2026-11-01', '2026-11-07');
  const run = harness(queue);
  const read = run.io.readJob;
  let waiting = true;
  let waits = 0;
  run.io.readJob = async id => { if (waiting) { waiting = false; return { status: 'running' }; } return read(id); };
  run.io.wait = async () => { waits += 1; assert.equal(run.created.length, 1); assert.equal(run.saved.length, 0); };
  await drainImportQueue(queue, run.io);
  assert.equal(waits, 1);
  assert.deepEqual(run.saved.flat(), ids(21));
});
