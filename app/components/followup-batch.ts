import { applyFollowupReceipt, followupBlockReason } from '../../lib/followup.ts';
import type { AppState, ReplyJobView, Task } from '../../lib/types.ts';

export type FollowupRuntime = { running: boolean; takeovers: string[]; jobs: ReplyJobView[]; submittedFollowups?: { taskId: string; jobId: string }[]; adapter?: { canSend?: boolean; message?: string } };
export type FollowupBatchItem = { taskId: string; customerId: string; chatId: string; customerName: string; title: string; text: string; textSha256: string };
export type FollowupBatchSkipped = { taskId: string; customerName: string; title: string; reason: string };
export type FollowupBatchPlan = { items: FollowupBatchItem[]; skipped: FollowupBatchSkipped[] };
export type FollowupBatchContext = { state: AppState; runtime: FollowupRuntime | null; local: boolean; locked: boolean; submittedTaskIds: ReadonlySet<string> };
export type FollowupBatchProgress = { total: number; submitted: number; sent: number; failed: number; unconfirmed: number; notSent: number; stopped: boolean; reason: string; currentTaskId?: string };

// 已提交任务只提供查询；未知或失败的回执也允许重新核对原任务，绝不变成重新发送。
export function followupButtonAction(task: Pick<Task, 'status'>, delivery?: { job?: Pick<ReplyJobView, 'status'> }) {
  if (delivery) return { mode: 'query' as const, label: delivery.job?.status === 'sent' ? task.status === 'done' ? '已核实发送' : '完成发送记录' : '检查此条结果', disabled: delivery.job?.status === 'sent' && task.status === 'done' };
  return { mode: 'send' as const, label: '一键跟进', disabled: false };
}

export async function followupTextSha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

export function batchFollowupBlockReason(context: FollowupBatchContext, task: Task | undefined): string {
  if (context.locked) return '微信工作区已切换，请刷新后核对。';
  if (!context.local) return '请在 Windows 本地版中发送。';
  if (task && (context.submittedTaskIds.has(task.id) || context.runtime?.submittedFollowups?.some(record => record.taskId === task.id) || context.runtime?.jobs.some(job => job.kind === 'followup' && job.taskId === task.id))) return '本任务已提交过发送，请检查原发送结果。';
  const reason = followupBlockReason(context.state, task);
  if (reason) return reason;
  if (!context.runtime?.running) return '本地回复未运行，请到自动回复页核对并启动。';
  if (!context.runtime.adapter?.canSend) return context.runtime.adapter?.message || '本地发送组件尚未就绪。';
  if (context.runtime.takeovers?.includes(task!.customerId)) return '该客户正在人工接管，不能自动发送。';
  return '';
}

// 只冻结当前列表及已保存正文；不生成话术，也不扩展客户范围。
export async function prepareFollowupBatch(context: FollowupBatchContext, visibleTasks: Task[]): Promise<FollowupBatchPlan> {
  const plan: FollowupBatchPlan = { items: [], skipped: [] };
  for (const task of visibleTasks) {
    const customer = context.state.customers.find(item => item.id === task.customerId);
    const customerName = customer?.name.replace(/\s*[（(]演示[）)]\s*$/u, '') || '客户已不存在';
    const reason = task.status !== 'todo' ? '该任务已完成。' : batchFollowupBlockReason(context, task);
    if (reason) { plan.skipped.push({ taskId: task.id, customerName, title: task.title, reason }); continue; }
    plan.items.push({ taskId: task.id, customerId: customer!.id, chatId: customer!.wechatId, customerName, title: task.title, text: task.script, textSha256: await followupTextSha256(task.script) });
  }
  return plan;
}

type BatchDependencies = {
  current: (signal: AbortSignal) => Promise<FollowupBatchContext>;
  assertCurrent: () => void;
  attempted: Set<string>;
  onAttempt: (item: FollowupBatchItem) => void;
  submit: (item: FollowupBatchItem, signal: AbortSignal) => Promise<{ jobId: string; job?: ReplyJobView }>;
  observe: (item: FollowupBatchItem, jobId: string, signal: AbortSignal) => Promise<ReplyJobView | null>;
  onDelivery: (item: FollowupBatchItem, jobId: string, job: ReplyJobView | null, note: string) => void;
  finish: (item: FollowupBatchItem, job: ReplyJobView) => Promise<void>;
  progress?: (value: FollowupBatchProgress) => void;
};

