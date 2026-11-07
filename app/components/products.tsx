'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, Clock3, HelpCircle, Loader2, Package, Pencil, Plus, Search, Sparkles, Store, Trash2, X } from 'lucide-react';
import type { AppState, Product, SharedProps } from '../../lib/types';
import { DEFAULT_RESTOCK_THRESHOLD, isProductLowStock, selectCatalogProducts, type CatalogFilter, type CatalogSort } from '../../lib/product-catalog';
import { loadSavedReplyConfig, localRepliesAvailable, replyRequest, replySettingsFor, WEEKDAYS } from './reply-ui';
import { assertWorkspaceCurrent, captureWorkspace } from '../../lib/client-workspace';
import { buildWelcomeMessage, MAX_WELCOME_LENGTH, welcomeMessageError, welcomeSettingsFor } from './welcome-message';
import './products.css';

type FAQ = { question: string; answer: string };
type ProductDraft = { id: string; name: string; type: 'product' | 'service'; price: string; stock: string; restockThreshold: string; description: string; faq: FAQ[]; enabled: boolean; needsRestock: boolean };
const blankProduct = (): ProductDraft => ({ id: '', name: '', type: 'product', price: '', stock: '', restockThreshold: String(DEFAULT_RESTOCK_THRESHOLD), description: '', faq: [], enabled: true, needsRestock: false });
const cleanFaq = (items: FAQ[]) => items.map(item => ({ question: item.question.trim(), answer: item.answer.trim() })).filter(item => item.question || item.answer);

