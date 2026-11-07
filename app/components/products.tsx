'use client';

import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Clock3, HelpCircle, Loader2, Package, Pencil, Plus, Search, Sparkles, Trash2, X } from 'lucide-react';
import type { AppState, Product, SharedProps } from '../../lib/types';
import { localRepliesAvailable, replyConfigFor, replyRequest, replySettingsFor, WEEKDAYS } from './reply-ui';

type FAQ = { question: string; answer: string };
type ProductDraft = { id: string; name: string; type: 'product' | 'service'; price: string; description: string; faq: FAQ[]; enabled: boolean };
const blankProduct = (): ProductDraft => ({ id: '', name: '', type: 'product', price: '', description: '', faq: [], enabled: true });
const cleanFaq = (items: FAQ[]) => items.map(item => ({ question: item.question.trim(), answer: item.answer.trim() })).filter(item => item.question || item.answer);

export default function Products({ state, onChange, notify }: SharedProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'product' | 'service'>('all');
  const [editor, setEditor] = useState<ProductDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingInfo, setSavingInfo] = useState(false);
  const [businessHours, setBusinessHours] = useState(() => replySettingsFor(state).businessHours);
  const [faq, setFaq] = useState<FAQ[]>(() => replySettingsFor(state).faq);
  const stateRef = useRef(state);
  const products = state.products ?? [];
  const visible = products.filter(item => (filter === 'all' || item.type === filter) && `${item.name} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()));

  const persistKnowledge = async (next: AppState, message: string) => {
    // 更新资料时先暂停本机运行，避免队列继续使用修改前的知识。
    let paused = false;
    if (localRepliesAvailable()) {
      let runtime: { running: boolean } | null = null;
      try { runtime = await replyRequest<{ running: boolean }>('/status'); }
      catch { /* 本地组件未启用时，仍可保存经营资料。 */ }
      if (runtime?.running) {
        try { await replyRequest('/pause', {}); paused = true; }
        catch { notify('未能暂停正在运行的本机接待，资料尚未修改，请先核对本地服务', true); return false; }
      }
    }
    if (!await onChange(next)) return false;
    if (localRepliesAvailable()) {
      try { await replyRequest('/config', replyConfigFor(next)); }
      catch (error) { notify(`${message}，但本机知识同步未确认：${error instanceof Error ? error.message : '请检查本地组件'}`, true); return true; }
    }
    notify(paused ? `${message}，本地接待已暂停，请回自动回复中心确认后启动` : message);
    return true;
  };

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => {
    if (!editor) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) setEditor(null); };
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey);
  }, [editor, saving]);

  const openProduct = (product?: Product) => setEditor(product ? { ...product, price: product.price === null ? '' : String(product.price), faq: product.faq.map(item => ({ ...item })) } : blankProduct());
  const saveProduct = async (event: React.FormEvent) => {
    event.preventDefault(); if (!editor || saving) return;
    const price = editor.price.trim() ? Number(editor.price) : null;
    if (!editor.name.trim() || !editor.description.trim()) { notify('请填写名称和真实商品或服务说明', true); return; }
    if (price !== null && (!Number.isFinite(price) || price < 0 || price > 10_000_000)) { notify('价格需为有效的非负金额，留空表示需要人工报价', true); return; }
    const nextFaq = cleanFaq(editor.faq);
    if (nextFaq.some(item => !item.question || !item.answer)) { notify('请补全每条 FAQ 的问题和答案，或移除空白项', true); return; }
    setSaving(true);
    try {
      const latest = stateRef.current;
      const product: Product = { ...editor, id: editor.id || crypto.randomUUID(), name: editor.name.trim(), description: editor.description.trim(), price, faq: nextFaq };
      const current = latest.products ?? [];
      if (!editor.id && current.length >= 100) throw new Error('最多保存 100 项商品与服务，请先整理已有资料');
      const success = await persistKnowledge({ ...latest, products: editor.id ? current.map(item => item.id === editor.id ? product : item) : [...current, product] }, '商品与服务资料已保存');
      if (success) setEditor(null);
    } catch (error) { notify(error instanceof Error ? error.message : '资料保存失败', true); }
    finally { setSaving(false); }
  };

  const toggleProduct = async (product: Product) => {
    if (saving) return; setSaving(true);
    try { const latest = stateRef.current; await persistKnowledge({ ...latest, products: (latest.products ?? []).map(item => item.id === product.id ? { ...item, enabled: !item.enabled } : item) }, product.enabled ? '已停用此资料，后续回复将不再引用' : '此资料已启用'); }
    finally { setSaving(false); }
  };
  const deleteProduct = async (product: Product) => {
    if (saving || !window.confirm(`删除“${product.name}”的资料？已产生的回复记录会保留。`)) return;
    setSaving(true);
    try { const latest = stateRef.current; await persistKnowledge({ ...latest, products: (latest.products ?? []).filter(item => item.id !== product.id) }, '资料已删除'); }
    finally { setSaving(false); }
  };
  const saveBusinessInfo = async () => {
    if (savingInfo) return;
    if (businessHours.enabled && (!businessHours.days.length || !/^\d{2}:\d{2}$/.test(businessHours.start) || !/^\d{2}:\d{2}$/.test(businessHours.end) || businessHours.start >= businessHours.end)) { notify('请选择营业日，并设置开始时间早于结束时间的营业时段', true); return; }
    const nextFaq = cleanFaq(faq);
    if (nextFaq.some(item => !item.question || !item.answer)) { notify('请补全店铺 FAQ 的问题和答案', true); return; }
    setSavingInfo(true);
    try { const latest = stateRef.current; await persistKnowledge({ ...latest, replySettings: { ...replySettingsFor(latest), businessHours, faq: nextFaq } }, '营业时间与店铺 FAQ 已保存'); }
    finally { setSavingInfo(false); }
  };

  return <div className="reply-knowledge-page"><div className="reply-knowledge-intro"><div><span className="reply-eyebrow">服务知识库</span><h2>把真实资料准备好，回复才有依据</h2><p>启用的商品、服务及 FAQ 会用于生成客户回复。价格不确定时可以留空，由人工确认。</p></div><button className="btn primary" onClick={() => openProduct()}><Plus size={16} />新增资料</button></div>
    <div className="reply-knowledge-layout"><div className="reply-knowledge-main"><div className="reply-knowledge-stats"><div><Package size={18} /><span>商品资料<strong>{products.filter(item => item.type === 'product').length}</strong></span></div><div><Sparkles size={18} /><span>服务项目<strong>{products.filter(item => item.type === 'service').length}</strong></span></div><div><BookOpen size={18} /><span>已启用<strong>{products.filter(item => item.enabled).length}</strong></span></div></div><section className="card reply-product-list"><div className="reply-product-toolbar"><div className="tabs">{[{ id: 'all', label: '全部资料' }, { id: 'product', label: '商品' }, { id: 'service', label: '服务' }].map(item => <button key={item.id} className={`tab ${filter === item.id ? 'active' : ''}`} onClick={() => setFilter(item.id as typeof filter)}>{item.label}</button>)}</div><div className="reply-search"><Search size={15} /><input aria-label="搜索商品或服务" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称或描述" /></div></div>{visible.length ? <div className="reply-products-grid">{visible.map(product => <article key={product.id} className={`reply-product-card ${product.enabled ? '' : 'disabled'}`}><div className="reply-product-top"><span className={`reply-product-icon ${product.type}`}>{product.type === 'service' ? <Sparkles size={20} /> : <Package size={20} />}</span><span className={`badge ${product.enabled ? 'green' : 'slate'}`}>{product.enabled ? '已启用' : '已停用'}</span><div><button className="icon-button" aria-label={`编辑${product.name}`} onClick={() => openProduct(product)}><Pencil size={14} /></button><button className="icon-button danger-text" disabled={saving} aria-label={`删除${product.name}`} onClick={() => { void deleteProduct(product); }}><Trash2 size={14} /></button></div></div><span className="reply-product-kind">{product.type === 'service' ? '服务项目' : '商品'}</span><h3>{product.name}</h3><strong className="reply-product-price">{product.price === null ? <small>需要人工报价</small> : `¥${product.price.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`}</strong><p className="reply-product-description">{product.description}</p><div className="reply-product-footer"><span><HelpCircle size={12} />{product.faq.length} 条 FAQ</span><button className="reply-link-button" disabled={saving} onClick={() => { void toggleProduct(product); }}>{product.enabled ? '停用资料' : '启用资料'}</button></div></article>)}</div> : <div className="empty-state"><Package size={29} /><h3>{products.length ? '没有找到匹配资料' : '先添加一项真实商品或服务'}</h3><p>{products.length ? '试试其他关键词。' : '描述服务内容、实际价格和常见问题，AI 才能准确回应客户。'}</p>{!products.length && <button className="btn secondary" onClick={() => openProduct()}><Plus size={14} />添加第一项资料</button>}</div>}</section></div>
    <aside className="reply-business-aside"><section className="card reply-business-card"><div className="reply-card-title"><Clock3 size={18} /><h3>营业时间</h3><label className="reply-switch"><input aria-label="仅在营业时间自动回复" type="checkbox" checked={businessHours.enabled} onChange={event => setBusinessHours({ ...businessHours, enabled: event.target.checked })} /><span /></label></div><p>启用后，仅在以下时段运行自动回复。使用北京时间。</p><div className="reply-weekdays">{WEEKDAYS.map(day => <button key={day.value} className={businessHours.days.includes(day.value) ? 'active' : ''} onClick={() => setBusinessHours({ ...businessHours, days: businessHours.days.includes(day.value) ? businessHours.days.filter(value => value !== day.value) : [...businessHours.days, day.value] })}>{day.label}</button>)}</div><div className="reply-time-range"><input className="input" aria-label="营业开始时间" type="time" value={businessHours.start} onChange={event => setBusinessHours({ ...businessHours, start: event.target.value })} /><span>至</span><input className="input" aria-label="营业结束时间" type="time" value={businessHours.end} onChange={event => setBusinessHours({ ...businessHours, end: event.target.value })} /></div><div className="reply-faq-heading"><h3><HelpCircle size={16} />店铺 FAQ</h3><button className="reply-link-button" disabled={faq.length >= 20} onClick={() => setFaq([...faq, { question: '', answer: '' }])}><Plus size={12} />新增</button></div>{faq.length ? <div className="reply-shop-faq">{faq.map((item, index) => <div key={index} className="reply-faq-editor"><div><span>问题 {index + 1}</span><button className="icon-button" aria-label={`移除店铺问题${index + 1}`} onClick={() => setFaq(faq.filter((_, current) => current !== index))}><X size={13} /></button></div><input className="input" maxLength={200} aria-label={`店铺问题${index + 1}`} value={item.question} onChange={event => setFaq(faq.map((value, current) => current === index ? { ...value, question: event.target.value } : value))} placeholder="如：如何预约到店？" /><textarea className="input" maxLength={2000} aria-label={`店铺答案${index + 1}`} rows={3} value={item.answer} onChange={event => setFaq(faq.map((value, current) => current === index ? { ...value, answer: event.target.value } : value))} placeholder="填写已确认的安排与说明" /></div>)}</div> : <div className="reply-faq-empty">添加地址、预约方式、配送与售后等真实说明。</div>}<button className="btn primary reply-full-width" disabled={savingInfo} onClick={() => { void saveBusinessInfo(); }}>{savingInfo ? <Loader2 className="spin" size={15} /> : <Check size={15} />}保存经营信息</button></section><div className="reply-knowledge-note"><BookOpen size={17} /><p>云端可管理知识和规则。实际微信读取与发送需要在本机运行客序，开启后才会执行。</p></div></aside></div>
    {editor && <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !saving) setEditor(null); }}><form className="modal reply-product-modal" role="dialog" aria-modal="true" aria-labelledby="product-editor-title" onSubmit={saveProduct}><div className="modal-heading"><div><h2 id="product-editor-title">{editor.id ? '编辑资料' : '新增商品与服务'}</h2><p>只填写实际可提供的内容，避免生成未经确认的承诺。</p></div><button className="icon-button" type="button" disabled={saving} aria-label="关闭资料编辑" onClick={() => setEditor(null)}><X size={18} /></button></div><div className="form-grid"><label className="field">类型<select className="input" value={editor.type} onChange={event => setEditor({ ...editor, type: event.target.value as ProductDraft['type'] })}><option value="product">商品</option><option value="service">服务项目</option></select></label><label className="field">名称<input className="input" required autoFocus maxLength={100} value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} placeholder="真实商品或服务名称" /></label></div><label className="field">价格（元）<input className="input" type="number" min={0} max={10000000} step="0.01" value={editor.price} onChange={event => setEditor({ ...editor, price: event.target.value })} placeholder="不确定时留空，由人工报价" /></label><label className="field">商品或服务说明<textarea className="input" required rows={4} maxLength={4000} value={editor.description} onChange={event => setEditor({ ...editor, description: event.target.value })} placeholder="填写适用场景、规格、服务范围、预约条件等已确认信息" /></label><div className="reply-faq-heading"><h3><HelpCircle size={16} />此项目的常见问题</h3><button className="reply-link-button" type="button" disabled={editor.faq.length >= 20} onClick={() => setEditor({ ...editor, faq: [...editor.faq, { question: '', answer: '' }] })}><Plus size={12} />新增 FAQ</button></div><div className="reply-modal-faq">{editor.faq.map((item, index) => <div className="reply-faq-editor" key={index}><div><span>问题 {index + 1}</span><button className="icon-button" type="button" aria-label={`移除问题${index + 1}`} onClick={() => setEditor({ ...editor, faq: editor.faq.filter((_, current) => current !== index) })}><X size={13} /></button></div><input className="input" maxLength={200} aria-label={`项目问题${index + 1}`} placeholder="客户可能问什么？" value={item.question} onChange={event => setEditor({ ...editor, faq: editor.faq.map((value, current) => current === index ? { ...value, question: event.target.value } : value) })} /><textarea className="input" maxLength={2000} rows={2} aria-label={`项目答案${index + 1}`} placeholder="填写准确答案" value={item.answer} onChange={event => setEditor({ ...editor, faq: editor.faq.map((value, current) => current === index ? { ...value, answer: event.target.value } : value) })} /></div>)}</div><label className="checkbox-label"><input type="checkbox" checked={editor.enabled} onChange={event => setEditor({ ...editor, enabled: event.target.checked })} />启用此资料，允许客户回复引用</label><div className="modal-actions"><button className="btn secondary" type="button" disabled={saving} onClick={() => setEditor(null)}>取消</button><button className="btn primary" disabled={saving}>{saving ? <Loader2 size={15} className="spin" /> : <Check size={15} />}保存资料</button></div></form></div>}
  </div>;
}