// 逐条提交、核实、完成；一条结果未知就停止，避免在恢复网络后追加发送。
export async function runFollowupBatch(plan: FollowupBatchPlan, dependencies: BatchDependencies, signal: AbortSignal, { itemTimeoutMs = 120_000 } = {}): Promise<FollowupBatchProgress> {
  const progress: FollowupBatchProgress = { total: plan.items.length, submitted: 0, sent: 0, failed: 0, unconfirmed: 0, notSent: plan.items.length, stopped: false, reason: '' };
  const emit = () => dependencies.progress?.({ ...progress });
  emit();
  for (const item of plan.items) {
    let submitted = false, jobId = '', latestJob: ReplyJobView | null = null;
    const itemSignal = AbortSignal.any([signal, AbortSignal.timeout(itemTimeoutMs)]);
    const assertActive = () => { if (itemSignal.aborted) throw itemSignal.reason || new Error('已停止本次批量发送。'); dependencies.assertCurrent(); };
    progress.currentTaskId = item.taskId;
    try {
      assertActive();
      const context = await dependencies.current(itemSignal);
      assertActive();
      const task = context.state.tasks.find(value => value.id === item.taskId);
      const customer = context.state.customers.find(value => value.id === item.customerId);
      const block = batchFollowupBlockReason(context, task);
      if (block) throw new Error(`${item.customerName}：${block}`);
      if (dependencies.attempted.has(item.taskId)) throw new Error(`${item.customerName}：本任务已提交过发送，请查询原记录。`);
      if (!task || task.customerId !== item.customerId || customer?.wechatId !== item.chatId || task.script !== item.text || await followupTextSha256(task.script) !== item.textSha256) throw new Error(`${item.customerName}：客户或已保存话术已变化，请重新预览。`);
      assertActive();
      // 在请求之前登记；即使请求断线未取得 jobId，也绝不自动重新提交。
      dependencies.attempted.add(item.taskId);
      submitted = true; progress.submitted++; progress.notSent--;
      dependencies.onAttempt(item); emit();
      const result = await dependencies.submit(item, itemSignal);
      jobId = result.jobId;
      if (!jobId) throw new Error('未取得发送任务编号，请核对原发送记录。');
      latestJob = result.job || null;
      dependencies.onDelivery(item, jobId, latestJob, '已提交，正在核实本条发送结果。');
      assertActive();
      latestJob = await dependencies.observe(item, jobId, itemSignal);
      assertActive();
      if (latestJob?.status !== 'sent') {
        const knownFailure = latestJob && ['failed', 'handoff', 'ignored', 'cancelled', 'draft'].includes(latestJob.status);
        if (knownFailure) progress.failed++; else progress.unconfirmed++;
        progress.reason = `${item.customerName}：${knownFailure ? latestJob?.reason || '发送未完成' : '发送结果尚未核实'}。已停止后续发送，请核对原记录，不会重发。`;
        progress.stopped = true;
        dependencies.onDelivery(item, jobId, latestJob, progress.reason);
        emit(); break;
      }
      if (latestJob.id !== jobId || latestJob.chatId !== item.chatId || latestJob.reply !== item.text) throw new Error('发送回执与预览客户或正文不一致，请人工核对。');
      // 只有完整 sent 凭据才允许完成任务，正文被其他窗口改动时也不会误完成。
      applyFollowupReceipt(context.state, item.taskId, latestJob);
      await dependencies.finish(item, latestJob);
      dependencies.onDelivery(item, jobId, latestJob, '已核实发送，跟进已完成。');
      progress.sent++;
      emit();
    } catch (error) {
      const message = error instanceof Error ? error.message : '本次发送已停止。';
      if (submitted) progress.unconfirmed++;
      progress.stopped = true;
      progress.reason = `${message}${submitted ? ' 本条结果请查询原记录；' : ' ' }后续任务未提交，不会自动重发。`;
      if (submitted) dependencies.onDelivery(item, jobId, latestJob, progress.reason);
      emit(); break;
    }
  }
  progress.currentTaskId = undefined;
  if (!progress.stopped) progress.reason = progress.total ? '本次可发送任务均已核实完成。' : '当前列表没有可发送任务。';
  emit();
  return { ...progress };
}
