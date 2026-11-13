'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpDown, ArrowUpRight, Bot, CalendarDays, Check, ChevronRight, Copy, FileText, Hand, Loader2, MessageCircle, Pencil, Plus, Search, Sparkles, Tag, Trash2, Wallet, X } from 'lucide-react';
import type { AIResult, AppState, Customer, CustomersProps, CustomerStage, Order } from '../../lib/types';
import { customerStats, shiftDate, today } from '../../lib/domain';
import { localRepliesAvailable, replyConfigFor, replyRequest, replySettingsFor } from '../05-自动回复/reply-ui';
import { sortCustomers, type CustomerSort } from './customer-sorting';
import VoiceProfilePanel from './voice-profile';
import ValueTierCard from './value-tier';
import BabyProfileEditor, { BabyBadge } from './baby-profile';
import { BABY_FEEDING_LABELS } from '../../lib/baby-milestones';
import './customers.css';
import { documentToCustomers, type ParsedDocument } from '../../lib/file-import';
import FileImportButton from '../09-公共工具与样式/file-import-button';

const STAGES: CustomerStage[] = ['新客户', '潜在客户', '活跃客户', '重点维护', '待唤醒'];
const COLORS = ['#7566d9', '#6599a2', '#ce956c', '#8d93be', '#9d85b0'];
const SOURCE_LABELS = { demo: '示例数据', manual: '手动添加', wechat: '微信导入' };
const id = () => crypto.randomUUID();
const money = (amount: number) => `¥${amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const splitTags = (text: string) => [...new Set(text.split(/[,，、\n]/).map(tag => tag.trim()).filter(Boolean))];
const defaultFollowup = (days: number) => shiftDate(days);
const statsFor = (state: AppState, customerId: string) => {
  const stats = customerStats(customerId, state.orders);
  return { total: stats.total, count: stats.visits };
};

type ProfileDraft = Pick<Customer, 'summary' | 'preferences' | 'budget' | 'note'> & { aiTags: string; manualTags: string };
const draftFor = (customer: Customer): ProfileDraft => ({ summary: customer.summary, preferences: customer.preferences, budget: customer.budget, note: customer.note, aiTags: customer.tags.join('，'), manualTags: customer.manualTags.join('，') });

export default function Customers({ state, onChange, notify, onAI, selectedId, onSelect }: CustomersProps) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<CustomerSort>('date-desc');
  const [showCreate, setShowCreate] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ name: '', wechatId: '', stage: '新客户' as CustomerStage, tags: '', note: '' });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [section, setSection] = useState<'profile' | 'orders' | 'chat'>('profile');
  const [busy, setBusy] = useState<'profile' | 'marketing' | 'extract' | null>(null);
  const [script, setScript] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);
  const [showOrder, setShowOrder] = useState(false);
  const [orderDraft, setOrderDraft] = useState({ description: '', amount: '', date: today(), type: 'sale' as 'sale' | 'refund' });
  const stateRef = useRef(state);
  stateRef.current = state;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const customer = state.customers.find(item => item.id === selectedId);

  useEffect(() => {
    const current = stateRef.current.customers.find(item => item.id === selectedId);
    setDraft(current ? draftFor(current) : null);
    setEditing(false); setSection('profile');
    setScript(current ? stateRef.current.tasks.filter(task => task.customerId === current.id && task.kind === 'marketing' && task.script).at(-1)?.script || '' : '');
    setShowOrder(false);
  }, [selectedId]);

  useEffect(() => {
    if (!showCreate && !selectedId && !showOrder) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { if (showOrder) setShowOrder(false); else if (showCreate) setShowCreate(false); else onSelect(null); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showCreate, selectedId, showOrder, onSelect]);

  const updateCustomer = (customerId: string, patch: Partial<Customer>) => {
    const current = stateRef.current;
    return onChange({ ...current, customers: current.customers.map(item => item.id === customerId ? { ...item, ...patch } : item) });
  };

  const createCustomer = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newCustomer.name.trim()) { notify('请填写客户称呼', true); return; }
    const current = stateRef.current;
    const next: Customer = { id: id(), name: newCustomer.name.trim(), wechatId: newCustomer.wechatId.trim(), color: COLORS[current.customers.length % COLORS.length], stage: newCustomer.stage, tags: [], manualTags: splitTags(newCustomer.tags), summary: '', preferences: '', budget: '', note: newCustomer.note.trim(), createdAt: today(), lastContactAt: '', nextFollowUpAt: defaultFollowup(current.settings.followupDays), source: 'manual', evidence: [], messages: [] };
    const task = { id: id(), customerId: next.id, title: `跟进${next.name}`, date: next.nextFollowUpAt, kind: 'followup' as const, status: 'todo' as const, priority: 'normal' as const, script: '' };
    if (!await onChange({ ...current, customers: [next, ...current.customers], tasks: [task, ...current.tasks] })) return;
    setNewCustomer({ name: '', wechatId: '', stage: '新客户', tags: '', note: '' }); setShowCreate(false); onSelect(next.id); notify('客户已添加');
  };

  const importCustomers = async (documents: ParsedDocument[]) => {
    const current = stateRef.current;
    const { customers, skipped } = documentToCustomers(documents, current.customers);
    if (!customers.length) { notify('未识别到新客户', true); return; }
    const success = await onChange({ ...current, customers: [...customers, ...current.customers] });
    if (success) notify(`已导入 ${customers.length} 位客户${skipped ? `，跳过 ${skipped} 条重复` : ''}`);
  };

  const saveProfile = async () => {
    if (!customer || !draft) return;
    if (!await updateCustomer(customer.id, { summary: draft.summary.trim(), preferences: draft.preferences.trim(), budget: draft.budget.trim(), note: draft.note.trim(), tags: splitTags(draft.aiTags), manualTags: splitTags(draft.manualTags) })) return;
    setEditing(false); notify('客户档案已保存');
  };

  const runAI = async (action: 'profile' | 'marketing' | 'extract') => {
    if (!customer || busy) return;
    const customerId = customer.id;
    setBusy(action);
    try {
      const result: AIResult = await onAI(action, customerId);
      const current = stateRef.current;
      const currentCustomer = current.customers.find(item => item.id === customerId);
      if (!currentCustomer) return;
      if (action === 'profile') {
        const patch = { summary: result.summary ?? currentCustomer.summary, tags: result.tags ?? currentCustomer.tags, preferences: result.preferences ?? currentCustomer.preferences, budget: result.budget ?? currentCustomer.budget };
        if (!result.summary && !result.tags && !result.preferences && !result.budget) throw new Error('AI 未返回有效画像，请检查模型和画像提示词');
        if (!await onChange({ ...current, customers: current.customers.map(item => item.id === customerId ? { ...item, ...patch } : item) })) return;
        if (selectedRef.current === customerId) { setDraft(draftFor({ ...currentCustomer, ...patch })); setEditing(false); }
        notify('AI 画像已更新，可对照聊天证据核实');
      } else if (action === 'marketing') {
        if (!result.script?.trim()) throw new Error('AI 未返回话术，请检查营销提示词');
        const existingTask = current.tasks.find(task => task.customerId === customerId && task.kind === 'marketing' && task.status === 'todo');
        const tasks = existingTask ? current.tasks.map(task => task.id === existingTask.id ? { ...task, script: result.script!, date: today() } : task) : [...current.tasks, { id: id(), customerId, kind: 'marketing' as const, status: 'todo' as const, priority: 'normal' as const, title: `与${currentCustomer.name}沟通`, date: today(), script: result.script }];
        if (!await onChange({ ...current, tasks })) return;
        if (selectedRef.current === customerId) setScript(result.script);
        notify('专属话术已生成并保存');
      } else {
        const candidates = (result.orders ?? []).filter(order => Number.isFinite(order.amount) && order.amount > 0 && order.description && /^\d{4}-\d{2}-\d{2}$/.test(order.date) && ['sale', 'refund'].includes(order.type));
        const existing = current.orders.filter(order => order.customerId === customerId);
        const seen = new Set(existing.map(order => [order.date, order.amount, order.type, order.evidence].join('|')));
        const unique = candidates.filter(order => { const key = [order.date, order.amount, order.type, order.evidence].join('|'); if (seen.has(key)) return false; seen.add(key); return true; });
        if (!unique.length) { notify(candidates.length ? '这些消费记录已在列表中，无需重复添加' : '未发现新的消费或退款记录'); return; }
        const orders: Order[] = unique.map(order => ({ ...order, id: id(), customerId, status: 'pending' }));
        if (!await onChange({ ...current, orders: [...orders, ...current.orders] })) return; if (selectedRef.current === customerId) setSection('orders'); notify(`发现 ${orders.length} 笔记录，请核实后确认`);
      }
    } catch (error) { notify(error instanceof Error ? error.message : 'AI 请求失败，请检查配置后重试', true); }
    finally { setBusy(null); }
  };

  const saveFollowup = async (date: string) => {
    if (!customer) return;
    const current = stateRef.current;
    const existing = current.tasks.find(task => task.customerId === customer.id && task.kind === 'followup' && task.status === 'todo');
    const tasks = date ? existing ? current.tasks.map(task => task.id === existing.id ? { ...task, date } : task) : [{ id: id(), customerId: customer.id, title: `跟进${customer.name}`, date, kind: 'followup' as const, status: 'todo' as const, priority: 'normal' as const, script: '' }, ...current.tasks] : current.tasks.filter(task => !(task.customerId === customer.id && task.kind === 'followup' && task.status === 'todo'));
    if (!await onChange({ ...current, customers: current.customers.map(item => item.id === customer.id ? { ...item, nextFollowUpAt: date } : item), tasks })) return;
    notify(date ? '下次跟进已加入待办' : '已取消跟进提醒');
  };

  const setOrderStatus = async (orderId: string, status: 'confirmed' | 'rejected') => {
    const current = stateRef.current;
    if (!await onChange({ ...current, orders: current.orders.map(order => order.id === orderId ? { ...order, status } : order) })) return;
    notify(status === 'confirmed' ? '已确认，消费统计已更新' : '已拒绝，不计入消费统计');
  };

  const addOrder = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!customer) return;
    const amount = Number(orderDraft.amount);
    if (!orderDraft.description.trim() || !Number.isFinite(amount) || amount <= 0) { notify('请填写消费项目及大于零的金额', true); return; }
    const current = stateRef.current;
    if (!await onChange({ ...current, orders: [{ id: id(), customerId: customer.id, description: orderDraft.description.trim(), amount, date: orderDraft.date, type: orderDraft.type, status: 'confirmed', evidence: '商家手动录入并确认' }, ...current.orders] })) return;
    setShowOrder(false); setOrderDraft({ description: '', amount: '', date: today(), type: 'sale' }); notify('消费记录已添加');
  };

  const deleteCustomer = async () => {
    if (!customer || replyBusy || !window.confirm(`确定删除“${customer.name}”及其消费记录、聊天证据和待办？此操作无法撤销。`)) return;
    setReplyBusy(true);
    try {
      const current = stateRef.current;
      if (localRepliesAvailable()) {
        let runtime: { running: boolean } | null = null;
        try { runtime = await replyRequest<{ running: boolean }>('/status'); } catch { /* 未连接的本地组件不影响数据整理。 */ }
        if (runtime?.running) await replyRequest('/takeover', { customerId: customer.id, enabled: true });
      }
      const settings = replySettingsFor(current);
      const next = { ...current, customers: current.customers.filter(item => item.id !== customer.id), orders: current.orders.filter(order => order.customerId !== customer.id), tasks: current.tasks.filter(task => task.customerId !== customer.id), replySettings: { ...settings, selectedCustomerIds: settings.selectedCustomerIds.filter(value => value !== customer.id) } };
      if (!await onChange(next)) return;
      if (localRepliesAvailable()) { try { await replyRequest('/config', replyConfigFor(next)); } catch { notify('客户已删除，本机配置同步未确认，请检查自动回复中心', true); onSelect(null); return; } }
      onSelect(null); notify('客户已删除');
    } catch (error) { notify(error instanceof Error ? error.message : '删除失败，请重试', true); }
    finally { setReplyBusy(false); }
  };

  const updateReplyControl = async (patch: { autoReplyEnabled?: boolean; humanTakeover?: boolean }) => {
    if (!customer || replyBusy) return;
    if (customer.source === 'demo' || !customer.wechatId) { notify('请先导入带微信标识的真实私聊，示例客户不参与回复', true); return; }
    setReplyBusy(true);
    try {
      const current = stateRef.current;
      const actual = current.customers.find(item => item.id === customer.id);
      if (!actual) return;
      const settings = replySettingsFor(current);
      if (patch.autoReplyEnabled === true && !settings.selectedCustomerIds.includes(actual.id) && settings.selectedCustomerIds.length >= 500) { notify('本机接待最多选择 500 位客户，请先缩小回复范围', true); return; }
      if (patch.autoReplyEnabled === true && !settings.selectedCustomerIds.includes(actual.id)) settings.selectedCustomerIds = [...settings.selectedCustomerIds, actual.id];
      if (patch.autoReplyEnabled === false) settings.selectedCustomerIds = settings.selectedCustomerIds.filter(value => value !== actual.id);
      const next = { ...current, replySettings: settings, customers: current.customers.map(item => item.id === actual.id ? { ...item, ...patch } : item) };
      // 暂停或接管先作用于本机；恢复必须先确认规则已成功保存。
      if (localRepliesAvailable() && (patch.humanTakeover === true || patch.autoReplyEnabled === false)) {
        const runtime = await replyRequest<{ running: boolean }>('/status');
        if (runtime.running) await replyRequest('/takeover', { customerId: actual.id, enabled: true });
      }
      if (!await onChange(next)) return;
      if (localRepliesAvailable()) {
        try {
          await replyRequest('/config', replyConfigFor(next));
          if (patch.humanTakeover === false || (patch.autoReplyEnabled === true && !actual.humanTakeover)) await replyRequest('/takeover', { customerId: actual.id, enabled: false });
        } catch (error) { notify(`客户规则已保存，本机同步未确认：${error instanceof Error ? error.message : '请检查本地服务'}。未启动新的回复任务。`, true); return; }
      }
      const message = patch.humanTakeover === true ? '已设为人工接管，此客户不会自动发送' : patch.humanTakeover === false ? '已恢复此客户的托管规则' : patch.autoReplyEnabled ? '已允许此客户参与接待' : '已关闭此客户的自动回复';
      notify(localRepliesAvailable() ? `${message}。本机配置已更新，请回自动回复中心确认后启动` : message);
    } catch (error) { notify(error instanceof Error ? error.message : '客户回复规则保存失败', true); }
    finally { setReplyBusy(false); }
  };

  const copyScript = async () => {
    try {
      await navigator.clipboard.writeText(script);
      const current = stateRef.current;
      if (customer) {
        const latest = current.tasks.find(task => task.customerId === customer.id && task.kind === 'marketing' && task.status === 'todo');
        if (latest && !await onChange({ ...current, tasks: current.tasks.map(task => task.id === latest.id ? { ...task, script } : task) })) return;
      }
      notify('话术已复制，可在微信中粘贴发送');
    } catch { notify('复制失败，请手动选择并复制话术', true); }
  };
  const filtered = sortCustomers(state.customers.filter(item => [item.name, item.wechatId, ...item.tags, ...item.manualTags].join(' ').toLowerCase().includes(search.toLowerCase())), sort);
  const selectedStats = customer ? statsFor(state, customer.id) : { total: 0, count: 0 };
  const customerOrders = state.orders.filter(order => order.customerId === selectedId).sort((a, b) => b.date.localeCompare(a.date));
  const pendingCount = customerOrders.filter(order => order.status === 'pending').length;

  return <div className="customers-page">
    <div className="page-heading"><div><h1>客户档案</h1><p className="muted">记住每一位客户，让每一次沟通都有温度。</p></div><div className="button-row"><FileImportButton notify={notify} label="上传文件" onImport={importCustomers} /><button className="btn primary" onClick={() => setShowCreate(true)}><Plus size={17} />新建客户</button></div></div>
    <VoiceProfilePanel state={state} notify={notify} onApply={next => onChange(next)} />
    <div className="card customers-card">
      <div className="customers-toolbar"><div className="search-field"><Search size={17} /><input aria-label="搜索客户" placeholder="搜索姓名、微信号或标签…" value={search} onChange={event => setSearch(event.target.value)} />{search && <button className="icon-button" aria-label="清空搜索" onClick={() => setSearch('')}><X size={14} /></button>}</div><span className="muted small">共 {state.customers.length} 位客户</span></div>
      <div className="customer-sort-bar"><div className="customer-sort-options" role="group" aria-label="客户排序"><span><ArrowUpDown size={15} />排序</span>{([{ value: 'date-asc', label: '日期升序' }, { value: 'date-desc', label: '日期降序' }, { value: 'activity-desc', label: '客户活跃度' }] as const).map(option => <button type="button" className={sort === option.value ? 'active' : ''} aria-pressed={sort === option.value} key={option.value} onClick={() => setSort(option.value)}>{option.label}</button>)}</div><span className="customer-sort-help">{sort === 'activity-desc' ? '按近30天客户消息数，由多到少；相同时最近联系优先' : `按最近联系日期，由${sort === 'date-asc' ? '早到晚' : '晚到早'}；无联系日期的排最后`}</span></div>
      <div className="customer-cards">{filtered.map(item => {
        const stats = statsFor(state, item.id); const overdue = item.nextFollowUpAt && item.nextFollowUpAt <= today();
        const joined = item.createdAt?.slice(0, 10); const isNew = !!joined && joined >= shiftDate(-7);
        const tags = [...item.manualTags, ...item.tags];
        return <button type="button" key={item.id} className="customer-card" style={{ background: `color-mix(in srgb, ${item.color} 7%, #fff)`, borderColor: `color-mix(in srgb, ${item.color} 22%, #fff)` }} onClick={() => onSelect(item.id)}>
          <div className="customer-card-head">
            <span className="customer-card-avatar" style={{ background: `${item.color}1f`, color: item.color }}>{item.name.slice(-2)}</span>
            <div className="customer-card-title"><strong>{item.name}</strong><span className="customer-card-sub">{item.stage} · {SOURCE_LABELS[item.source]}</span></div>
            {isNew && <span className="customer-card-new">新加入</span>}
          </div>
          <div className="customer-card-baby"><BabyBadge baby={item.baby} />{item.baby?.feeding ? <span className="customer-card-baby-extra">{BABY_FEEDING_LABELS[item.baby.feeding]}</span> : null}{item.baby?.allergies?.trim() ? <span className="customer-card-baby-extra warn">过敏注意</span> : null}</div>
          {item.preferences && <p className="customer-card-prefs">{item.preferences}</p>}
          {!!tags.length && <div className="customer-card-tags">{tags.slice(0, 3).map((tag, index) => <span key={`${tag}-${index}`}>{tag}</span>)}</div>}
          <div className="customer-card-foot">
            <span>加入 {joined || '—'}</span>
            <span>{money(stats.total)} · {stats.count} 次</span>
            <span className={overdue ? 'customer-card-due' : ''}>{item.nextFollowUpAt ? `跟进 ${item.nextFollowUpAt.slice(5).replace('-', '/')}` : '未设跟进'}</span>
          </div>
        </button>;
      })}</div>
      {!filtered.length && <div className="empty-state"><Search size={29} /><h3>{state.customers.length ? '没有找到匹配的客户' : '从第一位客户开始'}</h3><p>{state.customers.length ? '试试其他姓名、微信号或标签关键词。' : '新建客户，或在微信导入页面导入聊天记录。'}</p>{!state.customers.length && <button className="btn secondary" onClick={() => setShowCreate(true)}><Plus size={15} />新建客户</button>}</div>}
      {!!filtered.length && <div className="table-footer"><span>显示 {filtered.length} 位客户</span></div>}
    </div>

    {showCreate && <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setShowCreate(false); }}><form className="modal" onSubmit={createCustomer} role="dialog" aria-modal="true" aria-labelledby="create-customer-title"><div className="modal-header"><div><h2 id="create-customer-title">添加一位新客户</h2><p className="muted">先记下基本信息，之后慢慢了解。</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setShowCreate(false)}><X size={20} /></button></div><div className="form-grid"><label className="field">客户称呼 <span className="required">*</span><input className="input" autoFocus required maxLength={30} value={newCustomer.name} onChange={event => setNewCustomer({ ...newCustomer, name: event.target.value })} placeholder="如：林女士" /></label><label className="field">微信号<input className="input" value={newCustomer.wechatId} onChange={event => setNewCustomer({ ...newCustomer, wechatId: event.target.value })} placeholder="选填，方便对应联系人" /></label><label className="field">客户阶段<select className="input" value={newCustomer.stage} onChange={event => setNewCustomer({ ...newCustomer, stage: event.target.value as CustomerStage })}>{STAGES.map(item => <option key={item}>{item}</option>)}</select></label><label className="field">手工标签<input className="input" value={newCustomer.tags} onChange={event => setNewCustomer({ ...newCustomer, tags: event.target.value })} placeholder="用逗号分隔，如：老朋友，周末到店" /></label><label className="field full-width">备注<textarea className="input" rows={3} value={newCustomer.note} onChange={event => setNewCustomer({ ...newCustomer, note: event.target.value })} placeholder="记下值得关注的小细节…" /></label></div><div className="modal-footer"><button className="btn secondary" type="button" onClick={() => setShowCreate(false)}>取消</button><button className="btn primary" type="submit"><Plus size={16} />添加客户</button></div></form></div>}

    {customer && <div className="drawer-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onSelect(null); }}><aside className="drawer customer-drawer" role="dialog" aria-modal="true" aria-label={`${customer.name}的客户档案`}><div className="drawer-topline"><span><span className="muted">客户档案</span><ChevronRight size={13} />{customer.name}</span><button className="icon-button" aria-label="关闭客户档案" onClick={() => onSelect(null)}><X size={21} /></button></div><div className="customer-detail-heading"><span className="avatar large" style={{ background: `${customer.color}18`, color: customer.color }}>{customer.name.slice(-2)}</span><div className="customer-detail-name"><h2>{customer.name}</h2><p className="muted"><MessageCircle size={14} />{customer.wechatId || '未填写微信号'}<span>·</span>{SOURCE_LABELS[customer.source]}</p></div><select className="stage-select" aria-label="客户阶段" value={customer.stage} onChange={async event => { if (await updateCustomer(customer.id, { stage: event.target.value as CustomerStage })) notify('客户阶段已更新'); }}>{STAGES.map(item => <option key={item}>{item}</option>)}</select></div><div className="customer-detail-stats"><div><span>累计净消费</span><strong>{money(selectedStats.total)}</strong></div><div><span>累计购买</span><strong>{selectedStats.count}<small> 次</small></strong></div><div><span>最近沟通</span><strong className="date-stat">{customer.lastContactAt?.slice(0, 10) || '暂无记录'}</strong></div></div><div className="tabs detail-tabs"><button className={`tab ${section === 'profile' ? 'active' : ''}`} onClick={() => setSection('profile')}>客户画像</button><button className={`tab ${section === 'orders' ? 'active' : ''}`} onClick={() => setSection('orders')}>消费记录{pendingCount > 0 && <span className="pending-dot">{pendingCount}</span>}</button><button className={`tab ${section === 'chat' ? 'active' : ''}`} onClick={() => setSection('chat')}>聊天与证据</button></div>
      <div className="drawer-body">
        {section === 'profile' && <>
          <ValueTierCard state={state} customerId={customer.id} />
          <BabyProfileEditor customer={customer} onSave={patch => updateCustomer(customer.id, patch)} notify={notify} />
          <section className="detail-section"><div className="detail-section-heading"><h3><Sparkles size={17} className="purple-icon" />了解这位客户</h3><div className="button-row"><button className="btn ghost sm" disabled={!!busy} onClick={() => runAI('profile')}>{busy === 'profile' ? <Loader2 className="spin" size={14} /> : <Sparkles size={14} />}更新画像</button><button className="icon-button" aria-label={editing ? '取消编辑' : '编辑客户画像'} onClick={() => { setDraft(draftFor(customer)); setEditing(!editing); }}>{editing ? <X size={16} /> : <Pencil size={15} />}</button></div></div>
            {editing && draft ? <div className="profile-editor"><label className="field">客户概况<textarea className="input" rows={3} value={draft.summary} onChange={event => setDraft({ ...draft, summary: event.target.value })} /></label><div className="form-grid"><label className="field">偏好与需求<textarea className="input" rows={2} value={draft.preferences} onChange={event => setDraft({ ...draft, preferences: event.target.value })} /></label><label className="field">预算与消费习惯<textarea className="input" rows={2} value={draft.budget} onChange={event => setDraft({ ...draft, budget: event.target.value })} /></label></div><label className="field">AI 标签<input className="input" value={draft.aiTags} onChange={event => setDraft({ ...draft, aiTags: event.target.value })} placeholder="用逗号分隔" /><small className="muted">AI 更新画像时会替换此组标签。</small></label><label className="field">手工标签<input className="input" value={draft.manualTags} onChange={event => setDraft({ ...draft, manualTags: event.target.value })} placeholder="用逗号分隔" /><small className="muted">手工标签独立保留，AI 不会覆盖。</small></label><label className="field">商家备注<textarea className="input" rows={2} value={draft.note} onChange={event => setDraft({ ...draft, note: event.target.value })} /></label><div className="button-row justify-end"><button className="btn secondary sm" onClick={() => setEditing(false)}>取消</button><button className="btn primary sm" onClick={saveProfile}><Check size={14} />保存档案</button></div></div> : <><p className={`customer-summary ${!customer.summary ? 'muted' : ''}`}>{customer.summary || '还没有客户画像。导入聊天后，可用 AI 提炼有依据的需求与偏好，也可以手动编辑。'}</p><div className="profile-facts"><div><span>偏好与需求</span><p>{customer.preferences || '尚未了解'}</p></div><div><span>预算与消费习惯</span><p>{customer.budget || '尚未了解'}</p></div></div><div className="profile-tag-group"><span><Sparkles size={12} />AI 标签</span><div className="tag-list">{customer.tags.length ? customer.tags.map(tag => <span className="badge purple" key={tag}>{tag}</span>) : <span className="muted small">暂无标签</span>}</div></div><div className="profile-tag-group"><span><Tag size={12} />手工标签</span><div className="tag-list">{customer.manualTags.length ? customer.manualTags.map(tag => <span className="customer-tag" key={tag}>{tag}</span>) : <span className="muted small">暂无标签</span>}</div></div>{customer.note && <div className="merchant-note"><FileText size={15} /><div><span>商家备注</span><p>{customer.note}</p></div></div>}</>}
          </section>
          <section className="detail-section followup-section"><div className="detail-section-heading"><h3><CalendarDays size={17} />下次跟进</h3></div><div className="followup-input-row"><div><p>在合适的时候，打个招呼。</p><span className="muted small">设置后会自动出现在跟进待办中</span></div><input className="input" type="date" aria-label="下次跟进日期" value={customer.nextFollowUpAt?.slice(0, 10) || ''} onChange={event => saveFollowup(event.target.value)} /></div></section>
          <section className="detail-section"><div className="customer-reply-block"><div><h4><Bot size={16} />客户自动回复</h4><p>{customer.source === 'demo' ? '示例客户不会参与真实微信接待。' : !customer.wechatId ? '导入真实微信标识后，才能允许此客户参与接待。' : '开启后加入指定客户范围；总开关、营业时间和本机运行状态仍会共同生效。'}</p></div><label className="reply-switch"><input type="checkbox" aria-label={`允许${customer.name}自动回复`} disabled={replyBusy || customer.source === 'demo' || !customer.wechatId} checked={customer.autoReplyEnabled === true || (customer.autoReplyEnabled !== false && replySettingsFor(state).selectedCustomerIds.includes(customer.id))} onChange={event => { void updateReplyControl({ autoReplyEnabled: event.target.checked }); }} /><span /></label></div>{customer.source !== 'demo' && customer.wechatId && <div className="customer-reply-takeover"><span><Hand size={12} /> {customer.humanTakeover ? '当前为人工接管，不会自动发送' : '重要对话可随时交回人工处理'}</span><button className="reply-link-button" disabled={replyBusy} onClick={() => { void updateReplyControl({ humanTakeover: !customer.humanTakeover }); }}>{replyBusy ? <Loader2 size={12} className="spin" /> : <Hand size={12} />}{customer.humanTakeover ? '恢复托管' : '人工接管'}</button></div>}</section>
          <section className="detail-section script-section"><div className="detail-section-heading"><h3><MessageCircle size={17} className="purple-icon" />为 TA 准备一句话</h3><button className="btn secondary sm" disabled={!!busy} onClick={() => runAI('marketing')}>{busy === 'marketing' ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}{script ? '重新生成' : '生成话术'}</button></div>{script ? <><textarea className="input script-editor" aria-label="营销话术" rows={5} value={script} onChange={event => setScript(event.target.value)} /><div className="script-footer"><span className="muted small">发送前请核对价格、活动及客户需求</span><button className="btn primary sm" onClick={copyScript}><Copy size={14} />复制话术</button></div></> : <div className="script-placeholder"><Sparkles size={23} /><p>结合客户偏好和聊天背景，生成自然的专属话术。</p><span>生成后可编辑、复制，再由你在微信中发送。</span></div>}</section>
        </>}
        {section === 'orders' && <section className="detail-section"><div className="detail-section-heading"><h3><Wallet size={17} />消费记录</h3><div className="button-row"><button className="btn ghost sm" disabled={!!busy} onClick={() => runAI('extract')}>{busy === 'extract' ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}从聊天提取</button><button className="btn secondary sm" onClick={() => setShowOrder(true)}><Plus size={14} />添加记录</button></div></div><p className="muted small">AI 提取的消费记录需经你确认。退款从累计净消费中扣除。</p>{customerOrders.length ? <div className="order-list">{customerOrders.map(order => <div className={`order-item ${order.status === 'rejected' ? 'rejected' : ''}`} key={order.id}><div className={`order-direction ${order.type === 'refund' ? 'refund' : ''}`}>{order.type === 'refund' ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}</div><div className="order-content"><div className="order-title"><strong>{order.description}</strong><span className={order.type === 'refund' ? 'refund-amount' : ''}>{order.type === 'refund' ? '−' : ''}{money(order.amount)}</span></div><div className="order-meta"><span>{order.date}</span><span className={`badge ${order.status === 'pending' ? 'amber' : order.status === 'confirmed' ? 'green' : 'slate'}`}>{order.status === 'pending' ? '待确认' : order.status === 'confirmed' ? '已确认' : '已拒绝'}</span>{order.type === 'refund' && <span>退款</span>}</div>{order.evidence && <p className="order-evidence">“{order.evidence}”</p>}{order.status === 'pending' && <div className="order-actions"><button className="btn secondary sm" onClick={() => setOrderStatus(order.id, 'rejected')}><X size={13} />拒绝</button><button className="btn primary sm" onClick={() => setOrderStatus(order.id, 'confirmed')}><Check size={13} />确认记录</button></div>}</div></div>)}</div> : <div className="empty-state"><Wallet size={28} /><h3>还没有消费记录</h3><p>手动添加一笔，或从已有聊天中提取。</p></div>}</section>}
        {section === 'chat' && <><section className="detail-section"><div className="detail-section-heading"><h3><FileText size={17} />画像依据</h3><span className="muted small">{customer.evidence.length} 条证据</span></div>{customer.evidence.length ? <div className="evidence-list">{customer.evidence.map(item => <div className="evidence-item" key={item.id}><p>“{item.text}”</p><span>{item.date} · {item.source}</span></div>)}</div> : <p className="muted">暂无聊天证据。导入微信记录后可查看。</p>}</section><section className="detail-section"><div className="detail-section-heading"><h3><MessageCircle size={17} />聊天记录</h3><span className="muted small">{customer.messages.length} 条消息</span></div>{customer.messages.length ? <div className="chat-list">{customer.messages.map(message => <div className={`chat-message ${message.sender === 'merchant' ? 'outgoing' : ''}`} key={message.id}><span>{message.sender === 'merchant' ? '我' : customer.name} · {message.date}</span><p>{message.text}</p></div>)}</div> : <div className="empty-state"><MessageCircle size={28} /><p>还没有导入这位客户的聊天记录</p></div>}</section></>}
        <div className="customer-danger-zone"><span className="muted small">创建于 {customer.createdAt?.slice(0, 10)}</span><button className="btn ghost sm danger-text" onClick={deleteCustomer}><Trash2 size={13} />删除客户</button></div>
      </div></aside></div>}

    {showOrder && customer && <div className="modal-overlay order-modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setShowOrder(false); }}><form className="modal" onSubmit={addOrder} role="dialog" aria-modal="true" aria-labelledby="add-order-title"><div className="modal-header"><h2 id="add-order-title">添加消费记录</h2><button className="icon-button" aria-label="关闭" type="button" onClick={() => setShowOrder(false)}><X size={20} /></button></div><div className="form-grid"><label className="field full-width">消费项目<input className="input" required autoFocus value={orderDraft.description} onChange={event => setOrderDraft({ ...orderDraft, description: event.target.value })} placeholder="如：春季护理套餐" /></label><label className="field">类型<select className="input" value={orderDraft.type} onChange={event => setOrderDraft({ ...orderDraft, type: event.target.value as 'sale' | 'refund' })}><option value="sale">消费</option><option value="refund">退款</option></select></label><label className="field">金额（元）<input className="input" type="number" required min="0.01" step="0.01" value={orderDraft.amount} onChange={event => setOrderDraft({ ...orderDraft, amount: event.target.value })} placeholder="0.00" /></label><label className="field full-width">日期<input className="input" type="date" required value={orderDraft.date} onChange={event => setOrderDraft({ ...orderDraft, date: event.target.value })} /></label></div><p className="muted small">手动添加即表示你已核实，将直接计入消费统计。</p><div className="modal-footer"><button type="button" className="btn secondary" onClick={() => setShowOrder(false)}>取消</button><button className="btn primary" type="submit"><Check size={15} />确认添加</button></div></form></div>}
  </div>;
}
