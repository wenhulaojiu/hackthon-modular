'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Database, Eye, EyeOff, KeyRound, Loader2, RotateCcw, Save, ShieldCheck, SlidersHorizontal, Sparkles, Store, Trash2, Unplug } from 'lucide-react';
import type { Settings as StoreSettings, SettingsProps } from '../../lib/types';

const DEFAULT_PROMPTS = {
  profilePrompt: '你是商家的客户洞察助手。请根据提供的客户聊天记录生成有证据支持的客户画像。只使用聊天中明确提及的信息，不要猜测职业、收入、健康或其他敏感属性。信息不足时标记为未知。返回 JSON：summary（客户概况）、tags（需求及偏好标签数组）、preferences（产品与服务偏好）、budget（明确表达的预算或消费习惯）。',
  marketingPrompt: '你是体贴、专业的商家客户顾问。请根据店铺信息、客户画像和最近聊天，写一条适合微信一对一沟通的简短中文话术。先回应客户需求，再自然推荐适合的产品或服务。不要虚构价格、折扣、库存、效果或稀缺性，不使用强迫成交的话术。若没有产品价格依据，不要编造。返回 JSON：script（话术正文）。',
  extractionPrompt: '你是严谨的消费记录整理助手。请从聊天记录中提取消费或退款候选记录，保留可核实的原文证据。不要将询价、报价、预算、意向或未付款订单当成已消费。金额必须为正数，日期为 YYYY-MM-DD；日期或金额不明确时不要提取。返回 JSON：orders（数组，每项包括 description、amount、date、type（sale 或 refund）、evidence）。所有结果均需商家确认。',
};
const PROVIDERS = [{ name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }, { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' }, { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' }, { name: '自定义兼容接口', baseUrl: '', model: '' }];
// DeepSeek 同时支持根地址及 /v1，识别时统一处理。
const normalizeProviderUrl = (url: string) => {
  const value = url.trim().replace(/\/+$/, '');
  return /^https:\/\/api\.deepseek\.com(?:\/v1)?$/i.test(value) ? 'https://api.deepseek.com' : value;
};

