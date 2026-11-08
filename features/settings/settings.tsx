'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Check, Database, Eye, EyeOff, KeyRound, Loader2, RotateCcw, Save, ShieldCheck, SlidersHorizontal, Sparkles, Store, Trash2, Unplug } from 'lucide-react';
import type { Settings as StoreSettings, SettingsProps } from '../../lib/types';
import { loadSavedReplyConfig, localRepliesAvailable, replyRequest, replySettingsFor } from '../auto-reply/reply-ui';
import { assertWorkspaceCurrent, captureWorkspace, subscribeWorkspaceInvalidation } from '../../lib/client-workspace';
import { createCompetitionDemo } from '../../lib/competition-demo';

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

export default function Settings({ state, onChange, notify, onAI, hasApiKey, onSaveKey, onExport }: SettingsProps & { onExport: () => void }) {
  const [draft, setDraft] = useState<StoreSettings>(() => structuredClone(state.settings));
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loadingDemo, setLoadingDemo] = useState(false);
  const loadingDemoRef = useRef(false);
  const [removeKey, setRemoveKey] = useState(false);
  const [activePrompt, setActivePrompt] = useState<keyof typeof DEFAULT_PROMPTS>('profilePrompt');
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);
  const [testMessage, setTestMessage] = useState('');
  const savedRef = useRef(JSON.stringify(state.settings));
  const stateRef = useRef(state); stateRef.current = state;
  useEffect(() => subscribeWorkspaceInvalidation(message => { setApiKey(''); setShowKey(false); setRemoveKey(false); setSaving(false); setTesting(false); setTestResult(null); setTestMessage(message); }), []);
  useEffect(() => {
    const serialized = JSON.stringify(state.settings);
    if (serialized !== savedRef.current) { savedRef.current = serialized; setDraft(structuredClone(state.settings)); }
  }, [state.settings]);
  const provider = PROVIDERS.find(item => item.baseUrl && normalizeProviderUrl(item.baseUrl) === normalizeProviderUrl(draft.ai.baseUrl))?.name || '自定义兼容接口';
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings) || !!apiKey || removeKey;
  const updateAI = <K extends keyof StoreSettings['ai']>(key: K, value: StoreSettings['ai'][K]) => { setDraft(current => ({ ...current, ai: { ...current.ai, [key]: value } })); setTestResult(null); };
  const loadCompetitionDemo = async () => {
    if (loadingDemoRef.current || saving || testing || dirty) return;
    loadingDemoRef.current = true; setLoadingDemo(true);
    try {
      const expected = captureWorkspace();
      if (localRepliesAvailable()) await replyRequest('/pause', {});
      assertWorkspaceCurrent(expected);
      const next = createCompetitionDemo(stateRef.current);
      if (!await onChange(next)) return;
      if (localRepliesAvailable()) await replyRequest('/config', await loadSavedReplyConfig());
      notify('已加载青禾生活馆：30位演示客户、22项商品服务。真实客户和AI密钥保留，接待保持暂停。');
    } catch (error) { notify(error instanceof Error ? error.message : '演示数据加载失败', true); }
    finally { loadingDemoRef.current = false; setLoadingDemo(false); }
  };

  const save = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (saving || loadingDemoRef.current) return false;
    if (!draft.storeName.trim()) { notify('请填写店铺名称', true); return false; }
    if (!Number.isInteger(draft.followupDays) || draft.followupDays < 1 || draft.followupDays > 365) { notify('跟进间隔应为 1 至 365 天的整数', true); return false; }
    if (!draft.ai.baseUrl.trim() || !draft.ai.model.trim()) { notify('请填写 API 地址和模型名称', true); return false; }
    try { const parsed = new URL(draft.ai.baseUrl); if (parsed.protocol !== 'https:') throw new Error(); } catch { notify('API 地址必须是有效的 HTTPS 地址', true); return false; }
    setSaving(true);
    try {
      const expected = captureWorkspace();
      if (removeKey) await onSaveKey('', true);
      else if (apiKey.trim()) await onSaveKey(apiKey.trim());
      const next = { ...draft, storeName: draft.storeName.trim(), industry: draft.industry.trim(), ai: { ...draft.ai, baseUrl: draft.ai.baseUrl.trim().replace(/\/$/, ''), model: draft.ai.model.trim() } };
      if (!await onChange({ ...stateRef.current, settings: next })) return false; assertWorkspaceCurrent(expected); savedRef.current = JSON.stringify(next); setDraft(next); setApiKey(''); setRemoveKey(false); notify('设置已保存'); return true;
    } catch (error) { notify(error instanceof Error ? error.message : '设置保存失败，请重试', true); return false; }
    finally { setSaving(false); }
  };

  const testConnection = async () => {
    if (testing || saving || loadingDemoRef.current) return;
    if (dirty) { notify('请先保存当前设置，再测试连接', true); return; }
    setTesting(true); setTestResult(null);
    try { const expected = captureWorkspace(); await onAI('test'); assertWorkspaceCurrent(expected); setTestResult('success'); setTestMessage('连接成功，模型已正常响应。'); notify('AI 连接测试成功'); }
    catch (error) { const message = error instanceof Error ? error.message : '连接失败，请检查 API 地址、模型和密钥'; setTestResult('error'); setTestMessage(message); notify(message, true); }
    finally { setTesting(false); }
  };

  const resetPrompt = () => { if (window.confirm('将当前提示词恢复为默认内容？未保存的修改会被替换。')) { updateAI(activePrompt, DEFAULT_PROMPTS[activePrompt]); notify('已恢复默认提示词，保存后生效'); } };
  const clearData = async () => {
    if (loadingDemoRef.current || saving || testing) return;
    if (!window.confirm('确定清空全部客户、聊天、消费记录、导入历史和待办？店铺设置及 API 配置会保留，此操作无法撤销。')) return;
    try {
      if (localRepliesAvailable()) {
        let runtime: { running: boolean } | null = null;
        try { runtime = await replyRequest<{ running: boolean }>('/status'); } catch { /* 未启用本地接待时仍可管理工作台数据。 */ }
        if (runtime?.running) await replyRequest('/pause', {});
      }
      const current = stateRef.current;
      const next = { ...current, customers: [], orders: [], tasks: [], imports: [], exports: [], demo: false, replySettings: { ...replySettingsFor(current), enabled: false, selectedCustomerIds: [] } };
      if (!await onChange(next, { clearBusinessData: true })) return;
      if (localRepliesAvailable()) { try { await replyRequest('/config', await loadSavedReplyConfig()); } catch { notify('业务数据已清空，回复总开关已关闭；本机同步未确认，请检查自动回复中心', true); return; } }
      notify('业务数据已清空，店铺设置已保留，自动回复已关闭');
    } catch (error) { notify(error instanceof Error ? error.message : '未能暂停本地接待，数据尚未清空', true); }
  };

  return <div className="settings-page"><div className="page-heading"><div><h1>店铺设置</h1><p className="muted">让客序更了解你的生意，也更贴合你的工作方式。</p></div><button className="btn primary" disabled={saving || loadingDemo || !dirty} onClick={() => save()}>{saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}{saving ? '保存中…' : '保存设置'}</button></div>
    <div className="settings-grid"><div className="settings-main"><form onSubmit={save}><fieldset disabled={loadingDemo} style={{border:0,padding:0,margin:0,minWidth:0}}>
      <section className="card settings-section"><div className="settings-section-heading"><span className="settings-section-icon purple"><Sparkles size={19} /></span><div><h2>AI 模型配置</h2><p className="muted">连接你自己的模型，让每次分析都真实发生。</p></div><span className={`badge ${hasApiKey && !removeKey ? 'green' : 'slate'}`}>{hasApiKey && !removeKey ? <><Check size={12} />已配置密钥</> : '待配置'}</span></div><div className="form-grid"><label className="field full-width">服务商<select className="input" value={provider} onChange={event => { const selected = PROVIDERS.find(item => item.name === event.target.value); if (selected) { setDraft(current => ({ ...current, ai: { ...current.ai, baseUrl: selected.baseUrl, model: selected.model } })); setTestResult(null); } }}>{PROVIDERS.map(item => <option key={item.name}>{item.name}</option>)}</select></label><label className="field full-width">API 地址<input className="input mono-input" required type="url" value={draft.ai.baseUrl} onChange={event => updateAI('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" /><small className="muted">使用支持 Chat Completions 协议的 HTTPS 接口地址。</small></label><label className="field">模型名称<input className="input mono-input" required value={draft.ai.model} onChange={event => updateAI('model', event.target.value)} placeholder="如 deepseek-chat" /></label><label className="field">表达灵活度 <span className="muted small">{draft.ai.temperature.toFixed(1)}</span><div className="temperature-row"><span className="muted small">稳定</span><input aria-label="模型表达灵活度" type="range" min="0" max="2" step="0.1" value={draft.ai.temperature} onChange={event => updateAI('temperature', Number(event.target.value))} /><span className="muted small">多样</span></div><small className="muted">数值越低措辞越稳定，越高表达越多样。门店回复建议0.2–0.5。</small></label><label className="field full-width">API Key<div className="key-input"><KeyRound size={16} /><input className="input mono-input" autoComplete="new-password" type={showKey ? 'text' : 'password'} value={apiKey} disabled={removeKey} onChange={event => { setApiKey(event.target.value); setTestResult(null); }} placeholder={removeKey ? '保存后移除现有密钥' : hasApiKey ? '已安全保存；输入新密钥可替换' : '输入你的 API Key'} /><button className="icon-button" type="button" aria-label={showKey ? '隐藏密钥' : '显示输入的密钥'} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div><div className="key-help"><small className="muted">已保存的密钥不会在页面回显。</small>{hasApiKey && <button type="button" className="text-button danger-text" onClick={() => { setRemoveKey(!removeKey); setApiKey(''); setTestResult(null); }}>{removeKey ? '撤销移除' : '移除现有密钥'}</button>}</div></label></div><div className="connection-test"><button type="button" className="btn secondary" disabled={testing || saving || loadingDemo} onClick={testConnection}>{testing ? <Loader2 size={16} className="spin" /> : <Unplug size={16} />}{testing ? '正在测试…' : '测试连接'}</button>{testResult ? <span className={`connection-result ${testResult}`} role="status">{testResult === 'success' && <Check size={14} />}{testMessage}</span> : <span className="muted small">{dirty ? '修改后请先保存，再测试连接' : '测试会发送一条真实请求，可能产生少量费用'}</span>}</div></section>
      <section className="card settings-section"><div className="settings-section-heading"><span className="settings-section-icon"><SlidersHorizontal size={19} /></span><div><h2>AI 提示词</h2><p className="muted">把你的经营经验，变成 AI 的工作习惯。</p></div></div><div className="tabs prompt-tabs">{[{ key: 'profilePrompt', label: '客户画像' }, { key: 'marketingPrompt', label: '营销话术' }, { key: 'extractionPrompt', label: '消费提取' }].map(item => <button key={item.key} type="button" className={`tab ${activePrompt === item.key ? 'active' : ''}`} onClick={() => setActivePrompt(item.key as keyof typeof DEFAULT_PROMPTS)}>{item.label}</button>)}</div><label className="field prompt-field"><span className="sr-only">{activePrompt === 'profilePrompt' ? '客户画像提示词' : activePrompt === 'marketingPrompt' ? '营销话术提示词' : '消费提取提示词'}</span><textarea className="input prompt-editor" rows={9} value={draft.ai[activePrompt]} onChange={event => updateAI(activePrompt, event.target.value)} spellCheck={false} /></label><div className="prompt-footer"><span className="muted small">请保留 JSON 输出要求，保证分析结果可正常使用。</span><button className="btn ghost sm" type="button" onClick={resetPrompt}><RotateCcw size={14} />恢复默认</button></div></section>
      <div className="settings-save-row"><span className="muted small">{dirty ? '有尚未保存的修改' : '所有设置均已保存'}</span><button className="btn primary" disabled={saving || loadingDemo || !dirty} type="submit">{saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}保存设置</button></div>
    </fieldset></form><section className="card settings-section data-settings"><div className="settings-section-heading"><span className="settings-section-icon"><Database size={19} /></span><div><h2>数据管理</h2><p className="muted">按需要导出经营资料，或清理工作空间。</p></div></div><div className="data-settings-row"><div><strong>比赛演示店铺</strong><p className="muted small">载入30位虚拟客户、22项商品服务和演示经营记录，保留真实客户与模型配置。</p></div><button type="button" className="btn secondary" disabled={loadingDemo || saving || testing || dirty} onClick={() => { void loadCompetitionDemo(); }}>{loadingDemo ? <Loader2 size={15} className="spin" /> : <Store size={15} />}{loadingDemo ? '正在加载…' : '加载演示店铺'}</button></div><div className="data-settings-row settings-export-row"><div><strong>导出数据</strong><p className="muted small">下载完整 JSON，或按客户、消费、跟进分别导出 Excel 兼容表格。</p></div><button type="button" className="btn secondary" onClick={onExport}><ArrowDownToLine size={15} />导出数据</button></div><div className="data-settings-row"><div><strong>清空业务数据</strong><p className="muted small">删除客户、聊天、消费和待办，保留店铺与模型设置。</p></div><button type="button" className="btn secondary danger-text" disabled={loadingDemo || saving || testing} onClick={clearData}><Trash2 size={15} />清空数据</button></div></section></div>
    <aside className="settings-aside"><div className="card settings-tips"><span className="tip-icon"><ShieldCheck size={23} /></span><h3>让数据为你的生意服务</h3><p>客户画像和AI建议都可编辑。自动接待按已启用的规则处理新消息，需人工处理的事项会保留在队列中。</p><div className="tip-divider" /><h4>开始使用的三个小步骤</h4><ol><li><span>1</span>填写店铺信息与模型配置</li><li><span>2</span>导入一段微信聊天记录</li><li><span>3</span>了解客户，准备下一次跟进</li></ol></div></aside></div>
  </div>;
}
