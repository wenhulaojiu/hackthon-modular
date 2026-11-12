import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRevisitTasks, DEFAULT_REVISIT_SCRIPT, REVISIT_LIMITS, revisitScript } from '../lib/visit-plan.ts';
import type { AppState, Customer } from '../lib/types.ts';

const customer = (patch: Partial<Customer> = {}): Customer => ({
  id: 'c1', name: '林女士', wechatId: 'wxid_synthetic', color: '#123456', stage: '新客户', tags: [], manualTags: [],
  summary: '', preferences: '', budget: '', note: '', createdAt: '2026-11-01', lastContactAt: '', nextFollowUpAt: '',
  source: 'manual', evidence: [], messages: [], ...patch,
});
const state = (patch: Partial<AppState> = {}): AppState => ({
  schemaVersion: 1, customers: [customer()], orders: [], tasks: [], imports: [], demo: false,
  settings: { storeName: '合成门店', industry: '', followupDays: 30, ai: { baseUrl: '', model: '', temperature: 0, profilePrompt: '', marketingPrompt: '', extractionPrompt: '' } },
  ...patch,
});

test('默认回访话术询问宝宝近况与医生建议，不推销、不做医疗判断', () => {
  assert.equal(revisitScript(''), DEFAULT_REVISIT_SCRIPT);
  assert.match(DEFAULT_REVISIT_SCRIPT, /不做产品推荐/u);
  assert.match(DEFAULT_REVISIT_SCRIPT, /医生/u);
  assert.doesNotMatch(DEFAULT_REVISIT_SCRIPT, /优惠|下单|保证有效|诊断|剂量/u);
  assert.ok(DEFAULT_REVISIT_SCRIPT.length <= REVISIT_LIMITS.maxScriptChars);
});

test('按间隔生成回访待办，只创建任务不发送，并更新下次跟进日期', () => {
  let sequence = 0;
  const result = createRevisitTasks(state(), { customerIds: ['c1'], startDate: '2026-11-12', intervalDays: 30, times: 3, makeId: () => `task-${++sequence}` });
  assert.equal(result.error, undefined);
  assert.equal(result.created.length, 3);
  assert.deepEqual(result.created.map(task => task.date), ['2026-11-12', '2026-12-12', '2027-01-11']);
  assert.ok(result.created.every(task => task.kind === 'reminder' && task.status === 'todo' && task.script === DEFAULT_REVISIT_SCRIPT));
  assert.equal(result.state.tasks.length, 3);
  assert.equal(result.state.customers[0].nextFollowUpAt, '2026-11-12');
});

test('参数、恶意话术与演示客户都被拒绝，状态保持不变', () => {
  const base = state({ customers: [customer({ source: 'demo' })] });
  const invalid: Array<Partial<Parameters<typeof createRevisitTasks>[1]>> = [
    { startDate: '不是日期' }, { intervalDays: 0 }, { intervalDays: 400 }, { times: 0 }, { times: 99 },
    { script: '保证有效，已经退款' }, { script: '建议用药剂量' }, { script: 'x'.repeat(301) },
  ];
  for (const patch of invalid) {
    const result = createRevisitTasks(base, { customerIds: ['c1'], startDate: '2026-11-12', intervalDays: 30, times: 3, ...patch });
    assert.ok(result.error, JSON.stringify(patch));
    assert.equal(result.state, base);
    assert.equal(result.created.length, 0);
  }
  const demo = createRevisitTasks(base, { customerIds: ['c1'], startDate: '2026-11-12', intervalDays: 30, times: 3 });
  assert.ok(demo.error);
  assert.equal(demo.skipped[0].reason, '演示客户不安排回访');
});

test('回访话术可写明不做诊断等否定式边界声明', () => {
  const script = '您好，想了解宝宝最近吃睡情况。我们不提供医疗诊断，也不做产品推荐。';
  const result = createRevisitTasks(state(), { customerIds: ['c1'], startDate: '2026-11-12', intervalDays: 7, times: 1, script });
  assert.equal(result.error, undefined);
  assert.equal(result.created[0].script, script);
});

test('知识库中的回访话术可被门店覆盖，空模板回退到默认值', () => {
  const custom = '您好，想了解一下宝宝最近吃睡情况，医生有没有新的建议？这次不推荐产品。';
  const result = createRevisitTasks(state(), { customerIds: ['c1'], startDate: '2026-11-12', intervalDays: 7, times: 1, script: custom });
  assert.equal(result.created[0].script, custom);
  assert.equal(createRevisitTasks(state(), { customerIds: ['c1'], startDate: '2026-11-12', intervalDays: 7, times: 1 }).created[0].script, DEFAULT_REVISIT_SCRIPT);
});
