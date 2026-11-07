'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Bot, Check, CheckCircle2, ChevronRight, Download, FileText, Hand, Loader2, Monitor, Pause, Play, RefreshCw, Save, Search, Send, Settings2, ShieldCheck, Sparkles, UserRound, X } from 'lucide-react';
import type { AppState, Customer, ReplyJobStatus, ReplyJobView, ReplyResult, ReplySettings, ReplyWork, SharedProps } from '../../lib/types';
import { loadSavedReplyConfig, localRepliesAvailable, replyRequest, replySettingsFor, WEEKDAYS } from './reply-ui';
import { assertWorkspaceCurrent, captureWorkspace, subscribeWorkspaceInvalidation, workspaceFetch } from '../../lib/client-workspace';
import NativeSender from './native-sender';
import ReplyWaitTime from './reply-wait-time';
import { replyWaitLabel } from './reply-timing';
import { assertManualReceipt, manualReplyError, manualReplyTerminal, observeManualReply, parseManualReplyRecord, prepareManualAttempt, type ManualAttempt, type ManualReplyRecord } from './manual-reply-control';

type ReplyAdapter = { configured?: boolean; canReceive?: boolean; canSend?: boolean; canManualSend?: boolean; message?: string; type?: string };
type Runtime = { running: boolean; generatorMode: 'background' | 'browser'; configReady: boolean; counts: Record<ReplyJobStatus, number>; jobs: ReplyJobView[]; takeovers: string[]; pausedReason?: string; adapter?: ReplyAdapter };
const STATUSES: Record<ReplyJobStatus, { label: string; color: string }> = { queued: { label: '等待处理', color: 'slate' }, generating: { label: '正在拟稿', color: 'purple' }, draft: { label: '待人工审阅', color: 'purple' }, ready: { label: '准备发送', color: 'amber' }, sending: { label: '正在发送', color: 'amber' }, sent: { label: '已核实发送', color: 'green' }, handoff: { label: '需人工接管', color: 'amber' }, failed: { label: '处理失败', color: 'slate' }, unknown: { label: '发送结果未知', color: 'amber' }, ignored: { label: '已忽略', color: 'slate' }, cancelled: { label: '已取消', color: 'slate' } };
const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';
const messageFor = (error: unknown) => error instanceof Error ? error.name === 'TimeoutError' ? '本地组件响应超时，请检查客序本地服务。' : error.message : '操作失败，请检查本地服务后重试。';
const timeLabel = (value: string) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : value; };

type ManualComposerProps = { source: ReplyJobView; customer: Customer; related: ReplyJobView[]; connected: boolean; canSend: boolean; busyElsewhere: boolean; unavailableReason: string; onWorking: (working: boolean) => void; onRefresh: () => Promise<void>; notify: SharedProps['notify'] };

