import type { Customer } from '../../lib/types.ts';

export type CustomerSort = 'date-asc' | 'date-desc' | 'activity-desc';
const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function validTimestamp(value: string): number | null {
  const day = value.match(/^(\d{4}-\d{2}-\d{2})(?:T.*)?$/)?.[1];
  if (!day) return null;
  const calendar = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day) return null;
  // 只有日期的记录按门店北京时间解释，避免运行机器时区影响排序和统计。
  const normalized = value === day ? `${day}T00:00:00+08:00` : /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value) ? `${value}+08:00` : value;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export const customerContactTimestamp = (customer: Pick<Customer, 'lastContactAt'>): number | null => validTimestamp(customer.lastContactAt);

export function recentCustomerMessageCount(customer: Pick<Customer, 'messages'>, now = Date.now()): number {
  const since = now - RECENT_WINDOW_MS;
  return customer.messages.reduce((count, message) => {
    const timestamp = message.sender === 'customer' ? validTimestamp(message.date) : null;
    return count + (timestamp !== null && timestamp >= since && timestamp <= now ? 1 : 0);
  }, 0);
}

export function sortCustomers(customers: readonly Customer[], order: CustomerSort, now = Date.now()): Customer[] {
  const rows = customers.map((customer, index) => ({ customer, index, contact: customerContactTimestamp(customer), activity: order === 'activity-desc' ? recentCustomerMessageCount(customer, now) : 0 }));
  return rows.sort((a, b) => {
    if (order === 'activity-desc' && a.activity !== b.activity) return b.activity - a.activity;
    // 无联系日期的客户始终排在末尾，升序也不能把未知日期放到最前面。
    if (a.contact === null || b.contact === null) return a.contact === b.contact ? a.index - b.index : a.contact === null ? 1 : -1;
    const dateOrder = order === 'date-asc' ? a.contact - b.contact : b.contact - a.contact;
    return dateOrder || a.index - b.index;
  }).map(row => row.customer);
}