export default function Products({ state, onChange, notify }: SharedProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CatalogFilter>('all');
  const [sort, setSort] = useState<CatalogSort>('default');
  const [editor, setEditor] = useState<ProductDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingInfo, setSavingInfo] = useState(false);
  const [businessHours, setBusinessHours] = useState(() => replySettingsFor(state).businessHours);
  const [storeInfo, setStoreInfo] = useState(() => ({ phone: '', address: '', serviceContent: '', ...state.replySettings?.storeInfo, contactName: state.replySettings?.storeInfo?.contactName ?? '' }));
  const [welcome, setWelcome] = useState(() => welcomeSettingsFor(state.replySettings));
  const stateRef = useRef(state);
  const products = state.products ?? [];
  const visible = selectCatalogProducts(products, { filter, sort, query });

  const persistKnowledge = async (next: AppState, message: string) => {
    const expected = captureWorkspace();
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
    assertWorkspaceCurrent(expected);
    if (!await onChange(next)) return false;
    assertWorkspaceCurrent(expected);
    if (localRepliesAvailable()) {
      try { await replyRequest('/config', await loadSavedReplyConfig()); assertWorkspaceCurrent(expected); }
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

  const openProduct = (product?: Product) => setEditor(product ? { ...product, price: product.price === null ? '' : String(product.price), stock: product.stock == null ? '' : String(product.stock), restockThreshold: String(product.restockThreshold ?? DEFAULT_RESTOCK_THRESHOLD), faq: product.faq.map(item => ({ ...item })), needsRestock: product.type === 'product' && product.needsRestock === true } : blankProduct());
  const saveProduct = async (event: React.FormEvent) => {
    event.preventDefault(); if (!editor || saving || savingInfo) return;
    const price = editor.price.trim() ? Number(editor.price) : null;
    const stock = editor.type === 'product' && editor.stock.trim() ? Number(editor.stock) : null;
    const restockThreshold = editor.restockThreshold.trim() ? Number(editor.restockThreshold) : DEFAULT_RESTOCK_THRESHOLD;
    if (!editor.name.trim() || !editor.description.trim()) { notify('请填写名称和真实商品或服务说明', true); return; }
    if (price !== null && (!Number.isFinite(price) || price < 0 || price > 10_000_000)) { notify('价格需为有效的非负金额，留空表示需要人工报价', true); return; }
    if (editor.type === 'product' && ((stock !== null && (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000_000)) || !Number.isInteger(restockThreshold) || restockThreshold < 0 || restockThreshold > 1_000_000_000)) { notify('库存和补货提醒值需为 0 至 10 亿的整数，库存可留空', true); return; }
    const nextFaq = cleanFaq(editor.faq);
    if (nextFaq.some(item => !item.question || !item.answer)) { notify('请补全每条 FAQ 的问题和答案，或移除空白项', true); return; }
    setSaving(true);
    try {
      const latest = stateRef.current;
      const product: Product = { ...editor, id: editor.id || crypto.randomUUID(), name: editor.name.trim(), description: editor.description.trim(), price, stock: editor.type === 'product' ? stock : undefined, restockThreshold: editor.type === 'product' ? restockThreshold : undefined, faq: nextFaq, needsRestock: editor.type === 'product' && editor.needsRestock };
      const current = latest.products ?? [];
      if (!editor.id && current.length >= 100) throw new Error('最多保存 100 项商品与服务，请先整理已有资料');
      const success = await persistKnowledge({ ...latest, products: editor.id ? current.map(item => item.id === editor.id ? product : item) : [...current, product] }, '商品与服务资料已保存');
      if (success) setEditor(null);
    } catch (error) { notify(error instanceof Error ? error.message : '资料保存失败', true); }
    finally { setSaving(false); }
  };

  const deleteProduct = async (product: Product) => {
    if (saving || savingInfo || !window.confirm(`删除“${product.name}”的资料？已产生的回复记录会保留。`)) return;
    setSaving(true);
    try { const latest = stateRef.current; await persistKnowledge({ ...latest, products: (latest.products ?? []).filter(item => item.id !== product.id) }, '资料已删除'); }
    catch (error) { notify(error instanceof Error ? error.message : '资料删除失败', true); }
    finally { setSaving(false); }
  };
  const saveBusinessInfo = async () => {
    if (savingInfo || saving) return;
    if (businessHours.enabled && (!businessHours.days.length || !/^\d{2}:\d{2}$/.test(businessHours.start) || !/^\d{2}:\d{2}$/.test(businessHours.end) || businessHours.start >= businessHours.end)) { notify('请选择营业日，并设置开始时间早于结束时间的营业时段', true); return; }
    const nextInfo = { contactName: storeInfo.contactName.trim(), phone: storeInfo.phone.trim(), address: storeInfo.address.trim(), serviceContent: storeInfo.serviceContent.trim() };
    if (nextInfo.contactName.length > 80 || nextInfo.phone.length > 80 || nextInfo.address.length > 500 || nextInfo.serviceContent.length > 2000) { notify('请缩短店铺基础信息后再保存', true); return; }
    const welcomeError = welcomeMessageError(welcome.enabled, welcome.message);
    if (welcomeError) { notify(welcomeError, true); return; }
    setSavingInfo(true);
    try {
      const latest = stateRef.current;
      // 只更新直接填写的信息及欢迎语，已有店铺FAQ和当前客户名单继续保留。
      await persistKnowledge({ ...latest, replySettings: { ...replySettingsFor(latest), businessHours, storeInfo: nextInfo, welcomeEnabled: welcome.enabled, welcomeMessage: welcome.message.trim() } }, '店铺基础信息与欢迎语已保存');
    } catch (error) { notify(error instanceof Error ? error.message : '店铺基础信息保存失败', true); }
    finally { setSavingInfo(false); }
  };

  return <div className="reply-knowledge-page"><div className="reply-product-actions"><button className="btn primary" disabled={saving || savingInfo} onClick={() => openProduct()}><Plus size={16} />新增商品或服务</button></div>
    <div className="reply-knowledge-layout"><div className="reply-knowledge-main"><div className="reply-knowledge-stats"><div><Package size={18} /><span>商品资料<strong>{products.filter(item => item.type === 'product').length}</strong></span></div><div><Sparkles size={18} /><span>服务项目<strong>{products.filter(item => item.type === 'service').length}</strong></span></div><div><AlertCircle size={18} /><span>待补货商品<strong>{products.filter(isProductLowStock).length}</strong></span></div></div><section className="card reply-product-list"><div className="reply-product-toolbar"><div className="tabs">{[{ id: 'all', label: '全部资料' }, { id: 'product', label: '商品' }, { id: 'service', label: '服务' }, { id: 'restock', label: '待补货商品' }].map(item => <button key={item.id} className={`tab ${filter === item.id ? 'active' : ''}`} onClick={() => setFilter(item.id as typeof filter)}>{item.label}</button>)}</div><div className="reply-product-tools"><select className="input reply-product-sort" aria-label="商品排序" value={sort} onChange={event => setSort(event.target.value as CatalogSort)}><option value="default">默认排序</option><option value="stock-asc">库存量从少到多</option><option value="stock-desc">库存量从多到少</option><option value="price-asc">价格从低到高</option><option value="price-desc">价格从高到低</option></select><div className="reply-search"><Search size={15} /><input aria-label="搜索商品或服务" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称或描述" /></div></div></div>{visible.length ? <div className="reply-products-grid">{visible.map(product => <article key={product.id} className={`reply-product-card ${product.enabled ? '' : 'disabled'}`}><div className="reply-product-top"><span className={`reply-product-icon ${product.type}`}>{product.type === 'service' ? <Sparkles size={20} /> : <Package size={20} />}</span><span className={`badge ${product.enabled ? 'green' : 'slate'}`}>{product.enabled ? '已启用' : '已停用'}</span>{isProductLowStock(product) && <span className="reply-product-restock">待补货</span>}<div><button className="icon-button" disabled={saving || savingInfo} aria-label={`编辑${product.name}`} onClick={() => openProduct(product)}><Pencil size={14} /></button><button className="icon-button danger-text" disabled={saving || savingInfo} aria-label={`删除${product.name}`} onClick={() => { void deleteProduct(product); }}><Trash2 size={14} /></button></div></div><span className="reply-product-kind">{product.type === 'service' ? '服务项目' : '商品'}</span><h3>{product.name}</h3><strong className="reply-product-price">{product.price === null ? <small>需要人工报价</small> : `¥${product.price.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`}</strong>{product.type === 'product' && <p className="reply-product-stock">库存：{product.stock == null ? '未填写' : product.stock.toLocaleString('zh-CN')}</p>}<p className="reply-product-description">{product.description}</p></article>)}</div> : <div className="empty-state"><Package size={29} /><h3>{products.length ? '没有找到匹配资料' : '先添加一项真实商品或服务'}</h3><p>{products.length ? '试试其他关键词。' : '描述服务内容、实际价格和常见问题，AI 才能准确回应客户。'}</p>{!products.length && <button className="btn secondary" onClick={() => openProduct()}><Plus size={14} />新增商品或服务</button>}</div>}</section></div>
    <aside className="reply-business-aside"><section className="card reply-business-card reply-store-information"><div className="reply-card-title"><Store size={18} /><h3>店铺基础信息</h3></div>
      <form onSubmit={event => { event.preventDefault(); void saveBusinessInfo(); }}><fieldset className="reply-store-fields" disabled={savingInfo || saving}>
        <label className="field">联系人姓名<input className="input" maxLength={80} aria-label="店铺联系人姓名" value={storeInfo.contactName} onChange={event => setStoreInfo({ ...storeInfo, contactName: event.target.value })} placeholder="填写联系人姓名" /></label>
        <label className="field">电话<input className="input" type="tel" maxLength={80} aria-label="店铺电话" value={storeInfo.phone} onChange={event => setStoreInfo({ ...storeInfo, phone: event.target.value })} placeholder="填写实际联系电话" /></label>
        <label className="field">地址<textarea className="input" rows={2} maxLength={500} aria-label="店铺地址" value={storeInfo.address} onChange={event => setStoreInfo({ ...storeInfo, address: event.target.value })} placeholder="填写实际门店或服务地址" /></label>
        <div className="reply-store-hours"><div className="reply-store-hours-heading"><h4><Clock3 size={15} />营业时间</h4><label className="reply-switch"><input aria-label="仅在营业时间自动回复" type="checkbox" checked={businessHours.enabled} onChange={event => setBusinessHours({ ...businessHours, enabled: event.target.checked })} /><span /></label></div><p>{businessHours.enabled ? '按北京时间执行，仅在所选营业时段自动回复。' : '当前不限制自动回复时段，可填写并启用营业时间。'}</p><div className="reply-weekdays">{WEEKDAYS.map(day => <button type="button" key={day.value} className={businessHours.days.includes(day.value) ? 'active' : ''} onClick={() => setBusinessHours({ ...businessHours, days: businessHours.days.includes(day.value) ? businessHours.days.filter(value => value !== day.value) : [...businessHours.days, day.value] })}>{day.label}</button>)}</div><div className="reply-time-range"><input className="input" aria-label="营业开始时间" type="time" value={businessHours.start} onChange={event => setBusinessHours({ ...businessHours, start: event.target.value })} /><span>至</span><input className="input" aria-label="营业结束时间" type="time" value={businessHours.end} onChange={event => setBusinessHours({ ...businessHours, end: event.target.value })} /></div></div>
        <label className="field">服务内容<textarea className="input" rows={5} maxLength={2000} aria-label="店铺服务内容" value={storeInfo.serviceContent} onChange={event => setStoreInfo({ ...storeInfo, serviceContent: event.target.value })} placeholder="填写服务范围、预约方式和到店说明等实际信息" /></label>
        <div className="reply-store-welcome"><div className="reply-store-welcome-heading"><h4>首次添加欢迎语</h4><label className="reply-switch"><input type="checkbox" aria-label="启用首次添加欢迎语" checked={welcome.enabled} onChange={event => setWelcome(current => ({ ...current, enabled: event.target.checked }))} /><span /></label></div><label className="field"><span className="sr-only">首次添加欢迎语内容</span><textarea className="input" rows={6} maxLength={MAX_WELCOME_LENGTH} value={welcome.message} aria-label="首次添加欢迎语内容" aria-invalid={!!welcomeMessageError(welcome.enabled, welcome.message)} onChange={event => setWelcome(current => ({ ...current, message: event.target.value }))} placeholder="填写店铺介绍和首次欢迎内容" /></label><div className="reply-store-welcome-actions"><button className="btn secondary sm" type="button" onClick={() => setWelcome(current => ({ ...current, message: buildWelcomeMessage({ storeName: stateRef.current.settings.storeName, ...storeInfo, businessHours }) }))}><Sparkles size={13} />根据店铺信息生成</button><span>{welcome.message.length}/{MAX_WELCOME_LENGTH}</span></div>{welcomeMessageError(welcome.enabled, welcome.message) && <p className="reply-store-welcome-error" role="alert">{welcomeMessageError(welcome.enabled, welcome.message)}</p>}</div>
        <button className="btn primary reply-full-width" type="submit">{savingInfo ? <Loader2 className="spin" size={15} /> : <Check size={15} />}保存店铺基础信息</button>
      </fieldset></form></section></aside></div>
    {editor && <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !saving) setEditor(null); }}><form className="modal reply-product-modal" role="dialog" aria-modal="true" aria-labelledby="product-editor-title" onSubmit={saveProduct}><fieldset className="reply-product-editor-fields" disabled={saving}><div className="modal-heading"><div><h2 id="product-editor-title">{editor.id ? '编辑资料' : '新增商品或服务'}</h2><p>只填写实际可提供的内容，避免生成未经确认的承诺。</p></div><button className="icon-button" type="button" disabled={saving} aria-label="关闭资料编辑" onClick={() => setEditor(null)}><X size={18} /></button></div><div className="form-grid"><label className="field">类型<select className="input" value={editor.type} onChange={event => setEditor({ ...editor, type: event.target.value as ProductDraft['type'] })}><option value="product">商品</option><option value="service">服务项目</option></select></label><label className="field">名称<input className="input" required autoFocus maxLength={100} value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} placeholder="真实商品或服务名称" /></label></div><label className="field">价格（元）<input className="input" type="number" min={0} max={10000000} step="0.01" value={editor.price} onChange={event => setEditor({ ...editor, price: event.target.value })} placeholder="不确定时留空，由人工报价" /></label>{editor.type === 'product' && <div className="form-grid reply-product-stock-fields"><label className="field">库存量<input className="input" type="number" min={0} max={1000000000} step={1} aria-label="商品库存量" value={editor.stock} onChange={event => setEditor({ ...editor, stock: event.target.value })} placeholder="未知时留空" /></label><label className="field">补货提醒值<input className="input" type="number" min={0} max={1000000000} step={1} aria-label="商品补货提醒值" value={editor.restockThreshold} onChange={event => setEditor({ ...editor, restockThreshold: event.target.value })} placeholder={String(DEFAULT_RESTOCK_THRESHOLD)} /><small>库存不高于此值时列入待补货商品</small></label></div>}<label className="field">商品或服务说明<textarea className="input" required rows={4} maxLength={4000} value={editor.description} onChange={event => setEditor({ ...editor, description: event.target.value })} placeholder="填写适用场景、规格、服务范围、预约条件等已确认信息" /></label><div className="reply-faq-heading"><h3><HelpCircle size={16} />此项目的常见问题</h3><button className="reply-link-button" type="button" disabled={editor.faq.length >= 20} onClick={() => setEditor({ ...editor, faq: [...editor.faq, { question: '', answer: '' }] })}><Plus size={12} />新增 FAQ</button></div><div className="reply-modal-faq">{editor.faq.map((item, index) => <div className="reply-faq-editor" key={index}><div><span>问题 {index + 1}</span><button className="icon-button" type="button" aria-label={`移除问题${index + 1}`} onClick={() => setEditor({ ...editor, faq: editor.faq.filter((_, current) => current !== index) })}><X size={13} /></button></div><input className="input" maxLength={200} aria-label={`项目问题${index + 1}`} placeholder="客户可能问什么？" value={item.question} onChange={event => setEditor({ ...editor, faq: editor.faq.map((value, current) => current === index ? { ...value, question: event.target.value } : value) })} /><textarea className="input" maxLength={2000} rows={2} aria-label={`项目答案${index + 1}`} placeholder="填写准确答案" value={item.answer} onChange={event => setEditor({ ...editor, faq: editor.faq.map((value, current) => current === index ? { ...value, answer: event.target.value } : value) })} /></div>)}</div>{editor.type === 'product' && <label className="checkbox-label"><input type="checkbox" checked={editor.needsRestock} onChange={event => setEditor({ ...editor, needsRestock: event.target.checked })} />手动标记待补货</label>}<label className="checkbox-label"><input type="checkbox" checked={editor.enabled} onChange={event => setEditor({ ...editor, enabled: event.target.checked })} />启用此资料，允许客户回复引用</label><div className="modal-actions"><button className="btn secondary" type="button" disabled={saving} onClick={() => setEditor(null)}>取消</button><button className="btn primary" disabled={saving}>{saving ? <Loader2 size={15} className="spin" /> : <Check size={15} />}保存资料</button></div></fieldset></form></div>}
  </div>;
}
