import assert from 'node:assert/strict';
import test from 'node:test';
import { enrollReplyContacts } from '../lib/reply-enrollment.ts';
import { mergeRuntimeEdit, mergeRuntimeRefresh } from '../lib/runtime-state-refresh.ts';
import type { AppState } from '../lib/types.ts';

function fixture(): AppState {
  const empty: AppState = { schemaVersion: 1, demo: false, customers: [], orders: [], tasks: [], imports: [], products: [], settings: { storeName: '合成门店', industry: '通用', followupDays: 7, ai: { baseUrl: '', model: '', temperature: 0, profilePrompt: '', marketingPrompt: '', extractionPrompt: '' } }, replySettings: { enabled: true, mode: 'auto', autoEnrollNewContacts: true, selectedCustomerIds: [], businessHours: { enabled: false, start: '09:00', end: '18:00', days: [1] }, faq: [], handoffKeywords: [], maxReplyChars: 300, cooldownSeconds: 30, debounceSeconds: 10, prompt: '' } };
  const state = enrollReplyContacts(empty, [{ wechatId: 'wxid_refresh_fixture', name: '合成客户' }], '2026-11-07T01:00:00Z').state;
  state.customers[0].humanTakeover = true;
  return state;
}

test('后台清除接管标记可窄刷新，输入状态保持不变', () => {
  const base = fixture(), before = structuredClone(base), remote = structuredClone(base);
  remote.customers[0].humanTakeover = false;
  const remoteBefore = structuredClone(remote), merged = mergeRuntimeRefresh(base, remote)!;
  assert.ok(merged);
  assert.deepEqual(merged, remote);
  assert.deepEqual(base, before);
  assert.deepEqual(remote, remoteBefore);
});

test('恢复托管时保留本地画像、备注、模型与规则草稿', () => {
  const base = fixture(), local = structuredClone(base), remote = structuredClone(base);
  local.customers[0].summary = '本地画像草稿';
  local.customers[0].note = '本地备注';
  local.settings.storeName = '草稿门店';
  local.settings.ai.temperature = 0.2;
  local.replySettings!.debounceSeconds = 25;
  local.replySettings!.prompt = '规则草稿';
  remote.customers[0].humanTakeover = false;
  const localBefore = structuredClone(local), merged = mergeRuntimeEdit(base, local, remote)!;
  const expected = structuredClone(local);expected.customers[0].humanTakeover = false;
  assert.deepEqual(merged, expected);
  assert.deepEqual(local, localBefore);
});

test('后台新增客户与旧客户恢复托管可同时合并', () => {
  const base = fixture(), local = structuredClone(base);
  local.customers[0].note = '保留本地备注';
  local.replySettings!.debounceSeconds = 45;
  const remote = enrollReplyContacts(base, [{ wechatId: 'wxid_refresh_new', name: '新增合成客户' }], '2026-11-07T01:01:00Z').state;
  remote.customers[0] = { ...remote.customers[0], humanTakeover: false };
  const merged = mergeRuntimeEdit(base, local, remote)!;
  assert.ok(merged);
  assert.equal(merged.customers.length, 2);
  assert.equal(merged.customers[0].humanTakeover, false);
  assert.equal(merged.customers[0].note, '保留本地备注');
  assert.deepEqual(merged.customers[1], remote.customers[1]);
  assert.equal(merged.replySettings?.debounceSeconds, 45);
  assert.deepEqual(merged.replySettings?.selectedCustomerIds, remote.replySettings?.selectedCustomerIds);
  assert.equal(base.customers[0].humanTakeover, true);
});

test('远端既有业务资料、客户、订单或规则变化继续拒绝合并', () => {
  const changes: Array<(state: AppState) => void> = [
    state => { state.customers[0].note = '另一页面备注'; },
    state => { state.customers = [];state.replySettings!.selectedCustomerIds = []; },
    state => { state.orders.push({ id: 'order-fixture', customerId: state.customers[0].id, description: '合成订单', amount: 10, date: '2026-11-07', status: 'confirmed', type: 'sale', evidence: '' }); },
    state => { state.replySettings!.debounceSeconds = 120; },
    state => { state.settings.storeName = '另一页面门店'; },
  ];
  for (const change of changes) {
    const base = fixture(), remote = structuredClone(base);remote.customers[0].humanTakeover = false;
    change(remote);
    assert.equal(mergeRuntimeRefresh(base, remote), null);
  }
});

test('无后台变化或远端开启人工接管时不自动覆盖', () => {
  const base = fixture();
  assert.equal(mergeRuntimeRefresh(base, structuredClone(base)), null);
  base.customers[0].humanTakeover = false;
  const remote = structuredClone(base);remote.customers[0].humanTakeover = true;
  assert.equal(mergeRuntimeRefresh(base, remote), null);
});

test('本地已修改人工接管字段时保留本地值', () => {
  const base = fixture(), remote = structuredClone(base);remote.customers[0].humanTakeover = false;
  for (const value of [false, undefined]) {
    const local = structuredClone(base);local.customers[0].humanTakeover = value;
    const merged = mergeRuntimeEdit(base, local, remote)!;
    assert.ok(merged);
    assert.equal(merged.customers[0].humanTakeover, value);
  }
});
