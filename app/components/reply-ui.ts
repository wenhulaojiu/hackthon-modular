import type { AppState, ReplySettings } from '../../lib/types';
import { assertWorkspaceCurrent, captureWorkspace, workspaceFetch } from '../../lib/client-workspace';

export function replySettingsFor(state: AppState): ReplySettings {
  const value = state.replySettings;
  return {
    enabled: false,
    mode: 'review',
    selectedCustomerIds: [],
    faq: [],
    handoffKeywords: ['转人工', '人工客服', '投诉', '退款', '退货', '改价'],
    maxReplyChars: 300,
    cooldownSeconds: 30,
    prompt: '你是本店的客户服务助手。只根据真实商品、服务说明、FAQ和当前对话回答。没有依据的价格、库存、承诺或效果不得编造；无法确认、客户要求人工或涉及投诉时转人工处理。回复自然简短，不替客户确认购买或付款。',
    ...value,
    businessHours: { enabled: true, start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5, 6], ...value?.businessHours },
  };
}

export const localRepliesAvailable = () => typeof window !== 'undefined' && window.location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(window.location.hostname);
export const WEEKDAYS = [{ value: 1, label: '一' }, { value: 2, label: '二' }, { value: 3, label: '三' }, { value: 4, label: '四' }, { value: 5, label: '五' }, { value: 6, label: '六' }, { value: 0, label: '日' }];

export function replyConfigFor(state: AppState) {
  return { settings: replySettingsFor(state), customers: state.customers.filter(customer => customer.source !== 'demo' && customer.wechatId).map(({ id, wechatId, name, autoReplyEnabled, humanTakeover }) => ({ id, wechatId, name, autoReplyEnabled, humanTakeover })), products: state.products ?? [], storeName: state.settings.storeName, industry: state.settings.industry };
}

export class ReplyBridgeError extends Error {
  constructor(message: string, public status?: number) { super(message); this.name = 'ReplyBridgeError'; }
}

export async function replyRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!localRepliesAvailable()) throw new ReplyBridgeError('微信自动回复仅能在本机运行，云端可管理资料和规则。');
  const expected = captureWorkspace();
  const response = await workspaceFetch(`/__local-wechat/replies${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-Kexu-Local': '1', Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) }, expected);
  let result: unknown;
  try { result = await response.json(); } catch { throw new ReplyBridgeError(response.status === 404 ? '本地自动回复组件尚未启用，请使用最新本地版客序。' : '本地自动回复组件返回了无法识别的结果。', response.status); }
  assertWorkspaceCurrent(expected);
  if (!response.ok) { const record = result as { error?: unknown; message?: unknown }; throw new ReplyBridgeError(typeof record?.error === 'string' ? record.error : typeof record?.message === 'string' ? record.message : `本地请求失败（${response.status}）`, response.status); }
  return result as T;
}

export async function syncLocalReplyConfig(state: AppState) {
  if (localRepliesAvailable()) await replyRequest('/config', replyConfigFor(state));
}
