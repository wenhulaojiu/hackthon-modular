import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BABY_MILESTONES, babyAgeMonths, babyProfileLabel, ensureBabyFollowups, milestonesForAge, stageHintForMonths } from '../lib/baby-milestones.ts';
import type { AppState, Customer } from '../lib/types.ts';

const customer = (patch: Partial<Customer> = {}): Customer => ({
  id: 'c1', name: '林女士', wechatId: '', color: '#123456', stage: '新客户', tags: [], manualTags: [],
  summary: '', preferences: '', budget: '', note: '', createdAt: '2026-11-01', lastContactAt: '', nextFollowUpAt: '',
  source: 'manual', evidence: [], messages: [], ...patch,
});
const state = (patch: Partial<AppState> = {}): AppState => ({
  schemaVersion: 1, customers: [], orders: [], tasks: [], imports: [], demo: false,
  settings: { storeName: '芽芽母婴生活馆', industry: '母婴用品与喂养咨询', followupDays: 7, ai: { baseUrl: '', model: '', temperature: 0, profilePrompt: '', marketingPrompt: '', extractionPrompt: '' } },
  ...patch,
});

test('月龄优先按出生日期计算，也可回退到手工登记', () => {
  assert.equal(babyAgeMonths({ birthDate: '2026-05-12' }, '2026-11-12'), 6);
  assert.equal(babyAgeMonths({ birthDate: '2026-05-31' }, '2026-11-12'), 5);
  assert.equal(babyAgeMonths({ ageMonths: 6 }, '2026-11-12'), 6);
  assert.equal(babyAgeMonths({ birthDate: '2999-01-01' }, '2026-11-12'), null);
  assert.equal(babyAgeMonths({ ageMonths: 99 }, '2026-11-12'), null);
  assert.equal(babyAgeMonths(undefined, '2026-11-12'), null);
});

test('6个月触发辅食添加与2段奶粉换段，段位提示只建议核对', () => {
  const items = milestonesForAge(6);
  assert.ok(items.some(item => item.id === 'stage2-6m'));
  assert.match(items.find(item => item.id === 'stage2-6m')!.title, /2段奶粉换段/u);
  assert.match(stageHintForMonths(6), /可核对2段换段/u);
  assert.match(stageHintForMonths(2), /1段阶段/u);
  assert.equal(milestonesForAge(30).length, 0);
});

test('所有里程碑话术都不推销、不承诺功效、不越医疗边界', () => {
  for (const item of BABY_MILESTONES) {
    assert.doesNotMatch(item.script, /退款|保证有效|一定有效|优惠|下单|我来诊断|建议用药|用药剂量/u, item.id);
    assert.match(item.script, /不做产品推荐|医生|包装说明/u, item.id);
  }
});

test('自动排程按宝宝月龄生成待办，同一里程碑不重复，未登记档案不生成', () => {
  let sequence = 0;
  const makeId = () => `task-${++sequence}`;
  const base = state({
    customers: [
      customer({ id: 'a', baby: { ageMonths: 6, formulaStage: '1段' } }),
      customer({ id: 'b', baby: { birthDate: '2025-11-12' } }),
      customer({ id: 'c' }),
    ],
  });
  const first = ensureBabyFollowups(base, { todayDate: '2026-11-12', makeId });
  assert.equal(first.created.length, 2);
  assert.ok(first.created.some(task => task.customerId === 'a' && task.babyMilestoneId === 'stage2-6m'));
  assert.ok(first.created.some(task => task.customerId === 'b' && task.babyMilestoneId === 'stage3-12m'));
  assert.deepEqual(first.missingProfile, ['c']);
  assert.equal(first.state.customers[0].nextFollowUpAt, '2026-11-12');
  assert.ok(first.created.every(task => task.status === 'todo' && task.kind === 'followup'));
  const second = ensureBabyFollowups(first.state, { todayDate: '2026-11-12', makeId });
  assert.equal(second.created.length, 0);
  assert.equal(second.state, first.state);
});

test('演示客户可按选项排除，档案摘要显示月龄与段位', () => {
  const base = state({ customers: [customer({ source: 'demo', baby: { ageMonths: 6, formulaStage: '2段' } })] });
  assert.equal(ensureBabyFollowups(base, { todayDate: '2026-11-12', includeDemo: false }).created.length, 0);
  assert.equal(ensureBabyFollowups(base, { todayDate: '2026-11-12' }).created.length, 1);
  assert.match(babyProfileLabel({ ageMonths: 6, formulaStage: '2段', allergies: '乳蛋白敏感' }, '2026-11-12'), /6 个月 · 2段 · 有过敏/u);
  assert.equal(babyProfileLabel(undefined, '2026-11-12'), '未登记宝宝档案');
});
