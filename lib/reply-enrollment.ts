import type { AppState, Customer } from './types.ts';

export type ReplyContact = { wechatId: string; name: string; date?: string };
const SYSTEM_CONTACTS = new Set(['filehelper', 'weixin', 'fmessage', 'newsapp', 'medianote', 'floatbottle', 'qmessage', 'tmessage', 'qqmail', 'weibo', 'feedsapp', 'brandsessionholder', 'notifymessage', 'weixinreminder', 'officialaccounts', 'notification_messages', 'wxpay']);

export function isReplyPrivateContact(value: string): boolean {
  return !!value && value.length <= 200 && !/[\u0000-\u0020@]/u.test(value) && !value.startsWith('gh_') && !value.startsWith('wxpay_') && !SYSTEM_CONTACTS.has(value.toLowerCase());
}

export function enrollReplyContacts(state: AppState, contacts: ReplyContact[], now = new Date().toISOString()) {
  if (!state.replySettings?.enabled || state.replySettings.autoEnrollNewContacts === false) throw new Error('自动接待新私聊尚未开启。');
  const added: Customer[] = [];
  const known = new Set(state.customers.map(customer => customer.wechatId));
  for (const contact of contacts) {
    if (!isReplyPrivateContact(contact.wechatId)) throw new Error('仅能自动接待有效好友私聊。');
    // 已有档案的人工接管、未勾选或停用状态由商家决定，不能在发现阶段重新开启。
    if (known.has(contact.wechatId)) continue;
    if (state.customers.length + added.length >= 500) throw new Error('客户档案已达500位，请整理后再接待新客户。');
    const date = contact.date || now;
    added.push({ id: `wx-${crypto.randomUUID()}`, name: contact.name.trim().slice(0, 120) || contact.wechatId.slice(0, 120), wechatId: contact.wechatId, color: '#6a8f38', stage: '新客户', tags: [], manualTags: [], summary: '', preferences: '', budget: '', note: '', createdAt: now, lastContactAt: date, nextFollowUpAt: '', source: 'wechat', evidence: [], messages: [], autoReplyEnabled: true, humanTakeover: false });
    known.add(contact.wechatId);
  }
  const addedCustomerIds = added.map(customer => customer.id);
  const next: AppState = added.length ? { ...state, demo: false, customers: [...state.customers, ...added], replySettings: { ...state.replySettings, selectedCustomerIds: [...state.replySettings.selectedCustomerIds, ...addedCustomerIds] } } : state;
  return { state: next, addedCustomerIds };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

// 仅合并后台新增的客户；规则、旧档案或其他数据变化继续走原有冲突保护。
export function mergeReplyEnrollment(base: AppState, local: AppState, remote: AppState): AppState | null {
  const previousIds = new Set(base.customers.map(customer => customer.id));
  const added = remote.customers.filter(customer => !previousIds.has(customer.id));
  if (!added.length || added.some(customer => customer.source !== 'wechat' || !customer.autoReplyEnabled || customer.humanTakeover || !isReplyPrivateContact(customer.wechatId) || base.customers.some(old => old.wechatId === customer.wechatId))) return null;
  const addedIds = new Set(added.map(customer => customer.id));
  if (added.some(customer => !remote.replySettings?.selectedCustomerIds.includes(customer.id))) return null;
  const withoutAdded: AppState = { ...remote, demo: base.demo, customers: remote.customers.filter(customer => !addedIds.has(customer.id)), ...(remote.replySettings ? { replySettings: { ...remote.replySettings, selectedCustomerIds: remote.replySettings.selectedCustomerIds.filter(id => !addedIds.has(id)) } } : {}) };
  if (canonical(base) !== canonical(withoutAdded) || !local.replySettings || !base.replySettings) return null;
  const known = new Set(local.customers.map(customer => customer.wechatId));
  if (added.some(customer => known.has(customer.wechatId) || local.customers.some(old => old.id === customer.id))) return null;
  if (local.customers.length + added.length > 500) return null;
  return { ...local, demo: false, customers: [...local.customers, ...added], replySettings: { ...local.replySettings, selectedCustomerIds: [...new Set([...local.replySettings.selectedCustomerIds, ...addedIds])] } };
}
