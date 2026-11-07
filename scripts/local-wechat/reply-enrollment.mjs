import { isDeepStrictEqual } from 'node:util';

const SYSTEM_CHATS = new Set(['filehelper', 'weixin', 'medianote', 'newsapp', 'fmessage', 'qmessage', 'tmessage', 'qqmail', 'floatbottle', 'shakeapp', 'feedsapp', 'weibo', 'brandsessionholder', 'notifymessage', 'weixinreminder', 'officialaccounts', 'notification_messages', 'wxpay']);
const fail = () => { throw new Error('新私聊接纳结果与当前规则不一致，已停止接待，请重新核对。'); };
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);

// 仅接纳目录已确认的普通私聊；群、系统助手和明确的公众号标识不进入自动建档。
export const isEnrollmentChatId = value => typeof value === 'string' && /^[A-Za-z0-9_.+-]{1,160}$/.test(value) && !value.startsWith('-') && !value.startsWith('gh_') && !value.startsWith('wxpay_') && !SYSTEM_CHATS.has(value.toLowerCase());

// 只匹配完整的好友通过系统句式；调用者还必须核对原生10000类型与系统方向。
export const isFriendAddedSystemText = value => typeof value === 'string' && /^(?:你已(?:经)?添加了[^\r\n]{1,120}[，,]现在可以开始聊天了|[^\r\n]{1,120}通过了你的朋友验证请求[，,]现在(?:我们)?可以开始聊天了)[。.!！]?$/u.test(value.trim());

export function assertAdditiveEnrollment(previous, next) {
  if (!previous?.settings || !next?.settings || previous.settings.enabled !== true || previous.settings.autoEnrollNewContacts === false || !Array.isArray(previous.customers) || !Array.isArray(next.customers) || next.customers.length > 500) fail();
  const beforeIds = previous.settings.selectedCustomerIds;
  const afterIds = next.settings.selectedCustomerIds;
  if (!Array.isArray(beforeIds) || !Array.isArray(afterIds) || afterIds.length > 500 || new Set(afterIds).size !== afterIds.length || afterIds.some(id => !identifier(id)) || beforeIds.some(id => !afterIds.includes(id))) fail();
  const unchangedSettings = settings => ({ ...settings, autoEnrollNewContacts: settings.autoEnrollNewContacts ?? true, welcomeEnabled: settings.welcomeEnabled === undefined ? true : settings.welcomeEnabled, welcomeMessage: settings.welcomeMessage === undefined ? '您好，欢迎光临！想了解店里的商品或服务，都可以在这里问我。' : settings.welcomeMessage, selectedCustomerIds: [] });
  if (!isDeepStrictEqual(unchangedSettings(next.settings), unchangedSettings(previous.settings)) || !isDeepStrictEqual({ ...next, settings: previous.settings, customers: previous.customers }, previous)) fail();
  const old = new Map(previous.customers.map(customer => [customer.id, customer]));
  const nextIds = new Set();
  const nextChats = new Set();
  const added = [];
  for (const customer of next.customers) {
    if (!identifier(customer?.id) || !identifier(customer.wechatId) || nextIds.has(customer.id) || nextChats.has(customer.wechatId)) fail();
    nextIds.add(customer.id); nextChats.add(customer.wechatId);
    if (old.has(customer.id)) {
      if (!isDeepStrictEqual(customer, old.get(customer.id))) fail();
    } else {
      if (!isEnrollmentChatId(customer.wechatId) || previous.customers.some(item => item.wechatId === customer.wechatId) || customer.autoReplyEnabled !== true || customer.humanTakeover || !afterIds.includes(customer.id)) fail();
      added.push(customer.id);
    }
  }
  if (previous.customers.some(customer => !nextIds.has(customer.id)) || afterIds.some(id => !beforeIds.includes(id) && !added.includes(id))) fail();
  return added;
}

export async function requestReplyEnrollment({ origin, request, contacts, workspace, signal }) {
  if (!Array.isArray(contacts) || contacts.length < 1 || contacts.length > 20 || new Set(contacts.map(contact => contact?.wechatId)).size !== contacts.length || contacts.some(contact => !isEnrollmentChatId(contact?.wechatId) || typeof contact.name !== 'string' || !contact.name || contact.name.length > 120 || contact.date !== undefined && (typeof contact.date !== 'string' || !/^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/.test(contact.date) || !Number.isFinite(Date.parse(contact.date))))) throw new Error('新私聊资料格式不正确，未提交自动建档。');
  const response = await request(`${origin}/api/reply/enroll`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(30_000)]),
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Kexu-Local': '1', Cookie: '__sites_local_auth=1', ...(workspace ? { 'X-Kexu-Workspace': workspace.workspaceToken } : {}) },
    body: JSON.stringify({ contacts: contacts.map(({ wechatId, name, date }) => ({ wechatId, name, ...(date ? { date } : {}) })) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error('新私聊自动建档未完成，已暂停接待，请检查客户容量与当前规则。');
  if (!data?.config?.settings || !Array.isArray(data.config.customers) || !Array.isArray(data.addedCustomerIds) || data.addedCustomerIds.some(id => !identifier(id)) || !Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error('新私聊自动建档回执不完整，已暂停接待。');
  return data;
}
