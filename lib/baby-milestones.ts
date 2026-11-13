import type { AppState, BabyProfile, Task } from './types';
import { today } from './domain.ts';

export type BabyMilestone = { id: string; minMonths: number; maxMonths: number; title: string; script: string };

const OPENING = '您好，想跟您了解一下宝宝最近的情况：吃睡和状态还好吗？有没有觉得和之前不一样的地方？';
const BOUNDARY = '医生如果有新的补充建议，也方便跟我说一声，我帮您记到档案里。这次不做产品推荐，也不提供医疗判断；月龄、段位、转奶和辅食安排请按包装说明与儿科医生建议核对。';

/** 只按宝宝月龄提醒可核对的事项，不推荐商品、不承诺功效、不替代儿保医生。 */
export const BABY_MILESTONES: BabyMilestone[] = [
  { id: 'newborn-1m', minMonths: 0, maxMonths: 1, title: '新生儿喂养与儿保时间核对', script: `${OPENING}这阶段想跟您核对一下喂养方式、吃奶量和儿保预约时间。${BOUNDARY}` },
  { id: 'checkup-2m', minMonths: 2, maxMonths: 3, title: '2月龄儿保与疫苗时间核对', script: `${OPENING}这阶段可以核对一下儿保和疫苗的时间安排。${BOUNDARY}` },
  { id: 'motor-4m', minMonths: 4, maxMonths: 5, title: '4月龄喂养与日常发育观察', script: `${OPENING}这阶段想了解一下吃奶规律和日常状态，有变化随时告诉我。${BOUNDARY}` },
  { id: 'stage2-6m', minMonths: 6, maxMonths: 7, title: '6月龄：辅食添加与2段奶粉换段核对', script: `${OPENING}宝宝快到或刚到6个月，常见要核对的是辅食添加节奏和配方奶粉是否该从1段换到2段；具体换段时间、喂哺量和辅食种类请按包装说明与儿科医生建议核对。${BOUNDARY}` },
  { id: 'teeth-8m', minMonths: 8, maxMonths: 9, title: '8月龄辅食进阶与日常照护', script: `${OPENING}这阶段可以聊聊辅食种类、出牙期的日常照护和吃睡变化。${BOUNDARY}` },
  { id: 'stage3-12m', minMonths: 12, maxMonths: 14, title: '1岁：3段奶粉与儿保核对', script: `${OPENING}宝宝一岁左右，常见要核对的是配方奶粉段位、日常饮食安排和儿保时间。${BOUNDARY}` },
  { id: 'weaning-18m', minMonths: 18, maxMonths: 20, title: '18月龄饮食多样化与作息', script: `${OPENING}这阶段想了解一下一日饮食、喝奶量和作息情况。${BOUNDARY}` },
  { id: 'checkup-24m', minMonths: 24, maxMonths: 26, title: '2岁儿保与日常照护核对', script: `${OPENING}两岁前后可以核对一下儿保时间、饮食与作息安排。${BOUNDARY}` },
];

export const BABY_FORMULA_STAGES: Array<BabyProfile['formulaStage']> = ['', '1段', '2段', '3段', '4段'];
export const BABY_FEEDING_LABELS: Record<NonNullable<BabyProfile['feeding']>, string> = { '': '未填写', breast: '母乳', mixed: '混合喂养', formula: '配方奶' };

/** 优先按出生日期算月龄；没填日期时回退到手工登记的月龄。 */
export function babyAgeMonths(baby: BabyProfile | undefined, todayDate: string): number | null {
  if (!baby) return null;
  const birth = baby.birthDate ?? '';
  if (/^\d{4}-\d{2}-\d{2}$/u.test(birth)) {
    const born = new Date(`${birth}T00:00:00Z`);
    const now = new Date(`${todayDate}T00:00:00Z`);
    if (Number.isNaN(born.getTime()) || Number.isNaN(now.getTime()) || born > now) return null;
    let months = (now.getUTCFullYear() - born.getUTCFullYear()) * 12 + now.getUTCMonth() - born.getUTCMonth();
    if (now.getUTCDate() < born.getUTCDate()) months -= 1;
    return Math.max(0, Math.min(72, months));
  }
  const value = baby.ageMonths;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 72 ? value : null;
}

export function milestonesForAge(months: number): BabyMilestone[] {
  return BABY_MILESTONES.filter(item => months >= item.minMonths && months <= item.maxMonths);
}

/** 仅给出「可核对」的段位提示，不作为换段结论。 */
export function stageHintForMonths(months: number): string {
  if (months < 6) return '1段阶段（按包装说明核对）';
  if (months < 12) return '6月龄左右可核对2段换段';
  if (months < 24) return '1岁后可核对3段';
  return '2岁以上按实际饮食与医生建议核对';
}

export function babyProfileLabel(baby: BabyProfile | undefined, todayDate: string): string {
  const months = babyAgeMonths(baby, todayDate);
  if (months === null) return '未登记宝宝档案';
  const parts = [`${baby?.gender || '宝宝'} ${months} 个月`];
  if (baby?.formulaStage) parts.push(baby.formulaStage);
  if (baby?.allergies?.trim()) parts.push('有过敏/注意事项');
  return parts.join(' · ');
}

export type BabyFollowupOptions = { todayDate?: string; makeId?: () => string; includeDemo?: boolean };
export type BabyFollowupResult = {
  state: AppState; created: Task[];
  skipped: Array<{ customerId: string; reason: string }>;
  missingProfile: string[];
};

/** 为已登记宝宝档案的客户自动补齐当前月龄的跟进待办；同一里程碑不重复生成，只建待办不发送消息。 */
export function ensureBabyFollowups(state: AppState, options: BabyFollowupOptions = {}): BabyFollowupResult {
  const date = options.todayDate ?? today();
  const makeId = options.makeId ?? (() => globalThis.crypto.randomUUID());
  const created: Task[] = [];
  const skipped: Array<{ customerId: string; reason: string }> = [];
  const missingProfile: string[] = [];
  const seen = new Set(state.tasks.filter(task => task.babyMilestoneId).map(task => `${task.customerId}|${task.babyMilestoneId}`));
  for (const customer of state.customers) {
    if (customer.source === 'demo' && options.includeDemo === false) { skipped.push({ customerId: customer.id, reason: '演示客户已排除' }); continue; }
    const months = babyAgeMonths(customer.baby, date);
    if (months === null) { missingProfile.push(customer.id); continue; }
    for (const milestone of milestonesForAge(months)) {
      const key = `${customer.id}|${milestone.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      created.push({
        id: makeId(), customerId: customer.id, title: `宝宝里程碑：${milestone.title}`, date,
        kind: 'followup', status: 'todo', priority: 'normal', script: milestone.script, babyMilestoneId: milestone.id,
      });
    }
  }
  if (!created.length) return { state, created, skipped, missingProfile };
  const touched = new Set(created.map(task => task.customerId));
  const nextState: AppState = {
    ...state,
    tasks: [...created, ...state.tasks],
    customers: state.customers.map(customer => touched.has(customer.id)
      ? { ...customer, nextFollowUpAt: !customer.nextFollowUpAt || date < customer.nextFollowUpAt ? date : customer.nextFollowUpAt }
      : customer),
  };
  return { state: nextState, created, skipped, missingProfile };
}
