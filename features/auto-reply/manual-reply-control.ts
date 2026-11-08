import type { ReplyJobView } from '../../lib/types.ts';

export type ManualAttempt = { sourceJobId: string; requestId: string; text: string; jobId?: string; status: 'submitted' | 'restoring' | 'sent' | 'failed' | 'unknown' };
export type ManualReplyRecord = { attempt: ManualAttempt | null; blockedTexts: string[] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function manualReplyError(text: string): string | null {
  if (!text.trim()) return '请先输入要发送的回复。';
  if (text.length > 300 || new TextEncoder().encode(text).length > 1023 || text.includes('\0') || Array.from(text).some(character => character.length === 1 && /[\uD800-\uDFFF]/.test(character))) return '回复最多300字，不能包含无效字符。';
  return null;
}

export function parseManualReplyRecord(raw: string | null, sourceJobId: string): ManualReplyRecord {
  const empty = { attempt: null, blockedTexts: [] };
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw);
    const attempt = value?.attempt;
    if (!Array.isArray(value?.blockedTexts) || value.blockedTexts.length > 20 || value.blockedTexts.some((text: unknown) => typeof text !== 'string' || manualReplyError(text))) return empty;
    if (attempt && (attempt.sourceJobId !== sourceJobId || !uuid.test(attempt.requestId) || typeof attempt.text !== 'string' || manualReplyError(attempt.text) || !['submitted', 'restoring', 'sent', 'failed', 'unknown'].includes(attempt.status) || attempt.jobId !== undefined && !uuid.test(attempt.jobId))) return empty;
    return { attempt: attempt || null, blockedTexts: value.blockedTexts };
  } catch { return empty; }
}

// 已提交的正文和请求标识必须一同复用；结果未明时不能借修改正文发起另一条请求。
export function prepareManualAttempt(sourceJobId: string, text: string, previous: ManualAttempt | null, blockedTexts: string[], makeId: () => string): ManualAttempt {
  const trimmed = text.trim();
  const error = manualReplyError(trimmed);
  if (error) throw new Error(error);
  if (previous && previous.status !== 'sent' && previous.status !== 'failed') {
    if (previous.sourceJobId !== sourceJobId || previous.text !== trimmed) throw new Error('上一条发送结果未确认，请先检查原请求。');
    return previous;
  }
  if (blockedTexts.includes(trimmed)) throw new Error('这段正文上次发送结果未知，请核对原记录；不会重复发送。');
  return { sourceJobId, requestId: makeId(), text: trimmed, status: 'submitted' };
}

export function assertManualReceipt(job: ReplyJobView, source: ReplyJobView, attempt: ManualAttempt): void {
  if (!job || !uuid.test(job.id) || job.kind !== 'manual' || job.sourceJobId !== source.id || job.customerId !== source.customerId || job.chatId !== source.chatId || job.reply !== attempt.text || job.requestId !== attempt.requestId || attempt.jobId && job.id !== attempt.jobId || job.status === 'sent' && !job.sendMessageId?.trim()) throw new Error('手动回复回执不匹配，请核对本机发送记录。');
}

export const manualAutoResumeConfirmed = (job: ReplyJobView) => job.kind === 'manual' && job.status === 'sent' && !!job.sendMessageId?.trim() && job.autoResumeStatus === 'restored';

// 源卡片只在后端完成恢复，并且可找到对应发送凭证时移出待处理列表。
export function replyJobResolved(job: ReplyJobView, jobs: ReplyJobView[]): boolean {
  return job.kind !== 'manual' && !!job.resolvedAt && Number.isFinite(Date.parse(job.resolvedAt)) && uuid.test(job.resolvedByManualJobId || '') && jobs.some(manual => manual.id === job.resolvedByManualJobId && manual.sourceJobId === job.id && manual.customerId === job.customerId && manual.chatId === job.chatId && manualAutoResumeConfirmed(manual));
}

export const replyQueueJobs = (jobs: ReplyJobView[]) => jobs.filter(job => job.kind !== 'manual' && ['draft', 'handoff', 'unknown', 'failed', 'queued', 'generating', 'ready', 'sending'].includes(job.status) && !replyJobResolved(job, jobs));

// 微信发送已核实时仍需等待托管恢复结果；只查询同一请求，不再提交正文。
export const manualReplyTerminal = (job: ReplyJobView) => job.status === 'sent' ? job.autoResumeStatus !== 'pending' : ['failed', 'unknown', 'handoff', 'cancelled', 'ignored'].includes(job.status);

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason || new DOMException('查询已停止', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1500);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}

// 轮询只读取同一个任务，不提交发送；达到次数或时间上限后仍保留未确认状态。
export async function observeManualReply(source: ReplyJobView, attempt: ManualAttempt, load: (id: string, signal: AbortSignal) => Promise<ReplyJobView>, signal: AbortSignal, { maxAttempts = 40, wait = waitForPoll, now = Date.now } = {}): Promise<ReplyJobView | null> {
  if (!attempt.jobId) throw new Error('尚未取得发送任务编号，请先检查本次提交。');
  let latest: ReplyJobView | null = null;
  const deadline = now() + 120_000;
  for (let count = 0; count < maxAttempts && now() <= deadline; count++) {
    if (signal.aborted) throw signal.reason || new DOMException('查询已停止', 'AbortError');
    latest = await load(attempt.jobId, signal);
    assertManualReceipt(latest, source, attempt);
    if (manualReplyTerminal(latest)) return latest;
    if (count + 1 < maxAttempts && now() < deadline) await wait(signal);
  }
  return latest;
}