function ManualReplyComposer(props: ManualComposerProps) {
  const { source, customer, related, connected, canSend, busyElsewhere, unavailableReason } = props;
  const [text, setText] = useState('');
  const [record, setRecord] = useState<ManualReplyRecord>({ attempt: null, blockedTexts: [] });
  const [receipt, setReceipt] = useState<ReplyJobView | null>(null);
  const [note, setNote] = useState('');
  const [working, setWorking] = useState(false);
  const [checkedUnknown, setCheckedUnknown] = useState(false);
  const [invalidated, setInvalidated] = useState(false);
  const recordRef = useRef(record), mounted = useRef(false), activeRequest = useRef<AbortController | null>(null), submitting = useRef(false);
  const storageKey = useRef(''), expected = useRef<ReturnType<typeof captureWorkspace> | null>(null), handledReceipt = useRef(''), hydrated = useRef(false), propsRef = useRef(props);
  propsRef.current = props;

  const storeRecord = (next: ManualReplyRecord, required = false) => {
    if (!storageKey.current) { if (required) throw new Error('当前工作区尚未准备好，请刷新后再发送。'); return; }
    try { sessionStorage.setItem(storageKey.current, JSON.stringify(next)); }
    catch { if (required) throw new Error('无法保留本次发送标识，请检查浏览器存储后再发送。'); }
    recordRef.current = next; setRecord(next);
  };

  const acceptReceipt = (job: ReplyJobView, attempt: ManualAttempt) => {
    if (!mounted.current || !expected.current) return;
    assertWorkspaceCurrent(expected.current);
    assertManualReceipt(job, source, attempt);
    const fingerprint = `${job.id}:${job.status}:${job.sendMessageId || ''}`;
    if (handledReceipt.current === fingerprint) return;
    handledReceipt.current = fingerprint;
    const status = job.status === 'sent' ? 'sent' : job.status === 'unknown' ? 'unknown' : manualReplyTerminal(job) ? 'failed' : 'submitted';
    const blockedTexts = status === 'unknown' ? [...new Set([...recordRef.current.blockedTexts, attempt.text])].slice(-20) : recordRef.current.blockedTexts;
    storeRecord({ attempt: { ...attempt, jobId: job.id, status }, blockedTexts });
    setReceipt(job);
    setNote(status === 'sent' ? '已核实发送，当前会话保持人工接管。' : status === 'unknown' ? '发送结果未知，请到微信核对；本条不会自动重发。' : status === 'failed' ? job.reason || '本次未发送成功，请检查本机状态。' : '正在发送并核对微信记录…');
    if (status === 'sent') setText(current => current.trim() === attempt.text ? '' : current);
  };

  useEffect(() => {
    mounted.current = true;
    try {
      expected.current = captureWorkspace();
      storageKey.current = `kexu:manual-reply:v1:${expected.current.token}:${source.id}`;
      const restored = parseManualReplyRecord(sessionStorage.getItem(storageKey.current), source.id);
      recordRef.current = restored; setRecord(restored);
      if (restored.attempt && restored.attempt.status !== 'sent') setText(restored.attempt.text);
      hydrated.current = true;
    } catch { setInvalidated(true); }
    const unsubscribe = subscribeWorkspaceInvalidation(() => { activeRequest.current?.abort(); setInvalidated(true); });
    return () => { mounted.current = false; unsubscribe(); activeRequest.current?.abort(); if (submitting.current) propsRef.current.onWorking(false); };
  }, [source.id]);

  useEffect(() => {
    if (!hydrated.current || !mounted.current || invalidated) return;
    const attempt = recordRef.current.attempt;
    if (attempt) {
      const match = related.find(job => job.requestId === attempt.requestId);
      if (match) { try { acceptReceipt(match, attempt); } catch (error) { setNote(messageFor(error)); } }
      return;
    }
    // 页面重开后只恢复未决尝试，不把历史已发送文字放回新的输入框。
    const pending = related.find(job => job.requestId && job.reply && !recordRef.current.blockedTexts.includes(job.reply) && (job.status === 'unknown' || !manualReplyTerminal(job)));
    if (pending) {
      const restored: ManualAttempt = { sourceJobId: source.id, requestId: pending.requestId!, text: pending.reply!, jobId: pending.id, status: pending.status === 'unknown' ? 'unknown' : 'submitted' };
      try { acceptReceipt(pending, restored); setText(current => current || restored.text); } catch (error) { setNote(messageFor(error)); }
    }
  }, [related, invalidated]);

  const sendOrCheck = async () => {
    if (submitting.current || busyElsewhere || invalidated || !connected || !expected.current) return;
    const previous = recordRef.current.attempt;
    if ((!previous || previous.status === 'sent' || previous.status === 'failed') && !canSend) { setNote(unavailableReason); return; }
    let attempt: ManualAttempt;
    try {
      assertWorkspaceCurrent(expected.current);
      attempt = prepareManualAttempt(source.id, previous && !['sent', 'failed'].includes(previous.status) ? previous.text : text, previous, recordRef.current.blockedTexts, () => crypto.randomUUID());
      // 先保存请求标识和原文，断线、刷新或重复点击仍只核对同一次提交。
      storeRecord({ ...recordRef.current, attempt }, true);
    } catch (error) { setNote(messageFor(error)); return; }
    submitting.current = true; setWorking(true); propsRef.current.onWorking(true);
    const controller = new AbortController(); activeRequest.current = controller;
    try {
      let job: ReplyJobView;
      if (attempt.jobId) job = (await replyRequest<{ job: ReplyJobView }>(`/jobs/${encodeURIComponent(attempt.jobId)}`, undefined, controller.signal)).job;
      else job = (await replyRequest<{ job: ReplyJobView }>('/manual', { jobId: source.id, requestId: attempt.requestId, text: attempt.text }, controller.signal)).job;
      assertWorkspaceCurrent(expected.current);
      if (!mounted.current || controller.signal.aborted) return;
      acceptReceipt(job, attempt);
      attempt = { ...attempt, jobId: job.id };
      if (!manualReplyTerminal(job)) {
        const latest = await observeManualReply(source, attempt, async (id, signal) => (await replyRequest<{ job: ReplyJobView }>(`/jobs/${encodeURIComponent(id)}`, undefined, signal)).job, controller.signal);
        assertWorkspaceCurrent(expected.current);
        if (latest) { job = latest; acceptReceipt(latest, attempt); }
      }
      if (!mounted.current || controller.signal.aborted) return;
      if (job.status === 'sent') propsRef.current.notify('手动回复已核实发送，会话保持人工接管');
      else if (!manualReplyTerminal(job)) setNote('发送结果尚未确认，已保留本次提交；请点击“检查发送结果”。');
      await propsRef.current.onRefresh();
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setNote(`${messageFor(error)}；已保留原文和发送标识，请检查本次结果，不要重复新建发送。`);
    } finally {
      submitting.current = false; propsRef.current.onWorking(false);
      if (mounted.current) setWorking(false);
    }
  };

  const unresolved = record.attempt?.status === 'submitted' || record.attempt?.status === 'unknown';
  const error = manualReplyError(text.trim());
  const knownUnknown = record.attempt?.status === 'unknown';
  const unavailable = invalidated ? '微信工作区已切换，请刷新后操作。' : customer.source === 'demo' ? '虚拟客户不参与微信发送。' : !connected ? '请在本地页面连接微信发送组件。' : !canSend ? unavailableReason : '';
  return <section className="reply-manual-composer" aria-label={`手动回复${customer.name}`}><div className="reply-manual-heading"><h4><Hand size={14} />手动回复</h4><span>发送给 {customer.name}</span></div>
    {receipt?.reply && <div className={`reply-manual-last ${receipt.status === 'sent' ? 'sent' : ''}`}><span>{receipt.status === 'sent' ? '最近一次人工回复' : '本次提交内容'}</span><p>{receipt.reply}</p></div>}
    <label className="field"><span className="sr-only">给{customer.name}的手动回复</span><textarea className="input" rows={3} maxLength={300} aria-label={`给${customer.name}的手动回复`} placeholder={`输入要发送给${customer.name}的文字…`} value={text} disabled={working || unresolved || !!unavailable || busyElsewhere} onChange={event => setText(event.target.value)} /></label>
    <div className="reply-manual-footer"><span>{text.length}/300 · 发送后保持人工接管</span><button type="button" className="btn primary sm" disabled={working || busyElsewhere || invalidated || !connected || (!unresolved && (!!unavailable || !!error || record.blockedTexts.includes(text.trim())))} title={unresolved ? '只检查本次提交，不创建另一条发送' : unavailable || error || undefined} onClick={() => { void sendOrCheck(); }}>{working ? <Loader2 size={14} className="spin" /> : unresolved ? <RefreshCw size={14} /> : <Send size={14} />}{working ? '正在核对…' : unresolved ? '检查发送结果' : '发送到微信'}</button></div>
    {(note || unavailable) && <p className={`reply-manual-note ${receipt?.status === 'sent' ? 'sent' : ''}`} role="status">{note || unavailable}</p>}
    {knownUnknown && <div className="reply-manual-unknown"><label><input type="checkbox" checked={checkedUnknown} disabled={working || busyElsewhere} onChange={event => setCheckedUnknown(event.target.checked)} />我已在微信核对这条消息</label><button type="button" className="reply-link-button" disabled={!checkedUnknown || working || busyElsewhere} onClick={() => { storeRecord({ attempt: null, blockedTexts: record.blockedTexts }); setText(''); setCheckedUnknown(false); setNote('可以输入另一条消息；上一条未知正文不会重复发送。'); }}>写另一条回复</button></div>}
  </section>;
}

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
  const waitSaveBusy = useRef(false);
  const stopped = useRef(false);
  const runtimeRef = useRef(runtime);
  const savedSettings = replySettingsFor(state);
  const previousSavedSettings = useRef(savedSettings);
  const canReceive = connection === 'ready' && runtime?.adapter?.canReceive === true;
  const canSend = connection === 'ready' && runtime?.adapter?.canSend === true;
  const canManualSend = connection === 'ready' && runtime?.adapter?.canManualSend === true;
  const sendUnavailableReason = runtime?.adapter?.message || '自动发送尚未接通或尚未通过本机验收；当前可先生成草稿。';
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedSettings) || keywords !== draft.handoffKeywords.join('，');
  const autoUnavailable = draft.mode === 'auto' && !canSend;
  const startUnavailableReason = !canReceive ? runtime?.adapter?.message || '本地读取适配器尚未就绪' : autoUnavailable ? '自动发送尚不可用，请先在“回复规则”中选择“手动审阅”。' : undefined;
  const startLabel = draft.mode === 'review' ? dirty ? '保存并启动草稿接待' : '启动草稿接待' : dirty ? '保存并启动自动回复' : '启动自动回复';
  const candidates = state.customers.filter(customer => customer.source !== 'demo' && customer.wechatId);
  const filteredCustomers = candidates.filter(customer => `${customer.name} ${customer.wechatId}`.toLowerCase().includes(customerQuery.toLowerCase()));
  const jobs = runtime?.jobs ?? [];
  const actionable = jobs.filter(job => job.kind !== 'manual' && ['draft', 'handoff', 'unknown', 'failed', 'queued', 'generating', 'ready', 'sending'].includes(job.status));
  const filteredJobs = (tab === 'queue' ? actionable : jobs).filter(job => jobFilter === 'all' || job.status === jobFilter);

  useEffect(() => { stateRef.current = state; propsRef.current = { onChange, notify }; }, [state, onChange, notify]);
  useEffect(() => { runtimeRef.current = runtime; }, [runtime]);
  useEffect(() => {
    const next = replySettingsFor(state), previous = previousSavedSettings.current;
    const added = next.selectedCustomerIds.filter(id => !previous.selectedCustomerIds.includes(id));
    setDraft(current => ({ ...current, debounceSeconds: next.debounceSeconds, autoEnrollNewContacts: current.autoEnrollNewContacts === previous.autoEnrollNewContacts ? next.autoEnrollNewContacts : current.autoEnrollNewContacts, selectedCustomerIds: [...new Set([...current.selectedCustomerIds, ...added])] }));
    previousSavedSettings.current = next;
  }, [state]);

  async function browserWork(signal: AbortSignal) {
    if (workerBusy.current || stopped.current) return;
    workerBusy.current = true;
    try {
      const expected = captureWorkspace();
      const work = await replyRequest<{ jobs: ReplyWork[] }>('/work', {}, signal);
      for (const job of work.jobs ?? []) {
        if (signal.aborted || stopped.current || !alive.current || !runtimeRef.current?.running) break;
        assertWorkspaceCurrent(expected);
        let result: ReplyResult;
        try {
          const response = await workspaceFetch('/api/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId: job.customerId, message: job.message, ...(job.messages ? { messages: job.messages } : {}), context: job.context }), signal }, expected);
          const generated = await response.json() as ReplyResult & { error?: string };
          assertWorkspaceCurrent(expected);
          if (!response.ok) throw new Error(generated.error || '回复生成失败');
          result = generated;
        } catch (error) {
          if (signal.aborted || isAbort(error)) break;
          await replyRequest(`/jobs/${encodeURIComponent(job.id)}/result`, { leaseId: job.leaseId, error: messageFor(error) }, signal);
          continue;
        }
        assertWorkspaceCurrent(expected);
        await replyRequest(`/jobs/${encodeURIComponent(job.id)}/result`, { leaseId: job.leaseId, result }, signal);
      }
    } catch (error) { if (alive.current && !isAbort(error)) setRuntimeError(messageFor(error)); }
    finally { workerBusy.current = false; }
  }

  const refreshStatus = async (signal?: AbortSignal) => {
    if (stopped.current) return;
    if (!localRepliesAvailable()) { setConnection('cloud'); return; }
    try {
      const next = await replyRequest<Runtime>('/status', undefined, signal);
      if (!alive.current || stopped.current || signal?.aborted) return;
      if (typeof next.running !== 'boolean' || !Array.isArray(next.jobs)) throw new Error('本地回复状态不完整，请检查组件版本');
      setRuntime(next); runtimeRef.current = next; setConnection('ready'); setRuntimeError('');
      if (next.running && next.generatorMode === 'browser') {
        if (!workController.current || workController.current.signal.aborted) workController.current = new AbortController();
        void browserWork(workController.current.signal);
      }
    } catch (error) { if (alive.current && !isAbort(error)) { setConnection('error'); setRuntimeError(messageFor(error)); } }
  };

  useEffect(() => {
    alive.current = true; stopped.current = false; controller.current = new AbortController();
    // 此处仅查询运行状态；启动监听与发送必须由商家主动操作。
    const timer = setInterval(() => { void refreshStatus(controller.current?.signal); }, 4000);
    const unsubscribe = subscribeWorkspaceInvalidation(message => { stopped.current = true; clearInterval(timer); controller.current?.abort(); workController.current?.abort(); setRuntime(null); runtimeRef.current = null; setConnection('error'); setRuntimeError(message); setBusy(''); });
    void refreshStatus(controller.current.signal);
    return () => { alive.current = false; stopped.current = true; unsubscribe(); clearInterval(timer); controller.current?.abort(); workController.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const validate = (settings: ReplySettings) => {
    if (settings.businessHours.enabled && (!settings.businessHours.days.length || settings.businessHours.start >= settings.businessHours.end)) throw new Error('请设置有效的营业日及营业时间，开始时间需早于结束时间');
    if (!Number.isInteger(settings.maxReplyChars) || settings.maxReplyChars < 50 || settings.maxReplyChars > 1000) throw new Error('单条回复长度应为 50 至 1000 字');
    if (!Number.isInteger(settings.cooldownSeconds) || settings.cooldownSeconds < 5 || settings.cooldownSeconds > 3600) throw new Error('回复间隔应为 5 至 3600 秒');
    if (!Number.isInteger(settings.debounceSeconds ?? 10) || (settings.debounceSeconds ?? 10) < 0 || (settings.debounceSeconds ?? 10) > 3600) throw new Error('回复等待时间应为 0 至 3600 秒的整数');
    if (settings.enabled && !settings.selectedCustomerIds.length && settings.autoEnrollNewContacts === false) throw new Error('请选择客户，或开启自动接待新私聊');
    if (settings.selectedCustomerIds.length > 500) throw new Error('本机接待最多支持 500 位客户');
    const selected = candidates.filter(customer => settings.selectedCustomerIds.includes(customer.id));
    if (new Set(selected.map(customer => customer.wechatId)).size !== selected.length) throw new Error('所选客户包含重复微信标识，请每个私聊只选择一份档案');
  };

  const saveRules = async (startAfter = false) => {
    if (busy) return;
    setBusy(startAfter ? 'start' : 'save');
    try {
      const idsAtSave = new Set(stateRef.current.customers.map(customer => customer.id));
      let settings = { ...draft, debounceSeconds: replySettingsFor(stateRef.current).debounceSeconds, selectedCustomerIds: draft.selectedCustomerIds.filter(id => candidates.some(customer => customer.id === id)), handoffKeywords: [...new Set(keywords.split(/[,，、\n]/).map(value => value.trim()).filter(Boolean))] };
      validate(settings);
      if (startAfter && !settings.enabled) throw new Error('请先开启自动回复总开关，再保存并启动');
      if (startAfter && !localRepliesAvailable()) throw new Error('请在本机启动客序后运行自动回复，云端仅管理规则');
      if (startAfter && !canReceive) throw new Error(runtime?.adapter?.message || '本地读取组件尚未就绪，未启动接待');
      if (startAfter && settings.mode === 'auto' && !canSend) throw new Error(sendUnavailableReason);
      if (localRepliesAvailable() && runtimeRef.current?.running) { await replyRequest('/pause', {}); workController.current?.abort(); }
      const current = stateRef.current;
      const newlyEnrolled = current.customers.filter(customer => !idsAtSave.has(customer.id) && customer.autoReplyEnabled && !customer.humanTakeover && replySettingsFor(current).selectedCustomerIds.includes(customer.id));
      settings = { ...settings, selectedCustomerIds: [...new Set([...settings.selectedCustomerIds, ...newlyEnrolled.map(customer => customer.id)])] };
      const next: AppState = { ...current, replySettings: settings, customers: current.customers.map(customer => ({ ...customer, autoReplyEnabled: settings.selectedCustomerIds.includes(customer.id) })) };
      if (!await propsRef.current.onChange(next)) return;
      setDraft(settings); setKeywords(settings.handoffKeywords.join('，'));
      if (localRepliesAvailable()) {
        try { const latest = await loadSavedReplyConfig(); await replyRequest('/config', latest); setDraft(latest.settings); }
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

  const saveWaitTime = async (seconds: number): Promise<boolean> => {
    if (busy || waitSaveBusy.current || stopped.current) return false;
    waitSaveBusy.current = true; setBusy('wait');
    try {
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) throw new Error('回复等待时间应为 0 至 3600 秒的整数');
      const expected = captureWorkspace();
      if (localRepliesAvailable()) { await replyRequest('/pause', {}, controller.current?.signal); assertWorkspaceCurrent(expected); workController.current?.abort(); }
      if (!alive.current || stopped.current) return false;
      assertWorkspaceCurrent(expected);
      // 仅更新当前已保存规则的等待值，不能把规则页尚未提交的其他字段带入保存。
      const current = stateRef.current;
      const settings = { ...replySettingsFor(current), debounceSeconds: seconds };
      const next: AppState = { ...current, replySettings: settings };
      if (!await propsRef.current.onChange(next)) return false;
      assertWorkspaceCurrent(expected);
      if (!alive.current || stopped.current) return false;
      setDraft(previous => ({ ...previous, debounceSeconds: seconds }));
      if (localRepliesAvailable()) {
        try { await replyRequest('/config', await loadSavedReplyConfig(), controller.current?.signal); assertWorkspaceCurrent(expected); }
        catch (error) { await refreshStatus(); throw new Error(`等待时间已保存，但本机配置未同步：${messageFor(error)}。接待保持暂停，请检查后重新启动。`); }
        await refreshStatus();
      }
      propsRef.current.notify(`回复等待时间已保存为${replyWaitLabel(seconds)}；接待已暂停，请重新点击启动。其他未保存的规则保持不变。`);
      return true;
    } catch (error) { if (alive.current && !isAbort(error)) propsRef.current.notify(messageFor(error), true); return false; }
    finally { waitSaveBusy.current = false; if (alive.current) setBusy(''); }
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
      if (localRepliesAvailable()) { try { await replyRequest('/config', await loadSavedReplyConfig()); } catch { /* 总开关已保存且运行已暂停，下一次启动前仍会重新同步。 */ } await refreshStatus(); }
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
      if (!enabled && localRepliesAvailable()) { await replyRequest('/config', await loadSavedReplyConfig()); await replyRequest('/takeover', { customerId, enabled: false }); }
      await refreshStatus(); propsRef.current.notify(enabled ? '已转人工接管，该客户后续不会自动发送' : '已恢复该客户的托管规则');
    } catch (error) { propsRef.current.notify(messageFor(error), true); }
    finally { if (alive.current) setBusy(''); }
  };

  const waiting = runtime?.counts?.draft ?? 0;
  const handoffCount = (runtime?.counts?.handoff ?? 0) + (runtime?.counts?.unknown ?? 0);
  const savedEnabled = replySettingsFor(state).enabled;

  return <div className="auto-reply-page"><section className={`card reply-control-bar ${connection === 'ready' && runtime?.running ? 'running' : ''}`}><span className="reply-control-icon"><Bot size={27} /></span><div className="reply-control-copy"><div><h2>{connection === 'cloud' ? '微信回复在本机运行' : connection === 'checking' ? '正在检查本地回复组件' : connection === 'error' ? '本地回复组件暂未连接' : runtime?.running ? savedSettings.mode === 'review' ? '草稿接待正在运行' : '客户回复服务正在运行' : '本地回复已暂停'}</h2><span className={`reply-runtime-dot ${runtime?.running && connection === 'ready' ? 'active' : ''}`} /><span className="badge green">{savedSettings.autoEnrollNewContacts !== false ? '新好友自动建档并接待' : '仅接待已选客户'}</span></div><p>{connection === 'cloud' ? '你可以在这里管理知识和规则；读取与发送需在 Windows 本机启动客序。' : connection === 'error' ? runtimeError : runtime?.pausedReason || (runtime?.running ? runtime.generatorMode === 'browser' ? '浏览器协作模式：请保持本页打开，关闭后将停止生成新回复。' : savedSettings.mode === 'review' ? '只读取所选客户的新消息并准备草稿，不会自动发送。' : savedSettings.autoEnrollNewContacts !== false ? '已选客户与新好友私聊按规则接待，发送结果会逐条核实并记录。' : '只处理已选客户的新消息，发送结果会逐条核实并记录。' : '默认不收发微信消息。保存规则后，由你主动启动。')}</p></div><div className="reply-control-actions">{connection === 'cloud' ? <a className="btn secondary" href="/kexu-local.zip" download><Download size={15} />下载本地版</a> : <><button className="icon-button" disabled={!!busy} aria-label="刷新自动回复状态" onClick={() => { void refreshStatus(); }}><RefreshCw size={16} /></button>{runtime?.running ? <button className="btn secondary" disabled={!!busy} onClick={() => { void pause(); }}>{busy === 'pause' ? <Loader2 size={15} className="spin" /> : <Pause size={15} />}暂停运行</button> : <button className="btn primary" disabled={!!busy || !canReceive || autoUnavailable} title={startUnavailableReason} onClick={() => { void saveRules(true); }}>{busy === 'start' ? <Loader2 size={15} className="spin" /> : <Play size={15} />}{startLabel}</button>}</>}</div></section>
    <ReplyWaitTime seconds={savedSettings.debounceSeconds ?? 10} running={runtime?.running === true} disabled={!!busy} busy={busy === 'wait'} onSave={saveWaitTime} />
    <NativeSender notify={notify} onChange={() => { void refreshStatus(); }} />
    {connection === 'ready' && !canSend && <div className="reply-alert"><AlertCircle size={16} /><div><strong>{canReceive ? '草稿接待可用，发送组件尚未就绪' : '本地接待尚需准备，发送组件未就绪'}</strong><p>{sendUnavailableReason}</p><p>生成的草稿可以审阅并复制；在上方准备并启用发送组件后，才可使用自动发送和确认发送。</p>{autoUnavailable && <p>当前选择了自动回复模式，发送组件不可用，暂不能启动。请先在“回复规则”中选择“手动审阅”。<button className="reply-link-button" onClick={() => setTab('rules')}>前往回复规则<ChevronRight size={12} /></button></p>}</div></div>}
    <div className="reply-center-stats"><div><span className="reply-stat-icon purple"><FileText size={19} /></span><span>待人工审阅<strong>{connection === 'ready' ? waiting : '—'}</strong></span></div><div><span className="reply-stat-icon green"><CheckCircle2 size={19} /></span><span>已核实发送<strong>{connection === 'ready' ? runtime?.counts?.sent ?? 0 : '—'}</strong></span></div><div><span className="reply-stat-icon amber"><Hand size={19} /></span><span>需人工处理<strong>{connection === 'ready' ? handoffCount : '—'}</strong></span></div><div><span className="reply-stat-icon slate"><UserRound size={19} /></span><span>已选客户<strong>{savedSettings.selectedCustomerIds.length}</strong></span></div></div>
    {connection === 'error' && <div className="reply-alert"><AlertCircle size={16} /><p>当前无法确认本机运行状态，请检查本地服务；下面不会展示伪造的收发记录。</p></div>}
    <div className="reply-center-layout"><section className="card reply-center-main"><div className="reply-center-toolbar"><div className="tabs"><button className={`tab ${tab === 'queue' ? 'active' : ''}`} onClick={() => { setTab('queue'); setJobFilter('all'); }}>处理队列{actionable.length > 0 && <span className="count-label">{actionable.length}</span>}</button><button className={`tab ${tab === 'history' ? 'active' : ''}`} onClick={() => { setTab('history'); setJobFilter('all'); }}>回复记录</button><button className={`tab ${tab === 'rules' ? 'active' : ''}`} onClick={() => setTab('rules')}>回复规则</button></div>{tab !== 'rules' && <select className="input compact" aria-label="筛选回复状态" value={jobFilter} onChange={event => setJobFilter(event.target.value)}><option value="all">全部状态</option>{Object.entries(STATUSES).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select>}</div>
      {tab === 'rules' ? <fieldset className="reply-rules" disabled={!!busy}><div className="reply-rule-block"><div className="reply-rule-heading"><div><h3>自动回复总开关</h3><p>开启并保存后，仍需主动启动本机服务。</p></div><label className="reply-switch"><input type="checkbox" aria-label="自动回复总开关" disabled={!!busy} checked={draft.enabled} onChange={event => { void setMaster(event.target.checked); }} /><span /></label></div><div className="reply-mode-grid"><button className={draft.mode === 'review' ? 'selected' : ''} onClick={() => setDraft({ ...draft, mode: 'review' })}><span><UserRound size={19} />{draft.mode === 'review' && <Check size={14} />}</span><strong>手动审阅</strong><p>{canSend ? 'AI 先拟稿，经你点击确认后发送。' : 'AI 先拟稿，由你复制到微信发送。'}</p></button><button className={draft.mode === 'auto' ? 'selected' : ''} disabled={!canSend} title={!canSend ? sendUnavailableReason : undefined} onClick={() => setDraft({ ...draft, mode: 'auto' })}><span><Sparkles size={19} />{draft.mode === 'auto' && <Check size={14} />}</span><strong>自动回复</strong><p>{canSend ? '规则通过后自动发送，异常转人工。' : '自动发送尚未接通，待本机验收。'}</p></button></div></div>
        <div className="reply-rule-block"><div className="reply-rule-heading"><div><h3>允许回复的客户</h3><p>最多500位真实私聊，群聊和系统账号不参与。</p></div><div className="reply-selection-actions"><button type="button" className="reply-link-button" disabled={!!busy || !filteredCustomers.length} onClick={() => setDraft(current => ({ ...current, selectedCustomerIds: [...new Set([...current.selectedCustomerIds, ...filteredCustomers.map(customer => customer.id)])] }))}>全选{customerQuery ? "搜索结果" : "客户"}</button><button type="button" className="reply-link-button" disabled={!!busy || !draft.selectedCustomerIds.length} onClick={() => setDraft(current => ({ ...current, selectedCustomerIds: current.selectedCustomerIds.filter(id => !filteredCustomers.some(customer => customer.id === id)) }))}>取消全选</button><span className="badge purple">已选 {draft.selectedCustomerIds.length} 位</span></div></div><div className="reply-search reply-customer-search"><Search size={15} /><input aria-label="搜索托管客户" value={customerQuery} onChange={event => setCustomerQuery(event.target.value)} placeholder="搜索客户或微信标识" /></div><div className="reply-customer-selection">{filteredCustomers.length ? filteredCustomers.map(customer => <label key={customer.id}><input type="checkbox" disabled={!draft.selectedCustomerIds.includes(customer.id) && draft.selectedCustomerIds.length >= 500} checked={draft.selectedCustomerIds.includes(customer.id)} onChange={event => setDraft({ ...draft, selectedCustomerIds: event.target.checked ? [...draft.selectedCustomerIds, customer.id] : draft.selectedCustomerIds.filter(id => id !== customer.id) })} /><span className="avatar small" style={{ background: `${customer.color}18`, color: customer.color }}>{customer.name.slice(-2)}</span><span><strong>{customer.name}</strong><small>{customer.wechatId}</small></span>{customer.humanTakeover && <span className="badge amber">人工接管</span>}</label>) : <div className="reply-inline-empty">{candidates.length ? '没有匹配的客户' : '先从微信数据页导入真实私聊，再选择允许回复的客户。'}</div>}</div></div>
        <div className="reply-rule-block"><div className="reply-rule-heading"><div><h3>自动接待新私聊</h3><p>开启后，尚未建档的好友首次发来新消息时，自动建立“新客户”档案并按当前模式回复。群聊、公众号和系统账号除外。</p></div><label className="reply-switch"><input type="checkbox" aria-label="自动接待新私聊" disabled={!!busy} checked={draft.autoEnrollNewContacts !== false} onChange={event => setDraft({ ...draft, autoEnrollNewContacts: event.target.checked })} /><span /></label></div><p className="muted">只处理本次启动后的新消息。已取消勾选、已停用或已转人工的客户不会被重新开启；保存规则后才生效。</p></div><div className="reply-rule-block"><div className="reply-rule-heading"><div><h3>营业时段</h3><p>按北京时间执行，时段外不会自动发送。</p></div><label className="reply-switch"><input type="checkbox" aria-label="限制营业时间" checked={draft.businessHours.enabled} onChange={event => setDraft({ ...draft, businessHours: { ...draft.businessHours, enabled: event.target.checked } })} /><span /></label></div><div className="reply-weekdays">{WEEKDAYS.map(day => <button key={day.value} className={draft.businessHours.days.includes(day.value) ? 'active' : ''} onClick={() => setDraft({ ...draft, businessHours: { ...draft.businessHours, days: draft.businessHours.days.includes(day.value) ? draft.businessHours.days.filter(value => value !== day.value) : [...draft.businessHours.days, day.value] } })}>{day.label}</button>)}</div><div className="reply-time-range"><input className="input" type="time" aria-label="回复开始时间" value={draft.businessHours.start} onChange={event => setDraft({ ...draft, businessHours: { ...draft.businessHours, start: event.target.value } })} /><span>至</span><input className="input" type="time" aria-label="回复结束时间" value={draft.businessHours.end} onChange={event => setDraft({ ...draft, businessHours: { ...draft.businessHours, end: event.target.value } })} /></div></div>
        <div className="reply-rule-block"><h3>边界与转人工</h3><label className="field">转人工关键词<input className="input" value={keywords} maxLength={500} onChange={event => setKeywords(event.target.value)} placeholder="用逗号分隔，如：退款，投诉，人工客服" /></label><div className="form-grid"><label className="field">最长回复（字）<input className="input" type="number" min={50} max={1000} value={draft.maxReplyChars} onChange={event => setDraft({ ...draft, maxReplyChars: Number(event.target.value) })} /></label><label className="field">同一客户回复间隔（秒）<input className="input" type="number" min={5} max={3600} value={draft.cooldownSeconds} onChange={event => setDraft({ ...draft, cooldownSeconds: Number(event.target.value) })} /></label><div className="reply-wait-rule-summary"><span>回复等待时间：{replyWaitLabel(savedSettings.debounceSeconds ?? 10)}，同一客户回复间隔独立生效。</span><a className="reply-link-button" href="#reply-wait-time">修改等待时间<ChevronRight size={12} /></a></div></div><label className="field">回复工作指引<textarea className="input" rows={5} maxLength={5000} value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} /></label><div className="reply-rule-note"><ShieldCheck size={15} /><span>无依据的问题、主动要求人工和发送结果未知的消息均需人工处理；不会自动重发未知结果。</span></div></div><div className="reply-rules-footer"><span>{dirty ? '有尚未保存的修改' : '规则已保存'}</span><button className="btn primary" disabled={!!busy || !dirty} onClick={() => { void saveRules(); }}>{busy === 'save' ? <Loader2 size={15} className="spin" /> : <Save size={15} />}保存规则</button></div></fieldset> : filteredJobs.length ? <div className="reply-jobs">{filteredJobs.map(job => { const customer = state.customers.find(item => item.id === job.customerId); const status = STATUSES[job.status]; const taken = !!customer?.humanTakeover || (runtime?.takeovers ?? []).includes(job.customerId); const manualReplies = jobs.filter(item => item.kind === 'manual' && item.sourceJobId === job.id); return <article className={`reply-job ${job.status === 'unknown' ? 'unknown' : ''}`} key={job.id}><div className="reply-job-heading"><span className="avatar small" style={{ background: `${customer?.color || '#9b87c0'}18`, color: customer?.color || '#9b87c0' }}>{(customer?.name || '微信').slice(-2)}</span><div><strong>{customer?.name || job.chatId}</strong><small>{timeLabel(job.updatedAt || job.createdAt)}</small></div>{job.kind === 'welcome' && <span className="badge green">首次欢迎</span>}{job.kind === 'manual' && <span className="badge purple">人工回复</span>}<span className={`badge ${status?.color || 'slate'}`}>{status?.label || '未知状态'}</span></div><div className="reply-job-message"><span>{job.kind === 'welcome' ? '欢迎触发' : job.kind === 'manual' ? '人工回复对象' : '客户消息'}</span><p>{job.message.text}</p></div>{job.reply && <div className="reply-job-draft"><span><Bot size={12} />{job.kind === 'manual' ? job.status === 'sent' ? '已核实发送的人工回复' : '手动提交的回复' : job.status === 'sent' ? '已核实发送的回复' : '回复草稿'}</span><p>{job.reply}</p></div>}{job.reason && <div className="reply-job-reason"><AlertCircle size={12} /><span>{job.reason}</span></div>}{job.status === 'unknown' && <p className="reply-unknown-note">请打开微信核对是否已发送；系统不会重试这条消息，避免重复回复。</p>}<div className="reply-job-actions">{job.status === 'draft' && <><button className="btn secondary sm" onClick={() => { void navigator.clipboard.writeText(job.reply || '').then(() => notify('草稿已复制，请核对后在微信发送')).catch(() => notify('复制失败，请手动选择草稿正文', true)); }}><FileText size={13} />复制草稿</button><button className="btn primary sm" disabled={!!busy || !canSend} title={!canSend ? sendUnavailableReason : undefined} onClick={() => { void actOnJob(job, 'approve'); }}>{busy === job.id ? <Loader2 size={13} className="spin" /> : <Send size={13} />}确认并发送</button><button className="btn secondary sm" disabled={!!busy || connection !== 'ready'} onClick={() => { void actOnJob(job, 'reject'); }}><X size={13} />拒绝</button></>}{job.kind !== 'manual' && !['sent', 'ignored', 'cancelled'].includes(job.status) && <button className="btn ghost sm" disabled={!!busy} onClick={() => { void takeover(job.customerId, !taken); }}><Hand size={13} />{taken ? '恢复托管' : '人工接管'}</button>}{job.sendMessageId && <span className="reply-send-proof"><CheckCircle2 size={11} />已记录发送回执</span>}</div>{job.kind !== 'manual' && customer && (['handoff', 'failed'].includes(job.status) || taken) && <ManualReplyComposer source={job} customer={customer} related={manualReplies} connected={connection === 'ready'} canSend={canManualSend} busyElsewhere={!!busy && busy !== `manual:${job.id}`} unavailableReason={runtime?.adapter?.canManualSend === false ? '请先启用当前微信账号的本机后台发送组件。' : '当前本地组件尚不支持手动发送，请更新后再试。'} onWorking={working => setBusy(working ? `manual:${job.id}` : '')} onRefresh={refreshStatus} notify={notify} />}</article>; })}</div> : <div className="empty-state reply-empty"><Bot size={33} /><h3>{connection === 'cloud' ? '云端不读取或发送微信消息' : runtime?.running ? '正在等待所选客户的新消息' : '从一条经过审阅的回复开始'}</h3><p>{connection === 'cloud' ? '商品资料与规则会保存，实际队列和记录由本机服务提供。' : runtime?.running ? savedSettings.autoEnrollNewContacts !== false ? '新好友发来消息后会自动建立客户档案；没有新消息时不会主动发送。' : '没有新消息时不会生成或发送测试回复。' : '默认使用手动审阅模式。先选择客户、保存规则，再启动本地回复。'}</p>{tab === 'queue' && <button className="btn secondary" onClick={() => setTab('rules')}><Settings2 size={14} />设置回复规则</button>}</div>}
    </section><aside className="reply-center-aside"><section className="card reply-master-card"><div><span className="reply-side-icon"><ShieldCheck size={21} /></span><label className="reply-switch"><input type="checkbox" disabled={!!busy} aria-label="侧栏自动回复总开关" checked={draft.enabled} onChange={event => { void setMaster(event.target.checked); }} /><span /></label></div><h3>{draft.enabled ? '回复总开关已打开' : '回复总开关已关闭'}</h3><p>{autoUnavailable ? '当前自动回复模式暂不可用，请在回复规则中切换为手动审阅后再启动。' : dirty ? draft.mode === 'review' ? '规则尚未保存，点击“保存并启动草稿接待”后才会按新规则运行。' : '规则尚未保存，点击“保存并启动自动回复”后才会按新规则运行。' : savedEnabled ? '是否实际收发，以左侧本机运行状态为准。' : '开启前不会自动收发；你可以先准备资料和规则。'}</p><span className="badge purple">{draft.mode === 'review' ? '手动审阅模式' : '自动回复模式'}</span></section><section className="card reply-boundary-card"><h3><Monitor size={16} />运行须知</h3><ul><li>保持电脑版微信登录、本地服务运行。</li><li>绑定或切换数据账号：微信数据 → 当前绑定的数据账号。切换会暂停接待，并保留各账号独立的工作区。</li><li>{runtime?.generatorMode === 'browser' ? '当前需保持本页面打开协作生成。' : '原生后台发送组件就绪后，无需微信保持前台，也可最小化。读取和生成仍需本机服务运行。'}</li><li>人工接管后，该客户不会自动发送。</li><li>结果未知须核对微信，不会自动重发。</li></ul></section>{(runtime?.takeovers?.length ?? 0) > 0 && <section className="card reply-takeovers"><h3><Hand size={16} />人工接管中</h3>{runtime?.takeovers.map(id => <div key={id}><span>{state.customers.find(customer => customer.id === id)?.name || '客户'}</span><button className="reply-link-button" disabled={!!busy} onClick={() => { void takeover(id, false); }}>恢复托管</button></div>)}</section>}</aside></div>
  </div>;
}
