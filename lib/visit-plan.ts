import type { AppState, Task } from './types';

export const REVISIT_TITLE = '定期回访：了解宝宝近况';
export const DEFAULT_REVISIT_SCRIPT = '您好，想跟您了解一下宝宝最近的情况：吃睡和状态还好吗？有没有觉得和之前不一样的地方？如果医生有新的补充建议，也方便跟我说一声，我帮您记到档案里。这次不做产品推荐，您有需要随时找我。';
export const REVISIT_LIMITS = { minIntervalDays: 7, maxIntervalDays: 365, maxTimes: 12, maxScriptChars: 300, maxScriptBytes: 1023 };
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export function revisitScript(template?: string): string {
  const value = (template ?? '').trim();
  return value || DEFAULT_REVISIT_SCRIPT;
}

function shiftDate(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return '';
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export type RevisitOptions = {
  customerIds: string[];
  startDate: string;
  intervalDays: number;
  times: number;
  script?: string;
  makeId?: () => string;
};

export type RevisitResult = {
  state: AppState;
  created: Task[];
  skipped: Array<{ customerId: string; reason: string }>;
  error?: string;
};

/** 只创建待办和可编辑话术，不发送微信、不启用自动接待、不生成医疗判断。 */
export function createRevisitTasks(state: AppState, options: RevisitOptions): RevisitResult {
  const { minIntervalDays, maxIntervalDays, maxTimes, maxScriptChars, maxScriptBytes } = REVISIT_LIMITS;
  const script = revisitScript(options.script);
  const empty = (error?: string): RevisitResult => ({ state, created: [], skipped: [], error });
  if (!DATE.test(options.startDate) || Number.isNaN(new Date(`${options.startDate}T00:00:00Z`).getTime())) return empty('开始日期需为有效的 YYYY-MM-DD 日期');
  if (!Number.isInteger(options.intervalDays) || options.intervalDays < minIntervalDays || options.intervalDays > maxIntervalDays) return empty(`回访间隔需为 ${minIntervalDays} 至 ${maxIntervalDays} 天的整数`);
  if (!Number.isInteger(options.times) || options.times < 1 || options.times > maxTimes) return empty(`回访次数需为 1 至 ${maxTimes} 次`);
  if (!script.trim() || script.length > maxScriptChars || new TextEncoder().encode(script).length > maxScriptBytes || !script.isWellFormed() || script.includes('\0')) return empty(`回访话术需为 ${maxScriptChars} 字以内的有效文本`);
  // 先剔除「不做诊断」「不提供用药建议」等否定式边界声明，再拦截肯定式的售后承诺与医疗判断。
  const normalized = script.replace(/不(?:提供|做|进行|给)?(?:医疗)?诊断[^，。；!！?？]*/gu, '').replace(/不(?:提供|做|给)(?:用药|剂量)[^，。；!！?？]*/gu, '');
  if (/退款|保证有效|一定有效|百分之百|100%|诊断|用药|剂量/u.test(normalized)) return empty('回访话术不得包含售后承诺、效果保证或医疗判断');

  const makeId = options.makeId ?? (() => globalThis.crypto.randomUUID());
  const created: Task[] = [];
  const skipped: Array<{ customerId: string; reason: string }> = [];
  const customers = [...new Set(options.customerIds)];
  for (const customerId of customers) {
    const customer = state.customers.find(item => item.id === customerId);
    if (!customer) { skipped.push({ customerId, reason: '客户不存在' }); continue; }
    if (customer.source === 'demo') { skipped.push({ customerId, reason: '演示客户不安排回访' }); continue; }
    for (let index = 0; index < options.times; index += 1) {
      const date = shiftDate(options.startDate, index * options.intervalDays);
      if (!date) { skipped.push({ customerId, reason: '回访日期无效' }); break; }
      created.push({ id: makeId(), customerId, title: `${REVISIT_TITLE}（第 ${index + 1} 次）`, date, kind: 'reminder', status: 'todo', priority: 'normal', script });
    }
  }
  if (!created.length) return { state, created, skipped, error: '没有可安排的回访客户' };
  const nextState: AppState = {
    ...state,
    tasks: [...created, ...state.tasks],
    customers: state.customers.map(customer => {
      const earliest = created.filter(task => task.customerId === customer.id).map(task => task.date).sort()[0];
      if (!earliest) return customer;
      return { ...customer, nextFollowUpAt: !customer.nextFollowUpAt || earliest < customer.nextFollowUpAt ? earliest : customer.nextFollowUpAt };
    }),
  };
  return { state: nextState, created, skipped };
}
