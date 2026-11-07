'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Bot, Check, CheckCircle2, Download, FileText, Hand, Loader2, Monitor, Pause, Play, RefreshCw, Save, Search, Send, Settings2, ShieldCheck, Sparkles, UserRound, X } from 'lucide-react';
import type { AppState, ReplyJobStatus, ReplyJobView, ReplyResult, ReplySettings, ReplyWork, SharedProps } from '../../lib/types';
import { localRepliesAvailable, replyConfigFor, replyRequest, replySettingsFor, WEEKDAYS } from './reply-ui';

type ReplyAdapter = { configured?: boolean; canReceive?: boolean; canSend?: boolean; message?: string; type?: string };
type Runtime = { running: boolean; generatorMode: 'background' | 'browser'; configReady: boolean; counts: Record<ReplyJobStatus, number>; jobs: ReplyJobView[]; takeovers: string[]; pausedReason?: string; adapter?: ReplyAdapter };
const STATUSES: Record<ReplyJobStatus, { label: string; color: string }> = { queued: { label: '等待处理', color: 'slate' }, generating: { label: '正在拟稿', color: 'purple' }, draft: { label: '待人工审阅', color: 'purple' }, ready: { label: '准备发送', color: 'amber' }, sending: { label: '正在发送', color: 'amber' }, sent: { label: '已核实发送', color: 'green' }, handoff: { label: '需人工接管', color: 'amber' }, failed: { label: '处理失败', color: 'slate' }, unknown: { label: '发送结果未知', color: 'amber' }, ignored: { label: '已忽略', color: 'slate' }, cancelled: { label: '已取消', color: 'slate' } };
const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';
const messageFor = (error: unknown) => error instanceof Error ? error.name === 'TimeoutError' ? '本地组件响应超时，请检查客序本地服务。' : error.message : '操作失败，请检查本地服务后重试。';
const timeLabel = (value: string) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : value; };

