import type { AppState, ReplyJobView, Task } from './types.ts';
import { isReplyPrivateContact } from './reply-enrollment.ts';

export function followupBlockReason(state: AppState, task: Task | undefined): string {
  if (!task) return '该跟进任务已不存在，请刷新后重试。';
  if (task.status === 'done') return '该跟进已完成，请新建任务安排下一次联系。';
  const customer = state.customers.find(item => item.id === task.customerId);
  if (!customer) return '跟进客户已不存在，请重新选择。';
  if (customer.source === 'demo') return '演示客户不会发送微信消息。';
  if (!isReplyPrivateContact(customer.wechatId) || state.customers.filter(item => item.wechatId === customer.wechatId).length !== 1) return '客户缺少唯一、有效的好友私聊标识。';
  const settings = state.replySettings;
  if (!settings?.enabled) return '请先在自动回复页开启并保存回复总开关。';
  if (!settings.selectedCustomerIds.includes(customer.id) || customer.autoReplyEnabled !== true) return '该客户尚未加入已启用的回复范围，请先在客户档案中设置。';
  if (customer.humanTakeover) return '该客户正在人工接管，不能由程序发送。';
  if (!task.script.trim()) return '请先生成或编辑话术并保存，再一键跟进。';
  if (task.script.length > 300 || new TextEncoder().encode(task.script).length > 1023 || !task.script.isWellFormed() || task.script.includes('\0')) return '跟进话术需为300字以内的有效文本，请编辑后保存。';
  return '';
}

export function prepareSavedFollowup(state: AppState, taskId: string) {
  const task = state.tasks.find(item => item.id === taskId);
  const reason = followupBlockReason(state, task);
  if (reason) throw new Error(reason);
  return { taskId: task!.id, customerId: task!.customerId, text: task!.script };
}

export function applyFollowupReceipt(state: AppState, taskId: string, job: ReplyJobView): AppState {
  const task = state.tasks.find(item => item.id === taskId);
  if (!task || job.kind !== 'followup' || job.taskId !== taskId || job.customerId !== task.customerId || job.status !== 'sent' || !job.sendMessageId) throw new Error('尚未取得本条跟进的已核实发送凭据，未标记完成。');
  if (job.reply !== task.script) throw new Error('发送已核实，但任务话术已变化，请人工核对完成状态。');
  if (task.status === 'done') return state;
  const tasks = state.tasks.map(item => item.id === taskId ? { ...item, status: 'done' as const } : item);
  const nextDate = tasks.filter(item => item.customerId === task.customerId && item.status === 'todo').map(item => item.date).sort()[0] || '';
  return { ...state, tasks, customers: state.customers.map(item => item.id === task.customerId ? { ...item, nextFollowUpAt: nextDate } : item) };
}
