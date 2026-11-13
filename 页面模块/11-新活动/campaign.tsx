'use client';

import { useMemo, useState } from 'react';
import { Megaphone, Send } from 'lucide-react';
import type { CustomerStage, PageId, SharedProps, Task } from '../../lib/types';
import { today } from '../../lib/domain';
import { uid } from '../09-公共工具与样式/ui';

const STAGES: CustomerStage[] = ['新客户', '潜在客户', '活跃客户', '重点维护', '待唤醒'];
const MAX_SCRIPT = 300;

/** 新活动：写一段活动内容，按阶段/标签/偏好圈选客户，一键生成推送任务，到「客户跟进」逐条核实发送。 */
export default function Campaign({ state, onChange, notify, go }: SharedProps & { go: (id: PageId) => void }) {
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [stage, setStage] = useState<CustomerStage | ''>('');
  const [keyword, setKeyword] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const matched = useMemo(() => {
    const word = keyword.trim().toLowerCase();
    return state.customers.filter(customer => {
      if (stage && customer.stage !== stage) return false;
      if (!word) return true;
      return [customer.name, customer.preferences, customer.summary, ...customer.tags, ...customer.manualTags]
        .join(' ')
        .toLowerCase()
        .includes(word);
    });
  }, [state.customers, stage, keyword]);

  const selected = matched.filter(customer => selectedIds.includes(customer.id));
  const allMatchedSelected = matched.length > 0 && matched.every(customer => selectedIds.includes(customer.id));

  const toggle = (id: string) =>
    setSelectedIds(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]));
  const toggleAll = () =>
    setSelectedIds(current => {
      if (allMatchedSelected) return current.filter(id => !matched.some(customer => customer.id === id));
      return [...new Set([...current, ...matched.map(customer => customer.id)])];
    });

  const create = async () => {
    if (creating) return;
    const title = name.trim();
    const script = content.trim();
    if (!title) { notify('请先填写活动名称', true); return; }
    if (!script) { notify('请先填写推送内容', true); return; }
    if (script.length > MAX_SCRIPT) { notify(`推送内容不能超过 ${MAX_SCRIPT} 字（单条微信发送上限）`, true); return; }
    if (!selected.length) { notify('请先勾选要推送的客户', true); return; }
    setCreating(true);
    try {
      const date = today();
      const existing = new Set(
        state.tasks
          .filter(task => task.status === 'todo' && task.title === `新活动·${title}`)
          .map(task => task.customerId),
      );
      const fresh: Task[] = selected
        .filter(customer => !existing.has(customer.id))
        .map(customer => ({
          id: uid(), customerId: customer.id, title: `新活动·${title}`, date,
          kind: 'marketing', status: 'todo', priority: 'normal', script,
        }));
      if (!fresh.length) { notify('所选客户都已有同名待推送任务，未重复创建', true); return; }
      const skipped = selected.length - fresh.length;
      const ok = await onChange({ ...state, tasks: [...state.tasks, ...fresh] });
      if (!ok) return;
      notify(`已生成 ${fresh.length} 条推送任务${skipped ? `，${skipped} 条因重名跳过` : ''}，请到「客户跟进」核实后一键发送`);
      go('marketing');
    } finally {
      setCreating(false);
    }
  };

  return <>
    <section className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div className="card-heading">
        <div>
          <h2><Megaphone size={18} style={{ verticalAlign: '-3px', marginRight: 6 }} />创建新活动</h2>
          <p>写好活动内容，圈选目标客户，一键生成推送任务。发送前仍会在「客户跟进」逐条核实，不会直接群发。</p>
        </div>
      </div>
      <label className="field" style={{ display: 'block', marginBottom: 10 }}>
        活动名称
        <input className="input" maxLength={60} value={name} onChange={event => setName(event.target.value)} placeholder="例如：新客小罐装 99 元尝鲜" />
      </label>
      <label className="field" style={{ display: 'block' }}>
        推送内容（{content.length}/{MAX_SCRIPT} 字）
        <textarea
          className="input" rows={4} maxLength={MAX_SCRIPT * 2} value={content}
          onChange={event => setContent(event.target.value)}
          placeholder="例如：宝妈您好，本周门店新客活动：0-6 个月奶粉小罐装 99 元，先试用再换大罐更稳妥。需要的话我帮您留一罐？"
        />
      </label>
    </section>

    <section className="card" style={{ padding: 16 }}>
      <div className="card-heading">
        <div>
          <h2>圈选客户</h2>
          <p>按客户阶段、标签或偏好关键词筛选，再逐个勾选。</p>
        </div>
        <span className="muted small">匹配 {matched.length} 位 · 已选 {selected.length} 位</span>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <select className="input" style={{ maxWidth: 160 }} value={stage} onChange={event => setStage(event.target.value as CustomerStage | '')} aria-label="按客户阶段筛选">
          <option value="">全部阶段</option>
          {STAGES.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
        <input className="input" type="search" style={{ maxWidth: 260 }} value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="搜索姓名、标签、偏好…" aria-label="按关键词筛选客户" />
        <button className="btn secondary sm" type="button" onClick={toggleAll}>{allMatchedSelected ? '取消全选' : '全选匹配结果'}</button>
      </div>
      {!matched.length && <p className="muted" style={{ padding: '8px 0' }}>没有匹配的客户，调整筛选条件试试。</p>}
      <div style={{ maxHeight: 320, overflowY: 'auto' }}>
        {matched.map(customer => (
          <label key={customer.id} className="checkbox-label" style={{ display: 'flex', gap: 8, padding: '6px 0', alignItems: 'baseline' }}>
            <input type="checkbox" checked={selectedIds.includes(customer.id)} onChange={() => toggle(customer.id)} />
            <span>
              <strong>{customer.name}</strong>
              <span className="muted small">　{customer.stage}{customer.source === 'demo' ? ' · 演示客户（发送时会被跳过）' : ''}</span>
              {customer.preferences && <span className="muted small">　{customer.preferences.slice(0, 40)}</span>}
            </span>
          </label>
        ))}
      </div>
      <div className="modal-actions" style={{ marginTop: 12 }}>
        <button className="btn primary" type="button" disabled={creating || !selected.length} onClick={() => { void create(); }}>
          <Send size={15} />{creating ? '正在生成…' : `生成 ${selected.length} 条推送任务`}
        </button>
      </div>
    </section>
  </>;
}
