import type { AppState } from './types.ts';
import { mergeReplyEnrollment } from './reply-enrollment.ts';

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value) ?? 'null';

// 后台只可追加新客户或清除已完成的人工接管，其他窗口的业务修改继续提示冲突。
export function mergeRuntimeRefresh(base: AppState, remote: AppState): AppState | null {
  return mergeRuntimeEdit(base, base, remote);
}

export function mergeRuntimeEdit(base: AppState, local: AppState, remote: AppState): AppState | null {
  const byId = new Map(base.customers.map(customer => [customer.id, customer]));
  const cleared = remote.customers.filter(customer => byId.get(customer.id)?.humanTakeover === true && customer.humanTakeover === false).map(customer => customer.id);
  if (!cleared.length) return mergeReplyEnrollment(base, local, remote);
  const ids = new Set(cleared);
  const normalized = { ...remote, customers: remote.customers.map(customer => ids.has(customer.id) ? { ...customer, humanTakeover: true } : customer) };
  const merged = canonical(base) === canonical(normalized) ? local : mergeReplyEnrollment(base, local, normalized);
  if (!merged) return null;
  // 正在编辑的其他资料保留，仅将未在本地改变的旧接管标记同步为已恢复。
  return { ...merged, customers: merged.customers.map(customer => ids.has(customer.id) && customer.humanTakeover === byId.get(customer.id)?.humanTakeover ? { ...customer, humanTakeover: false } : customer) };
}