export default function AutoReply({ state, onChange, notify }: SharedProps) {
  const [draft, setDraft] = useState<ReplySettings>(() => replySettingsFor(state));
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [connection, setConnection] = useState<'checking' | 'cloud' | 'ready' | 'error'>('checking');
  const [runtimeError, setRuntimeError] = useState('');
  const [busy, setBusy] = useState('');
  const [tab, setTab] = useState<'queue' | 'history' | 'rules'>('queue');
  const [jobFilter, setJobFilter] = useState('all');
  const [customerQuery, setCustomerQuery] = useState('');
  const [keywords, setKeywords] = useState(() => replySettingsFor(state).handoffKeywords.join('，'));
  const alive = useRef(true);
  const stateRef = useRef(state);
  const propsRef = useRef({ onChange, notify });
  const controller = useRef<AbortController | null>(null);
  const workController = useRef<AbortController | null>(null);
  const workerBusy = useRef(false);
  const runtimeRef = useRef(runtime);
  const savedSettings = replySettingsFor(state);
  const canReceive = connection === 'ready' && runtime?.adapter?.canReceive === true;
  const canSend = connection === 'ready' && runtime?.adapter?.canSend === true;
  const sendUnavailableReason = runtime?.adapter?.message || '自动发送尚未接通或尚未通过本机验收；当前可先生成草稿。';
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedSettings) || keywords !== draft.handoffKeywords.join('，');
  const candidates = state.customers.filter(customer => customer.source !== 'demo' && customer.wechatId);
  const filteredCustomers = candidates.filter(customer => `${customer.name} ${customer.wechatId}`.toLowerCase().includes(customerQuery.toLowerCase()));
  const jobs = runtime?.jobs ?? [];
  const actionable = jobs.filter(job => ['draft', 'handoff', 'unknown', 'failed', 'queued', 'generating', 'ready', 'sending'].includes(job.status));
  const filteredJobs = (tab === 'queue' ? actionable : jobs).filter(job => jobFilter === 'all' || job.status === jobFilter);

  useEffect(() => { stateRef.current = state; propsRef.current = { onChange, notify }; }, [state, onChange, notify]);
  useEffect(() => { runtimeRef.current = runtime; }, [runtime]);

  async function browserWork(signal: AbortSignal) {
    if (workerBusy.current) return;
    workerBusy.current = true;
    try {
      const work = await replyRequest<{ jobs: ReplyWork[] }>('/work', {}, signal);
      for (const job of work.jobs ?? []) {
        if (signal.aborted || !alive.current || !runtimeRef.current?.running) break;
        let result: ReplyResult;
        try {
          const response = await fetch('/api/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId: job.customerId, message: job.message, context: job.context }), signal });
          const generated = await response.json() as ReplyResult & { error?: string };
          if (!response.ok) throw new Error(generated.error || '回复生成失败');
          result = generated;
        } catch (error) {
          if (signal.aborted || isAbort(error)) break;
          await replyRequest(`/jobs/${encodeURIComponent(job.id)}/result`, { leaseId: job.leaseId, error: messageFor(error) }, signal);
          continue;
        }
        await replyRequest(`/jobs/${encodeURIComponent(job.id)}/result`, { leaseId: job.leaseId, result }, signal);
      }
    } catch (error) { if (alive.current && !isAbort(error)) setRuntimeError(messageFor(error)); }
    finally { workerBusy.current = false; }
  }

  const refreshStatus = async (signal?: AbortSignal) => {
    if (!localRepliesAvailable()) { setConnection('cloud'); return; }
    try {
      const next = await replyRequest<Runtime>('/status', undefined, signal);
      if (!alive.current || signal?.aborted) return;
      if (typeof next.running !== 'boolean' || !Array.isArray(next.jobs)) throw new Error('本地回复状态不完整，请检查组件版本');
      setRuntime(next); runtimeRef.current = next; setConnection('ready'); setRuntimeError('');
      if (next.running && next.generatorMode === 'browser') {
        if (!workController.current || workController.current.signal.aborted) workController.current = new AbortController();
        void browserWork(workController.current.signal);
      }
    } catch (error) { if (alive.current && !isAbort(error)) { setConnection('error'); setRuntimeError(messageFor(error)); } }
  };

  useEffect(() => {
    alive.current = true; controller.current = new AbortController();
    void refreshStatus(controller.current.signal);
    // 此处仅查询运行状态；启动监听与发送必须由商家主动操作。
    const timer = setInterval(() => { void refreshStatus(controller.current?.signal); }, 4000);
    return () => { alive.current = false; clearInterval(timer); controller.current?.abort(); workController.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const validate = (settings: ReplySettings) => {
    if (settings.businessHours.enabled && (!settings.businessHours.days.length || settings.businessHours.start >= settings.businessHours.end)) throw new Error('请设置有效的营业日及营业时间，开始时间需早于结束时间');
    if (!Number.isInteger(settings.maxReplyChars) || settings.maxReplyChars < 50 || settings.maxReplyChars > 1000) throw new Error('单条回复长度应为 50 至 1000 字');
    if (!Number.isInteger(settings.cooldownSeconds) || settings.cooldownSeconds < 5 || settings.cooldownSeconds > 3600) throw new Error('回复间隔应为 5 至 3600 秒');
    if (settings.enabled && !settings.selectedCustomerIds.length) throw new Error('请先选择至少一位真实客户，自动回复默认不对所有人开放');
    if (settings.selectedCustomerIds.length > 20) throw new Error('本机接待每次最多支持 20 位客户，请缩小回复范围');
    const selected = candidates.filter(customer => settings.selectedCustomerIds.includes(customer.id));
    if (new Set(selected.map(customer => customer.wechatId)).size !== selected.length) throw new Error('所选客户包含重复微信标识，请每个私聊只选择一份档案');
  };

  const saveRules = async (startAfter = false) => {
    if (busy) return;
    setBusy(startAfter ? 'start' : 'save');
    try {
      const settings = { ...draft, selectedCustomerIds: draft.selectedCustomerIds.filter(id => candidates.some(customer => customer.id === id)), handoffKeywords: [...new Set(keywords.split(/[,，、\n]/).map(value => value.trim()).filter(Boolean))] };
      validate(settings);
      if (startAfter && !settings.enabled) throw new Error('请先开启自动回复总开关，再保存并启动');
      if (startAfter && !localRepliesAvailable()) throw new Error('请在本机启动客序后运行自动回复，云端仅管理规则');
      if (startAfter && !canReceive) throw new Error(runtime?.adapter?.message || '本地读取组件尚未就绪，未启动接待');
      if (startAfter && settings.mode === 'auto' && !canSend) throw new Error(sendUnavailableReason);
      if (localRepliesAvailable() && runtimeRef.current?.running) { await replyRequest('/pause', {}); workController.current?.abort(); }
      const current = stateRef.current;
      const next: AppState = { ...current, replySettings: settings, customers: current.customers.map(customer => ({ ...customer, autoReplyEnabled: settings.selectedCustomerIds.includes(customer.id) })) };
      if (!await propsRef.current.onChange(next)) return;
      setDraft(settings); setKeywords(settings.handoffKeywords.join('，'));
      if (localRepliesAvailable()) {
        try { await replyRequest('/config', replyConfigFor(next)); }
        catch (error) { await refreshStatus(); throw new Error(`规则已保存，但本机配置未同步：${messageFor(error)}。没有启动新的回复任务。`); }
        if (startAfter) await replyRequest('/start', {});
        await refreshStatus();
      }
      propsRef.current.notify(startAfter ? settings.mode === 'review' ? '本地草稿接待已启动，请在队列中审阅真实新消息' : '本地自动回复已启动，请关注实际发送核实结果' : '回复规则已保存；启动前不会读取新消息或发送回复');
    } catch (error) { propsRef.current.notify(messageFor(error), true); }
    finally { if (alive.current) setBusy(''); }
  };

  const pause = async () => {
    if (busy) return; setBusy('pause');
    try { await replyRequest('/pause', {}); workController.current?.abort(); await refreshStatus(); propsRef.current.notify('已暂停本地回复，当前规则已保留'); }
    catch (error) { propsRef.current.notify(`暂停未确认：${messageFor(error)}。请核对本机微信与任务状态。`, true); }
    finally { if (alive.current) setBusy(''); }
  };

  const setMaster = async (enabled: boolean) => {
    if (busy) return;
    setDraft(current => ({ ...current, enabled }));
    if (enabled) { setTab('rules'); return; }
    setBusy('disable');
    try {
      if (localRepliesAvailable()) { await replyRequest('/pause', {}); workController.current?.abort(); }
      const latest = stateRef.current; const settings = { ...replySettingsFor(latest), enabled: false };
      if (!await propsRef.current.onChange({ ...latest, replySettings: settings })) return;
      if (localRepliesAvailable()) { try { await replyRequest('/config', replyConfigFor({ ...latest, replySettings: settings })); } catch { /* 总开关已保存且运行已暂停，下一次启动前仍会重新同步。 */ } await refreshStatus(); }
      propsRef.current.notify('自动回复总开关已关闭');
    } catch (error) { propsRef.current.notify(`关闭未确认：${messageFor(error)}。请在本机核对运行状态。`, true); setDraft(replySettingsFor(stateRef.current)); }
    finally { if (alive.current) setBusy(''); }
  };

  const actOnJob = async (job: ReplyJobView, action: 'approve' | 'reject') => {
    if (busy) return; setBusy(job.id);
    try { if (action === 'approve' && !canSend) throw new Error(sendUnavailableReason); await replyRequest(`/jobs/${encodeURIComponent(job.id)}/${action}`, action === 'reject' ? { reason: '商家在自动回复中心拒绝此草稿' } : {}); await refreshStatus(); propsRef.current.notify(action === 'approve' ? '已提交发送，请以队列中的核实结果为准' : '已拒绝此草稿，不会发送'); }
    catch (error) { propsRef.current.notify(messageFor(error), true); await refreshStatus(); }
    finally { if (alive.current) setBusy(''); }
  };

  const takeover = async (customerId: string, enabled: boolean) => {
    if (busy) return; setBusy(customerId);
    try {
      const current = stateRef.current;
      const next = { ...current, customers: current.customers.map(customer => customer.id === customerId ? { ...customer, humanTakeover: enabled } : customer) };
      if (enabled && localRepliesAvailable()) await replyRequest('/takeover', { customerId, enabled: true });
      if (!await propsRef.current.onChange(next)) return;
      if (!enabled && localRepliesAvailable()) { await replyRequest('/config', replyConfigFor(next)); await replyRequest('/takeover', { customerId, enabled: false }); }
      await refreshStatus(); propsRef.current.notify(enabled ? '已转人工接管，该客户后续不会自动发送' : '已恢复该客户的托管规则');
    } catch (error) { propsRef.current.notify(messageFor(error), true); }
    finally { if (alive.current) setBusy(''); }
  };

  const waiting = runtime?.counts?.draft ?? 0;
  const handoffCount = (runtime?.counts?.handoff ?? 0) + (runtime?.counts?.unknown ?? 0);
  const savedEnabled = replySettingsFor(state).enabled;

  return <div className="auto-reply-page"><section className={`card reply-control-bar ${connection === 'ready' && runtime?.running ? 'running' : ''}`}><span className="reply-control-icon"><Bot size={27} /></span><div className="reply-control-copy"><div><h2>{connection === 'cloud' ? '微信回复在本机运行' : connection === 'checking' ? '正在检查本地回复组件' : connection === 'error' ? '本地回复组件暂未连接' : runtime?.running ? savedSettings.mode === 'review' ? '草稿接待正在运行' : '客户回复服务正在运行' : '本地回复已暂停'}</h2><span className={`reply-runtime-dot ${runtime?.running && connection === 'ready' ? 'active' : ''}`} /></div><p>{connection === 'cloud' ? '你可以在这里管理知识和规则；读取与发送需在 Windows 本机启动客序。' : connection === 'error' ? runtimeError : runtime?.pausedReason || (runtime?.running ? runtime.generatorMode === 'browser' ? '浏览器协作模式：请保持本页打开，关闭后将停止生成新回复。' : savedSettings.mode === 'review' ? '只读取所选客户的新消息并准备草稿，不会自动发送。' : '只处理已选客户的新消息，发送结果会逐条核实并记录。' : '默认不收发微信消息。保存规则后，由你主动启动。')}</p></div><div className="reply-control-actions">{connection === 'cloud' ? <a className="btn secondary" href="/kexu-local.zip" download><Download size={15} />下载本地版</a> : <><button className="icon-button" disabled={!!busy} aria-label="刷新自动回复状态" onClick={() => { void refreshStatus(); }}><RefreshCw size={16} /></button>{runtime?.running ? <button className="btn secondary" disabled={!!busy} onClick={() => { void pause(); }}>{busy === 'pause' ? <Loader2 size={15} className="spin" /> : <Pause size={15} />}暂停运行</button> : <button className="btn primary" disabled={!!busy || !canReceive} title={!canReceive ? runtime?.adapter?.message || '本地读取适配器尚未就绪' : undefined} onClick={() => { void saveRules(true); }}>{busy === 'start' ? <Loader2 size={15} className="spin" /> : <Play size={15} />}{dirty ? '保存并启动' : draft.mode === 'review' ? '启动草稿接待' : '启动本地回复'}</button>}</>}</div></section>
    {connection === 'ready' && !canSend && <div className="reply-alert"><AlertCircle size={16} /><div><strong>{canReceive ? '草稿接待可用，自动发送尚未接通' : '本地接待尚需准备，自动发送未接通'}</strong><p>{sendUnavailableReason}</p><p>生成的草稿可以审阅并复制；接通发送网关且完成本机核验后，才开放自动发送和确认发送。</p></div></div>}
    <div className="reply-center-stats"><div><span className="reply-stat-icon purple"><FileText size={19} /></span><span>待人工审阅<strong>{connection === 'ready' ? waiting : '—'}</strong></span></div><div><span className="reply-stat-icon green"><CheckCircle2 size={19} /></span><span>已核实发送<strong>{connection === 'ready' ? runtime?.counts?.sent ?? 0 : '—'}</strong></span></div><div><span className="reply-stat-icon amber"><Hand size={19} /></span><span>需人工处理<strong>{connection === 'ready' ? handoffCount : '—'}</strong></span></div><div><span className="reply-stat-icon slate"><UserRound size={19} /></span><span>已选客户<strong>{savedSettings.selectedCustomerIds.length}</strong></span></div></div>
    {connection === 'error' && <div className="reply-alert"><AlertCircle size={16} /><p>当前无法确认本机运行状态，请检查本地服务；下面不会展示伪造的收发记录。</p></div>}
    <div className="reply-center-layout"><section className="card reply-center-main"><div className="reply-center-toolbar"><div className="tabs"><button className={`tab ${tab === 'queue' ? 'active' : ''}`} onClick={() => { setTab('queue'); setJobFilter('all'); }}>处理队列{actionable.length > 0 && <span className="count-label">{actionable.length}</span>}</button><button className={`tab ${tab === 'history' ? 'active' : ''}`} onClick={() => { setTab('history'); setJobFilter('all'); }}>回复记录</button><button className={`tab ${tab === 'rules' ? 'active' : ''}`} onClick={() => setTab('rules')}>回复规则</button></div>{tab !== 'rules' && <select className="input compact" aria-label="筛选回复状态" value={jobFilter} onChange={event => setJobFilter(event.target.value)}><option value="all">全部状态</option>{Object.entries(STATUSES).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select>}</div>
      {tab === 'rules' ? <div className="reply-rules"><div className="reply-rule-block"><div className="reply-rule-heading"><div><h3>自动回复总开关</h3><p>开启并保存后，仍需主动启动本机服务。</p></div><label className="reply-switch"><input type="checkbox" aria-label="自动回复总开关" disabled={!!busy} checked={draft.enabled} onChange={event => { void setMaster(event.target.checked); }} /><span /></label></div><div className="reply-mode-grid"><button className={draft.mode === 'review' ? 'selected' : ''} onClick={() => setDraft({ ...draft, mode: 'review' })}><span><UserRound size={19} />{draft.mode === 'review' && <Check size={14} />}</span><strong>手动审阅</strong><p>{canSend ? 'AI 先拟稿，经你点击确认后发送。' : 'AI 先拟稿，由你复制到微信发送。'}</p></button><button className={draft.mode === 'auto' ? 'selected' : ''} disabled={!canSend} title={!canSend ? sendUnavailableReason : undefined} onClick={() => setDraft({ ...draft, mode: 'auto' })}><span><Sparkles size={19} />{draft.mode === 'auto' && <Check size={14} />}</span><strong>自动回复</strong><p>{canSend ? '规则通过后自动发送，异常转人工。' : '自动发送尚未接通，待本机验收。'}</p></button></div></div>
        <div className="reply-rule-block"><div className="reply-rule-heading"><div><h3>允许回复的客户</h3><p>单次最多 20 位真实私聊。示例客户不参与。</p></div><span className="badge purple">已选 {draft.selectedCustomerIds.length} 位</span></div><div className="reply-search reply-customer-search"><Search size={15} /><input aria-label="搜索托管客户" value={customerQuery} onChange={event => setCustomerQuery(event.target.value)} placeholder="搜索客户或微信标识" /></div><div className="reply-customer-selection">{filteredCustomers.length ? filteredCustomers.map(customer => <label key={customer.id}><input type="checkbox" disabled={!draft.selectedCustomerIds.includes(customer.id) && draft.selectedCustomerIds.length >= 20} checked={draft.selectedCustomerIds.includes(customer.id)} onChange={event => setDraft({ ...draft, selectedCustomerIds: event.target.checked ? [...draft.selectedCustomerIds, customer.id] : draft.selectedCustomerIds.filter(id => id !== customer.id) })} /><span className="avatar small" style={{ background: `${customer.color}18`, color: customer.color }}>{customer.name.slice(-2)}</span><span><strong>{customer.name}</strong><small>{customer.wechatId}</small></span>{customer.humanTakeover && <span className="badge amber">人工接管</span>}</label>) : <div className="reply-inline-empty">{candidates.length ? '没有匹配的客户' : '先从微信数据页导入真实私聊，再选择允许回复的客户。'}</div>}</div></div>
        <div className="reply-rule-block"><div className="reply-rule-heading"><div><h3>营业时段</h3><p>按北京时间执行，时段外不会自动发送。</p></div><label className="reply-switch"><input type="checkbox" aria-label="限制营业时间" checked={draft.businessHours.enabled} onChange={event => setDraft({ ...draft, businessHours: { ...draft.businessHours, enabled: event.target.checked } })} /><span /></label></div><div className="reply-weekdays">{WEEKDAYS.map(day => <button key={day.value} className={draft.businessHours.days.includes(day.value) ? 'active' : ''} onClick={() => setDraft({ ...draft, businessHours: { ...draft.businessHours, days: draft.businessHours.days.includes(day.value) ? draft.businessHours.days.filter(value => value !== day.value) : [...draft.businessHours.days, day.value] } })}>{day.label}</button>)}</div><div className="reply-time-range"><input className="input" type="time" aria-label="回复开始时间" value={draft.businessHours.start} onChange={event => setDraft({ ...draft, businessHours: { ...draft.businessHours, start: event.target.value } })} /><span>至</span><input className="input" type="time" aria-label="回复结束时间" value={draft.businessHours.end} onChange={event => setDraft({ ...draft, businessHours: { ...draft.businessHours, end: event.target.value } })} /></div></div>
        <div className="reply-rule-block"><h3>边界与转人工</h3><label className="field">转人工关键词<input className="input" value={keywords} maxLength={500} onChange={event => setKeywords(event.target.value)} placeholder="用逗号分隔，如：退款，投诉，人工客服" /></label><div className="form-grid"><label className="field">最长回复（字）<input className="input" type="number" min={50} max={1000} value={draft.maxReplyChars} onChange={event => setDraft({ ...draft, maxReplyChars: Number(event.target.value) })} /></label><label className="field">同一客户回复间隔（秒）<input className="input" type="number" min={5} max={3600} value={draft.cooldownSeconds} onChange={event => setDraft({ ...draft, cooldownSeconds: Number(event.target.value) })} /></label></div><label className="field">回复工作指引<textarea className="input" rows={5} maxLength={5000} value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} /></label><div className="reply-rule-note"><ShieldCheck size={15} /><span>无依据的问题、主动要求人工和发送结果未知的消息均需人工处理；不会自动重发未知结果。</span></div></div><div className="reply-rules-footer"><span>{dirty ? '有尚未保存的修改' : '规则已保存'}</span><button className="btn primary" disabled={!!busy || !dirty} onClick={() => { void saveRules(); }}>{busy === 'save' ? <Loader2 size={15} className="spin" /> : <Save size={15} />}保存规则</button></div></div> : filteredJobs.length ? <div className="reply-jobs">{filteredJobs.map(job => { const customer = state.customers.find(item => item.id === job.customerId); const status = STATUSES[job.status]; const taken = !!customer?.humanTakeover || (runtime?.takeovers ?? []).includes(job.customerId); return <article className={`reply-job ${job.status === 'unknown' ? 'unknown' : ''}`} key={job.id}><div className="reply-job-heading"><span className="avatar small" style={{ background: `${customer?.color || '#9b87c0'}18`, color: customer?.color || '#9b87c0' }}>{(customer?.name || '微信').slice(-2)}</span><div><strong>{customer?.name || job.chatId}</strong><small>{timeLabel(job.updatedAt || job.createdAt)}</small></div><span className={`badge ${status?.color || 'slate'}`}>{status?.label || '未知状态'}</span></div><div className="reply-job-message"><span>客户消息</span><p>{job.message.text}</p></div>{job.reply && <div className="reply-job-draft"><span><Bot size={12} />{job.status === 'sent' ? '已核实发送的回复' : '回复草稿'}</span><p>{job.reply}</p></div>}{job.reason && <div className="reply-job-reason"><AlertCircle size={12} /><span>{job.reason}</span></div>}{job.status === 'unknown' && <p className="reply-unknown-note">请打开微信核对是否已发送；系统不会重试这条消息，避免重复回复。</p>}<div className="reply-job-actions">{job.status === 'draft' && <><button className="btn secondary sm" onClick={() => { void navigator.clipboard.writeText(job.reply || '').then(() => notify('草稿已复制，请核对后在微信发送')).catch(() => notify('复制失败，请手动选择草稿正文', true)); }}><FileText size={13} />复制草稿</button><button className="btn primary sm" disabled={!!busy || !canSend} title={!canSend ? sendUnavailableReason : undefined} onClick={() => { void actOnJob(job, 'approve'); }}>{busy === job.id ? <Loader2 size={13} className="spin" /> : <Send size={13} />}确认并发送</button><button className="btn secondary sm" disabled={!!busy || connection !== 'ready'} onClick={() => { void actOnJob(job, 'reject'); }}><X size={13} />拒绝</button></>}{!['sent', 'ignored', 'cancelled'].includes(job.status) && <button className="btn ghost sm" disabled={!!busy} onClick={() => { void takeover(job.customerId, !taken); }}><Hand size={13} />{taken ? '恢复托管' : '人工接管'}</button>}{job.sendMessageId && <span className="reply-send-proof"><CheckCircle2 size={11} />已记录发送回执</span>}</div></article>; })}</div> : <div className="empty-state reply-empty"><Bot size={33} /><h3>{connection === 'cloud' ? '云端不读取或发送微信消息' : runtime?.running ? '正在等待所选客户的新消息' : '从一条经过审阅的回复开始'}</h3><p>{connection === 'cloud' ? '商品资料与规则会保存，实际队列和记录由本机服务提供。' : runtime?.running ? '没有新消息时不会生成或发送测试回复。' : '默认使用手动审阅模式。先选择客户、保存规则，再启动本地回复。'}</p>{tab === 'queue' && <button className="btn secondary" onClick={() => setTab('rules')}><Settings2 size={14} />设置回复规则</button>}</div>}
    </section><aside className="reply-center-aside"><section className="card reply-master-card"><div><span className="reply-side-icon"><ShieldCheck size={21} /></span><label className="reply-switch"><input type="checkbox" disabled={!!busy} aria-label="侧栏自动回复总开关" checked={draft.enabled} onChange={event => { void setMaster(event.target.checked); }} /><span /></label></div><h3>{draft.enabled ? '回复总开关已打开' : '回复总开关已关闭'}</h3><p>{dirty ? '规则尚未保存，点击保存并启动后才会按新规则运行。' : savedEnabled ? '是否实际收发，以左侧本机运行状态为准。' : '开启前不会自动收发；你可以先准备资料和规则。'}</p><span className="badge purple">{draft.mode === 'review' ? '手动审阅模式' : '自动回复模式'}</span></section><section className="card reply-boundary-card"><h3><Monitor size={16} />运行须知</h3><ul><li>保持电脑版微信登录、本地服务运行。</li><li>{runtime?.generatorMode === 'browser' ? '当前需保持本页面打开协作生成。' : '后台模式由本机服务处理；关闭本地服务会停止监听。'}</li><li>人工接管后，该客户不会自动发送。</li><li>结果未知须核对微信，不会自动重发。</li></ul></section>{(runtime?.takeovers?.length ?? 0) > 0 && <section className="card reply-takeovers"><h3><Hand size={16} />人工接管中</h3>{runtime?.takeovers.map(id => <div key={id}><span>{state.customers.find(customer => customer.id === id)?.name || '客户'}</span><button className="reply-link-button" disabled={!!busy} onClick={() => { void takeover(id, false); }}>恢复托管</button></div>)}</section>}</aside></div>
  </div>;
}
