export type LocalImportJob = { status?: string; progress?: unknown; message?: string; error?: string; exports?: unknown[]; messageCount?: number };
export type LocalImportQueue = { batches: string[][]; index: number; start: string; end: string; jobId: string | null; totalPeople: number; completedPeople: number; files: number; messages: number | null };
export type LocalImportView = { batch: number; batches: number; totalPeople: number; completedPeople: number; remainingPeople: number; hasPendingJob: boolean };
type QueueIO = {
  assertActive: () => void;
  createExport: (ids: string[], start: string, end: string) => Promise<string>;
  readJob: (id: string) => Promise<LocalImportJob>;
  importExports: (exports: unknown[]) => Promise<boolean> | boolean;
  wait: () => Promise<void>;
  update: (stage: 'starting' | 'running' | 'importing' | 'complete', job?: LocalImportJob) => void;
  completed: (ids: string[]) => void;
};

export function selectImportResults(selected: readonly string[], visible: readonly string[], select: boolean): string[] {
  const visibleSet = new Set(visible);
  return select ? [...new Set([...selected, ...visible])] : selected.filter(id => !visibleSet.has(id));
}

export function createImportQueue(ids: readonly string[], start: string, end: string): LocalImportQueue {
  const unique = [...new Set(ids)];
  const batches: string[][] = [];
  for (let index = 0; index < unique.length; index += 20) batches.push(unique.slice(index, index + 20));
  return { batches, index: 0, start, end, jobId: null, totalPeople: unique.length, completedPeople: 0, files: 0, messages: 0 };
}

export function assertImportBatchAvailable(ids: readonly string[], chats: unknown): void {
  if (!Array.isArray(chats)) throw new Error('本批会话目录未能重新核验，未提交提取任务。');
  const available = new Set(chats.filter(item => item && typeof item === 'object' && item.type === 'private' && typeof item.id === 'string' && item.id !== 'filehelper' && !item.id.includes('@chatroom')).map(item => item.id));
  if (ids.some(id => !available.has(id))) throw new Error('本批部分私聊已不在当前可核验目录中，未提交提取任务。请重新读取会话后继续。');
}

export const pendingImportIds = (queue: LocalImportQueue): string[] => queue.batches.slice(queue.index).flat();
export const importQueueView = (queue: LocalImportQueue): LocalImportView => ({ batch: Math.min(queue.index + 1, queue.batches.length), batches: queue.batches.length, totalPeople: queue.totalPeople, completedPeople: queue.completedPeople, remainingPeople: queue.totalPeople - queue.completedPeople, hasPendingJob: !!queue.jobId });

export function importMessageCount(exports: unknown[]): number | null {
  let total = 0;
  for (const item of exports) {
    if (!item || typeof item !== 'object') return null;
    const value = item as { messages?: unknown; data?: { messages?: unknown } };
    const messages = Array.isArray(value.messages) ? value.messages : Array.isArray(value.data?.messages) ? value.data.messages : null;
    if (!messages) return null;
    total += messages.length;
  }
  return total;
}

export async function drainImportQueue(queue: LocalImportQueue, io: QueueIO): Promise<void> {
  while (queue.index < queue.batches.length) {
    io.assertActive();
    const ids = queue.batches[queue.index];
    if (!queue.jobId) {
      io.update('starting');
      queue.jobId = await io.createExport(ids, queue.start, queue.end);
      io.assertActive();
    }
    io.update('running');
    let job: LocalImportJob;
    while (true) {
      io.assertActive();
      try { job = await io.readJob(queue.jobId); }
      catch (error) {
        const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
        if (status === 404 || status === 410) {
          queue.jobId = null;
          throw new Error('本批提取任务已过期。已保存批次保留，请继续提取余下联系人。');
        }
        throw error;
      }
      io.assertActive();
      io.update('running', job);
      if (job.status === 'complete') break;
      if (['failed', 'error', 'cancelled', 'canceled'].includes(job.status || '')) {
        queue.jobId = null;
        throw new Error(job.error || job.message || '本批提取未完成，已停止后续批次。');
      }
      if (!['queued', 'pending', 'running', 'extracting', 'processing'].includes(job.status || '')) throw new Error('本地任务状态无法识别，请继续检查原任务。');
      await io.wait();
    }
    if (!Array.isArray(job.exports)) throw new Error('提取结束，但本地组件没有返回导出数据，请继续检查原任务。');
    const count = importMessageCount(job.exports);
    const hasMessages = job.exports.length > 0 && count !== 0;
    if (hasMessages) {
      io.update('importing', job);
      io.assertActive();
      if (!await io.importExports(job.exports)) throw new Error('本批聊天已提取，但未能保存。已完成批次保留，请检查提示后继续剩余联系人。');
      queue.files += job.exports.length;
      queue.messages = queue.messages === null || count === null ? null : queue.messages + count;
    }
    // 只有本批保存成功或确认没有消息后才前进；失败时原任务仍可继续查询。
    queue.completedPeople += ids.length;
    queue.index += 1;
    queue.jobId = null;
    io.completed(ids);
    io.assertActive();
    io.update(queue.index === queue.batches.length ? 'complete' : 'starting');
  }
}
