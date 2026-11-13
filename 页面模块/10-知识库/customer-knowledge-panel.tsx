'use client';

import { useMemo, useState } from 'react';
import type { AppState, Customer } from '../../lib/types';
import { babyProfileLabel } from '../../lib/baby-milestones';
import { today } from '../../lib/domain';

type Props = {
  state: AppState;
  onChange: (next: AppState) => Promise<boolean>;
  notify: (text: string, error?: boolean) => void;
};

type Draft = { preferences: string; budget: string };

/** 汇总客户已确认消费中出现最多的商品，作为「常买」参考。 */
function frequentBuys(state: AppState, customerId: string): string {
  const counts = new Map<string, number>();
  for (const order of state.orders) {
    if (order.customerId !== customerId || order.status !== 'confirmed' || order.type !== 'sale') continue;
    const name = order.description.trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
    .join('、');
}

/** 用户信息分区：每个客户喜欢什么、常买什么、宝宝情况，一处查、直接改，AI 回复即按此个性化。 */
export default function CustomerKnowledgePanel({ state, onChange, notify }: Props) {
  const [query, setQuery] = useState('');
  const [edits, setEdits] = useState<Record<string, Draft>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const todayDate = today();

  const customers = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const list = [...state.customers].sort((a, b) => b.lastContactAt.localeCompare(a.lastContactAt));
    if (!keyword) return list;
    return list.filter(customer =>
      [customer.name, customer.preferences, customer.budget, customer.summary, ...customer.tags, ...customer.manualTags]
        .join(' ')
        .toLowerCase()
        .includes(keyword),
    );
  }, [state.customers, query]);

  const draftOf = (customer: Customer): Draft => edits[customer.id] ?? { preferences: customer.preferences, budget: customer.budget };
  const setDraft = (customer: Customer, patch: Partial<Draft>) =>
    setEdits(current => ({ ...current, [customer.id]: { ...draftOf(customer), ...patch } }));
  const isDirty = (customer: Customer) => {
    const draft = draftOf(customer);
    return draft.preferences !== customer.preferences || draft.budget !== customer.budget;
  };

  const save = async (customer: Customer) => {
    if (savingId) return;
    const draft = draftOf(customer);
    setSavingId(customer.id);
    try {
      const next: AppState = {
        ...state,
        customers: state.customers.map(item =>
          item.id === customer.id ? { ...item, preferences: draft.preferences.trim(), budget: draft.budget.trim() } : item,
        ),
      };
      if (await onChange(next)) {
        setEdits(current => {
          const rest = { ...current };
          delete rest[customer.id];
          return rest;
        });
        notify(`已更新 ${customer.name} 的偏好记录`);
      }
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="card-heading">
        <div>
          <h2>用户信息</h2>
          <p>每个客户的偏好、常买商品和宝宝情况。AI 个性化回复以此为准，修改后立即生效。</p>
        </div>
        <input
          className="input"
          style={{ maxWidth: 260 }}
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="搜索姓名、标签、偏好…"
          aria-label="搜索用户信息"
        />
      </div>
      {!customers.length && <p className="muted" style={{ padding: '12px 0' }}>没有匹配的客户。</p>}
      {customers.map(customer => {
        const draft = draftOf(customer);
        const buys = frequentBuys(state, customer.id);
        return (
          <section key={customer.id} style={{ padding: '14px 0', borderTop: '1px solid #f1f3f6' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <strong>{customer.name}</strong>
              <span className="muted small">{customer.stage}</span>
              <span className="muted small">{babyProfileLabel(customer.baby, todayDate)}</span>
              {[...customer.manualTags, ...customer.tags].slice(0, 5).map(tag => (
                <span key={tag} className="tag small">{tag}</span>
              ))}
            </div>
            {buys && <p className="muted small" style={{ margin: '0 0 8px' }}>常买：{buys}</p>}
            <label className="field" style={{ display: 'block', marginBottom: 8 }}>
              偏好（喜欢什么、忌讳什么）
              <textarea
                className="input"
                rows={2}
                maxLength={500}
                value={draft.preferences}
                onChange={event => setDraft(customer, { preferences: event.target.value })}
                placeholder="例如：偏好国产奶粉，关注乳铁蛋白，对价格敏感"
              />
            </label>
            <label className="field" style={{ display: 'block', marginBottom: 8 }}>
              预算
              <input
                className="input"
                maxLength={80}
                value={draft.budget}
                onChange={event => setDraft(customer, { budget: event.target.value })}
                placeholder="例如：每月 800-1200 元"
              />
            </label>
            <div style={{ textAlign: 'right' }}>
              <button
                className="btn primary sm"
                type="button"
                disabled={!isDirty(customer) || savingId !== null}
                onClick={() => { void save(customer); }}
              >
                {savingId === customer.id ? '保存中…' : '保存'}
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
