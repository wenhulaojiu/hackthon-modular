import type { ReplyJobView } from '../../lib/types.ts';

export const followupTerminal = (job: ReplyJobView) => ['sent', 'failed', 'unknown', 'handoff', 'ignored', 'cancelled', 'draft'].includes(job.status);

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason || new DOMException('查询已停止', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1500);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}

// 仅查询本次提交的任务，达到次数或时间上限后由用户主动再检查，不再次提交发送。
export async function observeFollowup(jobId: string, load: (id: string, signal: AbortSignal) => Promise<ReplyJobView>, signal: AbortSignal, { maxAttempts = 40, wait = waitForPoll } = {}): Promise<ReplyJobView | null> {
  let latest: ReplyJobView | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal.aborted) throw signal.reason || new DOMException('查询已停止', 'AbortError');
    latest = await load(jobId, signal);
    if (latest.id !== jobId || latest.kind !== 'followup') throw new Error('跟进任务回执不匹配，请核对本机发送记录。');
    if (followupTerminal(latest)) return latest;
    if (attempt + 1 < maxAttempts) await wait(signal);
  }
  return latest;
}
