'use client';

import { useMemo, useState } from 'react';
import { Pencil, Search, Trash2 } from 'lucide-react';
import type { AppState, Customer } from '../../lib/types';
import { babyProfileLabel } from '../../lib/baby-milestones';
import { today } from '../../lib/domain';
import './knowledge.css';

type Props = {
  state: AppState;
  onChange: (next: AppState) => Promise<boolean>;
  notify: (text: string, error?: boolean) => void;
};

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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ preferences: '', budget: '' });
  const [saving, setSaving] = useState(false);
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

  const startEdit = (customer: Customer) => {
    setEditingId(customer.id);
    setDraft({ preferences: customer.preferences, budget: customer.budget });
  };

  const save = async (customer: Customer) => {
    if (saving) return;
    setSaving(true);
    try {
      const next: AppState = {
        ...state,
        customers: state.customers.map(item =>
          item.id === customer.id ? { ...item, preferences: draft.preferences.trim(), budget: draft.budget.trim() } : item,
        ),
      };
      if (await onChange(next)) {
        setEditingId(null);
        notify(`已更新 ${customer.name} 的偏好记录`);
      }
    } finally {
      setSaving(false);
    }
  };

  const clear = async (customer: Customer) => {
    if (saving) return;
    if (!window.confirm(`确定清空 ${customer.name} 的偏好和预算记录吗？客户档案本身会保留。`)) return;
    setSaving(true);
    try {
      const next: AppState = {
        ...state,
        customers: state.customers.map(item =>
          item.id === customer.id ? { ...item, preferences: '', budget: '' } : item,
        ),
      };
      if (await onChange(next)) {
        if (editingId === customer.id) setEditingId(null);
        notify(`已清空 ${customer.name} 的偏好记录`);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="knowledge-panel">
      <div className="knowledge-panel-head">
        <div>
          <h2>用户信息</h2>
          <p>每个客户的偏好、常买商品和宝宝情况。AI 个性化回复以此为准，修改后立即生效。</p>
        </div>
        <span className="knowledge-count">{customers.length} / {state.customers.length} 位</span>
      </div>

      <div className="knowledge-search">
        <Search size={15} />
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索姓名、标签、偏好…" aria-label="搜索用户信息" />
      </div>

      {!customers.length && <p className="knowledge-empty">没有匹配的客户。</p>}
      {customers.map(customer => {
        const editing = editingId === customer.id;
        const buys = frequentBuys(state, customer.id);
        if (!editing) {
          return (
            <div key={customer.id} className="knowledge-entry">
              <div className="knowledge-entry-head">
                <span className="knowledge-entry-title">{customer.name}</span>
                <span className="knowledge-actions">
                  <button type="button" className="knowledge-btn edit" onClick={() => startEdit(customer)}><Pencil size={12} />编辑</button>
                  <button type="button" className="knowledge-btn remove" disabled={saving} onClick={() => { void clear(customer); }}><Trash2 size={12} />移除</button>
                </span>
              </div>
              <div className="knowledge-entry-meta">
                <span>{customer.stage}</span>
                <span>{babyProfileLabel(customer.baby, todayDate)}</span>
                {buys && <span>常买：{buys}</span>}
              </div>
              {customer.preferences && <p className="knowledge-entry-preview">偏好：{customer.preferences}</p>}
              {customer.budget && <p className="knowledge-entry-preview">预算：{customer.budget}</p>}
              {[...customer.manualTags, ...customer.tags].length > 0 && (
                <div className="knowledge-tags" style={{ marginTop: 6 }}>
                  {[...customer.manualTags, ...customer.tags].slice(0, 5).map(tag => <span key={tag} className="knowledge-tag">{tag}</span>)}
                </div>
              )}
            </div>
          );
        }
        return (
          <div key={customer.id} className="knowledge-entry editing">
            <div className="knowledge-entry-head" style={{ marginBottom: 8 }}>
              <span className="knowledge-entry-title">{customer.name}</span>
              <span className="knowledge-entry-meta">{customer.stage} · {babyProfileLabel(customer.baby, todayDate)}</span>
            </div>
            <label className="field" style={{ display: 'block', marginBottom: 8 }}>
              偏好（喜欢什么、忌讳什么）
              <textarea
                className="input" rows={2} maxLength={500} value={draft.preferences}
                onChange={event => setDraft(current => ({ ...current, preferences: event.target.value }))}
                placeholder="例如：偏好国产奶粉，关注乳铁蛋白，对价格敏感"
              />
            </label>
            <label className="field" style={{ display: 'block', marginBottom: 8 }}>
              预算
              <input
                className="input" maxLength={80} value={draft.budget}
                onChange={event => setDraft(current => ({ ...current, budget: event.target.value }))}
                placeholder="例如：每月 800-1200 元"
              />
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="knowledge-btn ghost" type="button" disabled={saving} onClick={() => setEditingId(null)}>取消</button>
              <button className="knowledge-btn save" type="button" disabled={saving} onClick={() => { void save(customer); }}>{saving ? '保存中…' : '保存'}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
