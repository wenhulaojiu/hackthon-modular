import assert from 'node:assert/strict';
import test from 'node:test';
import { enrollReplyContacts, isReplyPrivateContact, mergeReplyEnrollment } from '../lib/reply-enrollment.ts';
import type { AppState } from '../lib/types.ts';

function fixture(): AppState {
  return { schemaVersion: 1, demo: false, customers: [], orders: [], tasks: [], imports: [], products: [], settings: { storeName: '测试门店', industry: '通用', followupDays: 7, ai: { baseUrl: '', model: '', temperature: 0, profilePrompt: '', marketingPrompt: '', extractionPrompt: '' } }, replySettings: { enabled: true, mode: 'auto', autoEnrollNewContacts: true, selectedCustomerIds: [], businessHours: { enabled: false, start: '09:00', end: '18:00', days: [1] }, faq: [], handoffKeywords: [], maxReplyChars: 300, cooldownSeconds: 30, debounceSeconds: 60, prompt: '' } };
}

test('新好友幂等建立新客户档案并纳入回复范围，不复制历史聊天', () => {
  const base = fixture(), contact = { wechatId: 'wxid_fixture_new', name: '新好友', date: '2026-11-07T01:00:00Z' };
  const first = enrollReplyContacts(base, [contact, contact]);
  assert.equal(first.state.customers.length, 1);
  assert.equal(first.state.customers[0].stage, '新客户');
  assert.equal(first.state.customers[0].lastContactAt, contact.date);
  assert.equal(first.state.customers[0].autoReplyEnabled, true);
  assert.deepEqual(first.state.customers[0].messages, []);
  assert.deepEqual(first.state.replySettings?.selectedCustomerIds, first.addedCustomerIds);
  assert.equal(enrollReplyContacts(first.state, [contact]).state, first.state);
  assert.equal(base.customers.length, 0);
});

test('已取消选择或人工接管的既有客户不会被重新开启', () => {
  const base = enrollReplyContacts(fixture(), [{ wechatId: 'wxid_fixture_known', name: '已知客户' }]).state;
  base.customers[0].autoReplyEnabled = false;base.customers[0].humanTakeover = true;base.replySettings!.selectedCustomerIds = [];
  const result = enrollReplyContacts(base, [{ wechatId: 'wxid_fixture_known', name: '不同名字' }]);
  assert.equal(result.state, base);
  assert.deepEqual(result.addedCustomerIds, []);
  assert.equal(result.state.customers[0].name, '已知客户');
});

test('关闭新私聊接待或总开关时不建档', () => {
  for (const field of ['enabled', 'autoEnrollNewContacts'] as const) {
    const base = fixture();base.replySettings![field] = false;
    assert.throws(() => enrollReplyContacts(base, [{ wechatId: 'wxid_fixture', name: '客户' }]), /尚未开启/);
    assert.equal(base.customers.length, 0);
  }
});

test('群聊、公众号和系统账号不进入新私聊接待', () => {
  for (const value of ['filehelper', 'weixin', 'newsapp', 'gh_fixture', 'fixture@chatroom', 'fixture@openim', 'wxpay_fixture', 'wxid_a\n']) {
    assert.equal(isReplyPrivateContact(value), false, value);
    assert.throws(() => enrollReplyContacts(fixture(), [{ wechatId: value, name: '排除对象' }]));
  }
  assert.equal(isReplyPrivateContact('legacy_friend-id.01'), true);
});

test('客户容量达到500时整批失败且不部分修改原对象', () => {
  const one = enrollReplyContacts(fixture(), [{ wechatId: 'wxid_fixture', name: '客户' }]).state.customers[0];
  const base = fixture();base.customers = Array.from({ length: 500 }, (_, i) => ({ ...one, id: `c-${i}`, wechatId: `wxid_fixture_${i}` }));
  assert.throws(() => enrollReplyContacts(base, [{ wechatId: 'wxid_new', name: '新客户' }]), /500/);
  assert.equal(base.customers.length, 500);
});

test('后台新客户可与本地规则草稿合并，保留双方改动', () => {
  const base = fixture(), local = structuredClone(base);local.replySettings!.debounceSeconds = 90;local.settings.storeName = '新店名';
  const remote = enrollReplyContacts(base, [{ wechatId: 'wxid_new', name: '新客户' }]).state;
  const merged = mergeReplyEnrollment(base, local, remote)!;
  assert.ok(merged);
  assert.equal(merged.customers.length, 1);
  assert.equal(merged.replySettings?.debounceSeconds, 90);
  assert.equal(merged.settings.storeName, '新店名');
  assert.deepEqual(merged.replySettings?.selectedCustomerIds, remote.replySettings?.selectedCustomerIds);
});

test('后台原规则或既有档案同时变化时仍拒绝自动合并', () => {
  const base = enrollReplyContacts(fixture(), [{ wechatId: 'wxid_first', name: '老客户' }]).state;
  const remote = enrollReplyContacts(base, [{ wechatId: 'wxid_second', name: '新客户' }]).state;
  const changedRule = structuredClone(remote);changedRule.replySettings!.debounceSeconds = 120;
  assert.equal(mergeReplyEnrollment(base, base, changedRule), null);
  const changedCustomer = structuredClone(remote);changedCustomer.customers[0].note = '其他窗口的人工修改';
  assert.equal(mergeReplyEnrollment(base, base, changedCustomer), null);
  const removedCustomer = structuredClone(remote);removedCustomer.customers.shift();
  assert.equal(mergeReplyEnrollment(base, base, removedCustomer), null);
});

test('多次后台追加可一次合并，重复微信标识和人工接管增量不自动接受', () => {
  const base = fixture();let remote = enrollReplyContacts(base, [{ wechatId: 'wxid_first', name: '新客户一' }]).state;
  remote = enrollReplyContacts(remote, [{ wechatId: 'wxid_second', name: '新客户二' }]).state;
  assert.equal(mergeReplyEnrollment(base, base, remote)?.customers.length, 2);
  remote.customers[0].humanTakeover = true;
  assert.equal(mergeReplyEnrollment(base, base, remote), null);
});
