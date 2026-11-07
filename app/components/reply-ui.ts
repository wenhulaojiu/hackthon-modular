import type { AppState, NativeSenderStatus, ReplySettings } from '../../lib/types';
import { assertWorkspaceCurrent, captureWorkspace, workspaceFetch } from '../../lib/client-workspace.ts';

export function replySettingsFor(state: AppState): ReplySettings {
  const value = state.replySettings;
  return {
    enabled: false,
    autoEnrollNewContacts: true,
    welcomeEnabled: true,
    welcomeMessage: '您好，欢迎添加本店！这里可以咨询商品和服务，欢迎告诉我们您的需求。',
    mode: 'review',
    selectedCustomerIds: [],
    faq: [],
    handoffKeywords: ['转人工', '人工客服', '投诉', '退款', '退货', '改价'],
    maxReplyChars: 300,
    cooldownSeconds: 30,
    prompt: '你是本店的客户服务助手。只根据真实商品、服务说明、FAQ和当前对话回答。没有依据的价格、库存、承诺或效果不得编造；无法确认、客户要求人工或涉及投诉时转人工处理。回复自然简短，不替客户确认购买或付款。',
    ...value,
    debounceSeconds: value?.debounceSeconds ?? 10,
    businessHours: { enabled: true, start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5, 6], ...value?.businessHours },
  };
}

export const localRepliesAvailable = () => typeof window !== 'undefined' && window.location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(window.location.hostname);
export const WEEKDAYS = [{ value: 1, label: '一' }, { value: 2, label: '二' }, { value: 3, label: '三' }, { value: 4, label: '四' }, { value: 5, label: '五' }, { value: 6, label: '六' }, { value: 0, label: '日' }];

export function replyConfigFor(state: AppState) {
  return { settings: replySettingsFor(state), customers: state.customers.filter(customer => customer.source !== 'demo' && customer.wechatId).map(({ id, wechatId, name, autoReplyEnabled, humanTakeover }) => ({ id, wechatId, name, autoReplyEnabled, humanTakeover })), products: state.products ?? [], storeName: state.settings.storeName, industry: state.settings.industry };
}

export class ReplyBridgeError extends Error {
  status?: number;
  constructor(message: string, status?: number) { super(message); this.name = 'ReplyBridgeError'; this.status = status; }
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
  if (localRepliesAvailable()) await replyRequest('/config', await loadSavedReplyConfig());
}

export async function loadSavedReplyConfig() {
  const expected = captureWorkspace();
  const response = await workspaceFetch('/api/state', { cache: 'no-store' }, expected);
  const data = await response.json() as { state?: AppState; error?: string };
  assertWorkspaceCurrent(expected);
  if (!response.ok || !data.state) throw new ReplyBridgeError(data.error || '无法读取已保存的接待规则。');
  // 后台可能刚完成新客户建档，始终同步最新持久化名单，避免旧页面把新客户覆盖掉。
  return replyConfigFor(data.state);
}

// 首次启用由本机接口核对现场账号与版本，不能用尚未绑定的兼容状态阻断入口。
export const nativeSenderCanEnable = (status: NativeSenderStatus | null) => !!status?.available && status.installed && !status.enabled && status.setupState !== 'installing';

export async function nativeSenderRequest(action: 'status' | 'setup' | 'enable' | 'disable', signal?: AbortSignal): Promise<NativeSenderStatus> {
  if (!localRepliesAvailable()) throw new ReplyBridgeError('原生后台发送需要在 Windows 本地版中准备。');
  const expected = captureWorkspace();
  // 组件接口只提交空对象，不携带聊天正文、客户标识或模型密钥。
  const response = await workspaceFetch(`/__local-wechat/native-sender/${action}`, {
    method: action === 'status' ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'X-Kexu-Local': '1', Accept: 'application/json', ...(action === 'status' ? {} : { 'Content-Type': 'application/json' }) },
    ...(action === 'status' ? {} : { body: '{}' }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  }, expected);
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new ReplyBridgeError(response.status === 404 ? '此本地版尚未提供原生发送组件，请更新后重试。' : '原生发送组件返回了无法识别的结果。', response.status); }
  assertWorkspaceCurrent(expected);
  const value = payload as Partial<NativeSenderStatus> & { error?: unknown } | null;
  if (!response.ok) throw new ReplyBridgeError(typeof value?.error === 'string' ? value.error : typeof value?.message === 'string' ? value.message : `原生发送组件请求失败（${response.status}）`, response.status);
  if (!value || ['available', 'installed', 'enabled', 'ready', 'compatible'].some(key => typeof (value as Record<string, unknown>)[key] !== 'boolean') || value.requiresForeground !== false || value.source !== 'helper' || typeof value.message !== 'string' || !['idle', 'installing', 'failed', 'ready'].includes(value.setupState ?? '') || (value.componentVersion != null && typeof value.componentVersion !== 'string')) throw new ReplyBridgeError('原生发送组件状态不完整，请更新本地版后重试。');
  return value as NativeSenderStatus;
}