export default function Settings({ state, onChange, notify, onAI, hasApiKey, onSaveKey }: SettingsProps) {
  const [draft, setDraft] = useState<StoreSettings>(() => structuredClone(state.settings));
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removeKey, setRemoveKey] = useState(false);
  const [activePrompt, setActivePrompt] = useState<keyof typeof DEFAULT_PROMPTS>('profilePrompt');
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);
  const [testMessage, setTestMessage] = useState('');
  const savedRef = useRef(JSON.stringify(state.settings));
  const stateRef = useRef(state); stateRef.current = state;
  useEffect(() => {
    const serialized = JSON.stringify(state.settings);
    if (serialized !== savedRef.current) { savedRef.current = serialized; setDraft(structuredClone(state.settings)); }
  }, [state.settings]);
  const provider = PROVIDERS.find(item => item.baseUrl && normalizeProviderUrl(item.baseUrl) === normalizeProviderUrl(draft.ai.baseUrl))?.name || '自定义兼容接口';
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings) || !!apiKey || removeKey;
  const updateAI = <K extends keyof StoreSettings['ai']>(key: K, value: StoreSettings['ai'][K]) => { setDraft(current => ({ ...current, ai: { ...current.ai, [key]: value } })); setTestResult(null); };

  const save = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (saving) return false;
    if (!draft.storeName.trim()) { notify('请填写店铺名称', true); return false; }
    if (!Number.isInteger(draft.followupDays) || draft.followupDays < 1 || draft.followupDays > 365) { notify('跟进间隔应为 1 至 365 天的整数', true); return false; }
    if (!draft.ai.baseUrl.trim() || !draft.ai.model.trim()) { notify('请填写 API 地址和模型名称', true); return false; }
    try { const parsed = new URL(draft.ai.baseUrl); if (parsed.protocol !== 'https:') throw new Error(); } catch { notify('API 地址必须是有效的 HTTPS 地址', true); return false; }
    setSaving(true);
    try {
      if (removeKey) await onSaveKey('', true);
      else if (apiKey.trim()) await onSaveKey(apiKey.trim());
      const next = { ...draft, storeName: draft.storeName.trim(), industry: draft.industry.trim(), ai: { ...draft.ai, baseUrl: draft.ai.baseUrl.trim().replace(/\/$/, ''), model: draft.ai.model.trim() } };
      onChange({ ...stateRef.current, settings: next }); savedRef.current = JSON.stringify(next); setDraft(next); setApiKey(''); setRemoveKey(false); notify('设置已保存'); return true;
    } catch (error) { notify(error instanceof Error ? error.message : '设置保存失败，请重试', true); return false; }
    finally { setSaving(false); }
  };

  const testConnection = async () => {
    if (testing || saving) return;
    if (dirty) { notify('请先保存当前设置，再测试连接', true); return; }
    setTesting(true); setTestResult(null);
    try { await onAI('test'); setTestResult('success'); setTestMessage('连接成功，模型已正常响应。'); notify('AI 连接测试成功'); }
    catch (error) { const message = error instanceof Error ? error.message : '连接失败，请检查 API 地址、模型和密钥'; setTestResult('error'); setTestMessage(message); notify(message, true); }
    finally { setTesting(false); }
  };

  const resetPrompt = () => { if (window.confirm('将当前提示词恢复为默认内容？未保存的修改会被替换。')) { updateAI(activePrompt, DEFAULT_PROMPTS[activePrompt]); notify('已恢复默认提示词，保存后生效'); } };
  const clearData = () => {
    if (!window.confirm('确定清空全部客户、聊天、消费记录、导入历史和待办？店铺设置及 API 配置会保留，此操作无法撤销。')) return;
    const current = stateRef.current;
    onChange({ ...current, customers: [], orders: [], tasks: [], imports: [], demo: false }); notify('业务数据已清空，店铺设置已保留');
  };

  return <div className="settings-page"><div className="page-heading"><div><h1>店铺设置</h1><p className="muted">让客序更了解你的生意，也更贴合你的工作方式。</p></div><button className="btn primary" disabled={saving || !dirty} onClick={() => save()}>{saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}{saving ? '保存中…' : '保存设置'}</button></div>
    <div className="settings-grid"><div className="settings-main"><form onSubmit={save}>
      <section className="card settings-section"><div className="settings-section-heading"><span className="settings-section-icon"><Store size={19} /></span><div><h2>店铺信息</h2><p className="muted">这些信息会用于客户分析和营销话术。</p></div></div><div className="form-grid"><label className="field">店铺名称<input className="input" required maxLength={60} value={draft.storeName} onChange={event => setDraft({ ...draft, storeName: event.target.value })} placeholder="输入你的店铺名称" /></label><label className="field">所属行业<select className="input" value={draft.industry} onChange={event => setDraft({ ...draft, industry: event.target.value })}>{['美业护理', '服装零售', '餐饮烘焙', '教育培训', '家居生活', '运动健康', '专业服务', '其他'].includes(draft.industry) ? null : <option value={draft.industry}>{draft.industry || '请选择行业'}</option>}{['美业护理', '服装零售', '餐饮烘焙', '教育培训', '家居生活', '运动健康', '专业服务', '其他'].map(industry => <option key={industry}>{industry}</option>)}</select></label><label className="field full-width">默认跟进间隔<div className="days-input"><input className="input" type="number" min={1} max={365} required value={draft.followupDays} onChange={event => setDraft({ ...draft, followupDays: Number(event.target.value) })} /><span>天</span></div><small className="muted">新建客户时，默认安排在这个天数后跟进；也可为每位客户单独调整。</small></label></div></section>
      <section className="card settings-section"><div className="settings-section-heading"><span className="settings-section-icon purple"><Sparkles size={19} /></span><div><h2>AI 模型配置</h2><p className="muted">连接你自己的模型，让每次分析都真实发生。</p></div><span className={`badge ${hasApiKey && !removeKey ? 'green' : 'slate'}`}>{hasApiKey && !removeKey ? <><Check size={12} />已配置密钥</> : '待配置'}</span></div><div className="form-grid"><label className="field full-width">服务商<select className="input" value={provider} onChange={event => { const selected = PROVIDERS.find(item => item.name === event.target.value); if (selected) { setDraft(current => ({ ...current, ai: { ...current.ai, baseUrl: selected.baseUrl, model: selected.model } })); setTestResult(null); } }}>{PROVIDERS.map(item => <option key={item.name}>{item.name}</option>)}</select></label><label className="field full-width">API 地址<input className="input mono-input" required type="url" value={draft.ai.baseUrl} onChange={event => updateAI('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" /><small className="muted">使用支持 Chat Completions 协议的 HTTPS 接口地址。</small></label><label className="field">模型名称<input className="input mono-input" required value={draft.ai.model} onChange={event => updateAI('model', event.target.value)} placeholder="如 deepseek-chat" /></label><label className="field">创造性 <span className="muted small">{draft.ai.temperature.toFixed(1)}</span><div className="temperature-row"><span className="muted small">严谨</span><input aria-label="模型创造性" type="range" min="0" max="2" step="0.1" value={draft.ai.temperature} onChange={event => updateAI('temperature', Number(event.target.value))} /><span className="muted small">灵活</span></div></label><label className="field full-width">API Key<div className="key-input"><KeyRound size={16} /><input className="input mono-input" autoComplete="new-password" type={showKey ? 'text' : 'password'} value={apiKey} disabled={removeKey} onChange={event => { setApiKey(event.target.value); setTestResult(null); }} placeholder={removeKey ? '保存后移除现有密钥' : hasApiKey ? '已安全保存；输入新密钥可替换' : '输入你的 API Key'} /><button className="icon-button" type="button" aria-label={showKey ? '隐藏密钥' : '显示输入的密钥'} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div><div className="key-help"><small className="muted">已保存的密钥不会在页面回显。</small>{hasApiKey && <button type="button" className="text-button danger-text" onClick={() => { setRemoveKey(!removeKey); setApiKey(''); setTestResult(null); }}>{removeKey ? '撤销移除' : '移除现有密钥'}</button>}</div></label></div><div className="connection-test"><button type="button" className="btn secondary" disabled={testing || saving} onClick={testConnection}>{testing ? <Loader2 size={16} className="spin" /> : <Unplug size={16} />}{testing ? '正在测试…' : '测试连接'}</button>{testResult ? <span className={`connection-result ${testResult}`} role="status">{testResult === 'success' && <Check size={14} />}{testMessage}</span> : <span className="muted small">{dirty ? '修改后请先保存，再测试连接' : '测试会发送一条真实请求，可能产生少量费用'}</span>}</div></section>
      <section className="card settings-section"><div className="settings-section-heading"><span className="settings-section-icon"><SlidersHorizontal size={19} /></span><div><h2>AI 提示词</h2><p className="muted">把你的经营经验，变成 AI 的工作习惯。</p></div></div><div className="tabs prompt-tabs">{[{ key: 'profilePrompt', label: '客户画像' }, { key: 'marketingPrompt', label: '营销话术' }, { key: 'extractionPrompt', label: '消费提取' }].map(item => <button key={item.key} type="button" className={`tab ${activePrompt === item.key ? 'active' : ''}`} onClick={() => setActivePrompt(item.key as keyof typeof DEFAULT_PROMPTS)}>{item.label}</button>)}</div><label className="field prompt-field"><span className="sr-only">{activePrompt === 'profilePrompt' ? '客户画像提示词' : activePrompt === 'marketingPrompt' ? '营销话术提示词' : '消费提取提示词'}</span><textarea className="input prompt-editor" rows={9} value={draft.ai[activePrompt]} onChange={event => updateAI(activePrompt, event.target.value)} spellCheck={false} /></label><div className="prompt-footer"><span className="muted small">请保留 JSON 输出要求，保证分析结果可正常使用。</span><button className="btn ghost sm" type="button" onClick={resetPrompt}><RotateCcw size={14} />恢复默认</button></div></section>
      <div className="settings-save-row"><span className="muted small">{dirty ? '有尚未保存的修改' : '所有设置均已保存'}</span><button className="btn primary" disabled={saving || !dirty} type="submit">{saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}保存设置</button></div>
    </form><section className="card settings-section data-settings"><div className="settings-section-heading"><span className="settings-section-icon"><Database size={19} /></span><div><h2>数据管理</h2><p className="muted">你可以随时重新开始。</p></div></div><div className="data-settings-row"><div><strong>清空业务数据</strong><p className="muted small">删除客户、聊天、消费和待办，保留店铺与模型设置。</p></div><button type="button" className="btn secondary danger-text" onClick={clearData}><Trash2 size={15} />清空数据</button></div></section></div>
    <aside className="settings-aside"><div className="card settings-tips"><span className="tip-icon"><ShieldCheck size={23} /></span><h3>让数据为你的生意服务</h3><p>客序只分析你主动导入的微信记录。AI 生成的画像可编辑，消费记录需确认，话术由你决定何时发送。</p><div className="tip-divider" /><h4>开始使用的三个小步骤</h4><ol><li><span>1</span>填写店铺信息与模型配置</li><li><span>2</span>导入一段微信聊天记录</li><li><span>3</span>了解客户，准备下一次跟进</li></ol><div className="settings-tip-note"><Sparkles size={15} /><p>选一个熟悉的客户先试试，更容易判断画像和话术是否贴合。</p></div></div><div className="settings-privacy-note"><KeyRound size={15} /><p>密钥单独保存，不包含在业务数据导出中。请使用你信任的模型服务商。</p></div></aside></div>
  </div>;
}
