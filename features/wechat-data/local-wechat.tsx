'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CalendarDays, Check, CheckCircle2, ChevronRight, Download, FolderInput, Loader2, MessageCircle, Monitor, RefreshCw, Search, ShieldCheck, Square, X } from 'lucide-react';
import { shiftDate, today } from '../../lib/domain';
import { assertWorkspaceCurrent, beginWorkspaceSwitch, captureWorkspace, getWorkspaceScope, setWorkspaceToken, subscribeWorkspaceInvalidation, validWorkspaceToken, workspaceFetch, workspaceHeaders } from '../../lib/client-workspace';
import { assertImportBatchAvailable, createImportQueue, drainImportQueue, importQueueView, pendingImportIds, selectImportResults, type LocalImportQueue, type LocalImportView } from './local-import-queue';

type LocalWechatProps = { onImport: (exports: unknown[]) => Promise<boolean> | boolean; notify: (text: string, error?: boolean) => void };
type BoundAccount = { id: string; label: string; workspaceToken: string };
type Accounts = { active: BoundAccount; accounts: Array<{ id: string; label: string; active: boolean }>; message?: string };
type BridgeStatus = { available?: boolean; configured?: boolean; exporterReady?: boolean; pythonReady?: boolean; version?: string; message?: string; active?: BoundAccount; workspaceToken?: string };
type Chat = { id: string; name: string; type: 'private' };
type Progress = number | string | { current?: number; total?: number; percent?: number; message?: string };
type Job = { status?: string; progress?: Progress; message?: string; error?: string; exports?: unknown[]; messageCount?: number };
type Phase = 'idle' | 'starting' | 'running' | 'importing' | 'success' | 'failed' | 'cancelled';
type Preferences = { selectedIds: string[]; start: string; end: string };
const PREFERENCES_KEY = 'kexu.local-wechat.preferences.v1';
const MAX_CHATS = 20;
const MAX_DAYS = 31;

class BridgeError extends Error {
  constructor(message: string, public status?: number) { super(message); this.name = 'BridgeError'; }
}

const isLocalBrowser = () => typeof window !== 'undefined' && window.location.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(window.location.hostname);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const daysBetween = (start: string, end: string) => Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000) + 1;
const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '本地组件暂时没有响应，请重试。';

async function request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const expected = captureWorkspace();
  // 始终使用同源入口，浏览器不连接其他端口或外部服务。
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 60_000);
  let response: Response;
  try {
    response = await workspaceFetch(`/__local-wechat${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Kexu-Local': '1', Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, cache: 'no-store', credentials: 'same-origin' }, expected);
  } catch (error) {
    if (timedOut) throw new BridgeError('本地组件响应超时，请保持微信及客序本地服务运行后重试。');
    if (isAbort(error)) throw error;
    throw new BridgeError('无法连接本地组件，请保持客序本地服务运行后重试。');
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new BridgeError(response.status === 404 ? '此页面尚未启用本地微信组件。' : '本地组件返回了无法识别的响应，请检查版本后重试。', response.status); }
  assertWorkspaceCurrent(expected);
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.error === 'string' ? payload.error : isRecord(payload) && typeof payload.message === 'string' ? payload.message : `本地组件请求失败（${response.status}）。`;
    throw new BridgeError(message, response.status);
  }
  return payload as T;
}

function progressFor(job: Job) {
  const value = job.progress;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(100, value));
  if (value && typeof value === 'object') {
    if (typeof value.percent === 'number' && Number.isFinite(value.percent)) return Math.max(0, Math.min(100, value.percent));
    if (typeof value.current === 'number' && typeof value.total === 'number' && value.total > 0) return Math.max(0, Math.min(100, value.current / value.total * 100));
  }
  return null;
}

export default function LocalWechat({ onImport, notify }: LocalWechatProps) {
  const [connection, setConnection] = useState<'checking' | 'remote' | 'unavailable' | 'setup' | 'ready' | 'error'>('checking');
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [reading, setReading] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [start, setStart] = useState(() => shiftDate(-6));
  const [end, setEnd] = useState(() => today());
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<number | null>(null);
  const [jobMessage, setJobMessage] = useState('');
  const [failure, setFailure] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [result, setResult] = useState<{ files: number; messages: number | null } | null>(null);
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [accountError, setAccountError] = useState('');
  const [switching, setSwitching] = useState(false);
  const [workspaceLocked, setWorkspaceLocked] = useState(false);
  const [batchView, setBatchView] = useState<LocalImportView | null>(null);
  const [preferencesKey] = useState(() => `${PREFERENCES_KEY}:${getWorkspaceScope()}`);
  const alive = useRef(true);
  const generation = useRef(0);
  const jobId = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusController = useRef<AbortController | null>(null);
  const chatController = useRef<AbortController | null>(null);
  const jobController = useRef<AbortController | null>(null);
  const cancelController = useRef<AbortController | null>(null);
  const accountController = useRef<AbortController | null>(null);
  const batchQueue = useRef<LocalImportQueue | null>(null);
  const batchProcessing = useRef(false);
  const propsRef = useRef({ onImport, notify });
  useEffect(() => { propsRef.current = { onImport, notify }; }, [onImport, notify]);
  const working = phase === 'starting' || phase === 'running' || phase === 'importing';
  const selectionLocked = working || cancelling || !!batchView?.hasPendingJob;

  const clearPolling = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; jobController.current?.abort(); jobController.current = null; };

  const checkAccounts = async () => {
    if (!isLocalBrowser()) return;
    accountController.current?.abort();
    const controller = new AbortController(); accountController.current = controller;
    try {
      const info = await request<Accounts>('/accounts', controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      if (!Array.isArray(info.accounts) || !info.active?.id || !validWorkspaceToken(info.active.workspaceToken)) throw new Error('本地账号信息不完整，请更新本地版后重试。');
      setAccounts(info); setSelectedAccount(info.active.id); setAccountError('');
    } catch (error) { if (alive.current && !isAbort(error)) setAccountError(errorMessage(error)); }
  };

  const selectAccount = async () => {
    if (workspaceLocked || switching || !accounts || selectedAccount === accounts.active.id || !accounts.accounts.some(account => account.id === selectedAccount)) return;
    let headers: Headers;
    try { headers = workspaceHeaders({ 'X-Kexu-Local': '1', Accept: 'application/json', 'Content-Type': 'application/json' }); }
    catch (error) { setAccountError(errorMessage(error)); return; }
    setSwitching(true); setAccountError('');
    // 切换请求沿用旧标识；业务请求先统一停止，成功后整页重新加载。
    beginWorkspaceSwitch();
    try {
      const response = await fetch('/__local-wechat/accounts/select', { method: 'POST', headers, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(60_000), body: JSON.stringify({ accountId: selectedAccount }) });
      const payload = await response.json() as { error?: string; active?: BoundAccount; workspaceToken?: string; reload?: boolean };
      if (!response.ok) throw new Error(payload.error || '账号切换未完成，请刷新后核对绑定状态。');
      if (!validWorkspaceToken(payload.workspaceToken) || payload.active?.id !== selectedAccount || payload.active.workspaceToken !== payload.workspaceToken || payload.reload !== true) throw new Error('账号切换结果无法确认，请刷新后核对绑定状态。');
      setWorkspaceToken(payload.workspaceToken);
      window.location.reload();
    } catch (error) { if (alive.current) { setSwitching(false); setAccountError(`${errorMessage(error)} 请刷新工作空间后再操作。`); } }
  };

  const checkStatus = async () => {
    if (workspaceLocked) return;
    if (!isLocalBrowser()) { setConnection('remote'); return; }
    statusController.current?.abort();
    const controller = new AbortController(); statusController.current = controller;
    setConnection('checking'); setStatusMessage('');
    try {
      const info = await request<BridgeStatus>('/status', controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      if (!isRecord(info)) throw new Error('本地组件状态格式不正确，请更新本地版。');
      setStatus(info); setStatusMessage(typeof info.message === 'string' ? info.message : '');
      setConnection(info.available && info.configured && info.exporterReady && info.pythonReady && !info.message ? 'ready' : 'setup');
    } catch (error) {
      if (!alive.current || isAbort(error)) return;
      setStatus(null); setStatusMessage(errorMessage(error));
      setConnection(error instanceof BridgeError && error.status === 404 ? 'unavailable' : 'error');
    }
  };

  useEffect(() => {
    alive.current = true;
    const unsubscribe = subscribeWorkspaceInvalidation(() => {
      generation.current += 1; clearPolling(); statusController.current?.abort(); chatController.current?.abort(); cancelController.current?.abort(); accountController.current?.abort();
      jobId.current = null; batchQueue.current = null; setBatchView(null); setPreferencesLoaded(false); setWorkspaceLocked(true); setChats([]); setChatsLoaded(false); setSelectedIds([]); setQuery(''); setResult(null); setWarnings([]); setReading(false); setCancelling(false); setPhase('idle'); setFailure(''); setJobMessage('');
    });
    const initialCheck = setTimeout(() => {
      if (!alive.current) return;
      try { captureWorkspace(); } catch { return; }
      if (isLocalBrowser()) {
        try {
          const stored: unknown = JSON.parse(localStorage.getItem(preferencesKey) || 'null');
          if (isRecord(stored)) {
            if (Array.isArray(stored.selectedIds)) setSelectedIds([...new Set(stored.selectedIds.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 256))]);
            if (typeof stored.start === 'string' && validDate(stored.start)) setStart(stored.start);
            if (typeof stored.end === 'string' && validDate(stored.end)) setEnd(stored.end);
          }
        } catch { /* 本地偏好不可用时继续使用默认设置。 */ }
      }
      setPreferencesLoaded(true);
      void checkStatus();
      void checkAccounts();
    }, 0);
    return () => { alive.current = false; unsubscribe(); clearTimeout(initialCheck); generation.current += 1; clearPolling(); statusController.current?.abort(); chatController.current?.abort(); cancelController.current?.abort(); accountController.current?.abort(); };
    // 状态查询仅在挂载时进行，不读取微信会话。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!preferencesLoaded || workspaceLocked || !isLocalBrowser()) return;
    const preferences: Preferences = { selectedIds, start, end };
    try { localStorage.setItem(preferencesKey, JSON.stringify(preferences)); } catch { /* 禁用本地存储不影响提取。 */ }
  }, [selectedIds, start, end, preferencesLoaded, preferencesKey, workspaceLocked]);

  const readChats = async () => {
    if (connection !== 'ready' || reading || selectionLocked) return;
    chatController.current?.abort(); const controller = new AbortController(); chatController.current = controller;
    setReading(true); setFailure(''); setResult(null); setPhase('idle');
    try {
      // 关键词只在主动点击后提交；本次返回的会话会校验并加入当前列表。
      const response = await request<{ chats?: unknown[]; warnings?: unknown[] }>('/chats', controller.signal, { query: query.trim() });
      if (!alive.current || controller.signal.aborted) return;
      if (!Array.isArray(response.chats)) throw new Error('本地组件没有返回可用会话列表。');
      const seen = new Set<string>();
      const privateChats = response.chats.filter((item): item is Chat => {
        if (!isRecord(item) || item.type !== 'private' || typeof item.id !== 'string' || typeof item.name !== 'string') return false;
        if (!item.id || item.id.includes('@chatroom') || item.id === 'filehelper' || item.name === '文件传输助手' || seen.has(item.id)) return false;
        seen.add(item.id); return true;
      });
      const merged = chatsLoaded ? [...chats.filter(chat => !seen.has(chat.id)), ...privateChats] : privateChats;
      const validatedIds = new Set(merged.map(chat => chat.id));
      setChats(merged); setChatsLoaded(true); setWarnings((response.warnings ?? []).filter((item): item is string => typeof item === 'string').slice(0, 8));
      setSelectedIds(previous => previous.filter(item => validatedIds.has(item)));
      if (!privateChats.length) propsRef.current.notify('没有可选择的好友私聊，请确认微信已登录且本机已有聊天。');
    } catch (error) {
      if (!alive.current || isAbort(error)) return;
      setChatsLoaded(false); setFailure(errorMessage(error));
      if (error instanceof BridgeError && error.status === 404) setConnection('unavailable');
      propsRef.current.notify(errorMessage(error), true);
    } finally { if (alive.current && !controller.signal.aborted) setReading(false); }
  };

  const toggleChat = (chatId: string) => {
    if (selectionLocked) return;
    if (selectedIds.includes(chatId)) setSelectedIds(current => current.filter(item => item !== chatId));
    else setSelectedIds(current => [...current, chatId]);
  };

  const runBatches = async (queue: LocalImportQueue, token: number) => {
    if (batchProcessing.current || !alive.current || generation.current !== token) return;
    batchProcessing.current = true;
    const controller = new AbortController(); jobController.current = controller;
    let expected: ReturnType<typeof captureWorkspace>;
    try { expected = captureWorkspace(); }
    catch (error) { batchProcessing.current = false; setPhase('failed'); setFailure(errorMessage(error)); return; }
    const assertActive = () => {
      assertWorkspaceCurrent(expected);
      if (!alive.current || generation.current !== token || controller.signal.aborted) throw new DOMException('提取已暂停', 'AbortError');
    };
    try {
      await drainImportQueue(queue, {
        assertActive,
        createExport: async (ids, from, to) => {
          // 长队列可能超过目录缓存期限；每批重新核对，不改变当前全选与筛选状态。
          const directory = await request<{ chats?: unknown[] }>('/chats', controller.signal, { query: '' });
          assertActive(); assertImportBatchAvailable(ids, directory.chats);
          const response = await request<{ jobId?: unknown }>('/exports', controller.signal, { chatIds: ids, start: from, end: to });
          if (typeof response.jobId !== 'string' || !response.jobId) throw new Error('本地组件未返回任务编号，已停止后续批次。');
          return response.jobId;
        },
        readJob: id => request<Job>(`/jobs/${encodeURIComponent(id)}`, controller.signal),
        importExports: exports => propsRef.current.onImport(exports),
        wait: () => new Promise<void>((resolve, reject) => {
          const abort = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; reject(new DOMException('提取已暂停', 'AbortError')); };
          if (controller.signal.aborted) { abort(); return; }
          controller.signal.addEventListener('abort', abort, { once: true });
          timer.current = setTimeout(() => { timer.current = null; controller.signal.removeEventListener('abort', abort); resolve(); }, 1200);
        }),
        update: (stage, job) => {
          assertActive(); jobId.current = queue.jobId; setBatchView(importQueueView(queue));
          const portion = stage === 'importing' ? 0.95 : stage === 'complete' ? 0 : (progressFor(job as Job || {}) ?? 0) / 100 * 0.9;
          const currentSize = queue.batches[queue.index]?.length ?? 0;
          setProgress(Math.min(100, (queue.completedPeople + currentSize * portion) / queue.totalPeople * 100));
          if (stage === 'complete') return;
          setPhase(stage); const prefix = `第 ${queue.index + 1}/${queue.batches.length} 批 · 已处理 ${queue.completedPeople}/${queue.totalPeople} 位`;
          const detail = stage === 'starting' ? '正在创建下一批本机提取任务…' : stage === 'importing' ? '正在保存本批客户档案…' : typeof job?.progress === 'string' ? job.progress : job?.message || '正在提取本批私聊，请保持微信登录。';
          setJobMessage(`${prefix}：${detail}`);
        },
        completed: () => {
          const remaining = pendingImportIds(queue);
          if (alive.current && generation.current === token) setSelectedIds(remaining);
          // 每批持久化成功后立即保存余下选择，刷新或重试时不再自动提交已完成批次。
          try { localStorage.setItem(preferencesKey, JSON.stringify({ selectedIds: remaining, start: queue.start, end: queue.end })); } catch { /* 本地存储不可用时仍保留当前页面的批次进度。 */ }
        },
      });
      assertActive(); jobId.current = null;
      setResult({ files: queue.files, messages: queue.messages }); setPhase(queue.files ? 'success' : 'idle');
      setJobMessage(`已处理全部 ${queue.totalPeople} 位私聊，导入 ${queue.files} 份记录；未启动自动回复。`);
      propsRef.current.notify(queue.files ? `已分批提取并导入 ${queue.files} 份私聊记录` : '所有批次均已检查，此时间范围内没有可导入的聊天。');
    } catch (error) {
      if (!alive.current || generation.current !== token || isAbort(error)) return;
      jobId.current = queue.jobId; setBatchView(importQueueView(queue));
      setPhase('failed'); setFailure(`${errorMessage(error)} 已处理 ${queue.completedPeople}/${queue.totalPeople} 位，余下 ${queue.totalPeople - queue.completedPeople} 位保留待重试，后续批次未启动。`);
      propsRef.current.notify(errorMessage(error), true);
    } finally { batchProcessing.current = false; if (jobController.current === controller) jobController.current = null; }
  };

  const extractAndImport = async () => {
    if (working || batchProcessing.current || cancelling || reading || connection !== 'ready' || workspaceLocked) return;
    // 连接中断后先继续检查原任务，避免重复启动同一批提取。
    if (batchQueue.current?.jobId) {
      clearPolling(); generation.current += 1;
      setPhase('running'); setFailure(''); setJobMessage('正在重新检查上次本机任务，新选择暂不生效…');
      void runBatches(batchQueue.current, generation.current); return;
    }
    if (!chatsLoaded) { propsRef.current.notify('请先点击“读取微信会话”，核对本次可用的私聊。', true); return; }
    const currentIds = selectedIds.filter(value => chats.some(chat => chat.id === value));
    if (currentIds.length < 1 || currentIds.length !== selectedIds.length) { propsRef.current.notify('请选择当前已核验列表中的私聊客户。', true); return; }
    if (!validDate(start) || !validDate(end) || daysBetween(start, end) < 1 || daysBetween(start, end) > MAX_DAYS) { propsRef.current.notify('请选择有效的起止日期，单次范围最多 31 天，包含结束当天。', true); return; }
    if (end > today()) { propsRef.current.notify('结束日期不能晚于今天。', true); return; }
    clearPolling(); generation.current += 1;
    const previous = batchQueue.current;
    const remaining = previous ? pendingImportIds(previous) : [];
    const queue = previous && previous.start === start && previous.end === end && remaining.length === currentIds.length && currentIds.every(id => remaining.includes(id)) ? previous : createImportQueue(currentIds, start, end);
    batchQueue.current = queue; setBatchView(importQueueView(queue));
    setPhase('starting'); setFailure(''); setResult(null); setProgress(null); setJobMessage('正在创建本机提取任务…');
    void runBatches(queue, generation.current);
  };

  const cancelJob = async () => {
    if (phase === 'importing' || cancelling) return;
    const currentJobId = jobId.current;
    generation.current += 1; clearPolling(); setCancelling(true);
    const controller = new AbortController(); cancelController.current = controller;
    try {
      if (!currentJobId) { setPhase('cancelled'); setJobMessage('已停止页面等待。若任务已在本机启动，它可能仍会继续；再次提取前请确认本地任务状态。'); return; }
      const cancelled = await request<Job>(`/jobs/${encodeURIComponent(currentJobId)}/cancel`, controller.signal, {});
      if (!alive.current || controller.signal.aborted) return;
      if (['complete', 'cancelled', 'canceled', 'failed', 'error'].includes(cancelled.status || '')) { jobId.current = null; if (batchQueue.current) batchQueue.current.jobId = null; }
      if (batchQueue.current) setBatchView(importQueueView(batchQueue.current));
      setPhase('cancelled'); setJobMessage('已请求取消本批及后续批次。已完成导入保留，余下选择保留；原任务未确认结束时请先继续检查。');
    } catch (error) {
      if (!alive.current || isAbort(error)) return;
      setPhase('cancelled'); setJobMessage('已停止页面等待，取消请求未送达，本机任务可能仍在运行。'); setFailure(errorMessage(error));
    } finally { if (alive.current && !controller.signal.aborted) setCancelling(false); }
  };

  const visibleChats = chats.filter(chat => `${chat.name} ${chat.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const visibleIds = visibleChats.map(chat => chat.id);
  const visibleSelected = visibleIds.filter(id => selectedIds.includes(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && visibleSelected === visibleIds.length;
  const rangeDays = validDate(start) && validDate(end) ? daysBetween(start, end) : 0;
  const validRange = rangeDays >= 1 && rangeDays <= MAX_DAYS && end <= today();
  const needsSetup = ['remote', 'unavailable', 'setup', 'error'].includes(connection);
  const ready = connection === 'ready' && !workspaceLocked;

  return <section className="card local-wechat-panel" aria-labelledby="local-wechat-title">
    <div className="local-wechat-heading"><span className="local-wechat-symbol"><MessageCircle size={23} /></span><div><div className="local-wechat-title-row"><h2 id="local-wechat-title">微信聊天，一键提取到客序</h2><span className="local-wechat-local-label"><Monitor size={11} />本机读取</span></div><p>选择私聊和时间范围，提取完成后自动导入，无需手动选择文件。</p></div><span className={`local-wechat-status ${ready ? 'ready' : ''}`}><span />{connection === 'checking' ? '检查本地组件' : ready ? '本地组件已就绪' : connection === 'remote' ? '请在本机使用' : '本地组件待准备'}</span></div>

    <div className="local-wechat-account"><div><h3>当前绑定的数据账号</h3><p>此处切换数据绑定，不会自动判断当前微信登录账号。</p></div>{isLocalBrowser() ? <><div className="local-wechat-account-controls"><label><span className="sr-only">选择微信数据账号</span><select className="input" value={selectedAccount} disabled={!accounts || switching || workspaceLocked || working} onChange={event => setSelectedAccount(event.target.value)}>{accounts ? accounts.accounts.map(account => <option key={account.id} value={account.id}>{account.label}{account.active ? '（当前绑定）' : ''}</option>) : <option value="">正在获取本地绑定信息</option>}</select></label><button className="btn secondary sm" disabled={!accounts || !selectedAccount || selectedAccount === accounts.active.id || switching || workspaceLocked || working} onClick={() => { void selectAccount(); }}>{switching ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}{switching ? '正在切换…' : '切换数据账号'}</button></div>{accounts && <p className="local-wechat-account-current">已绑定：{accounts.active.label}<small>{accounts.active.id}</small></p>}<p>切换会暂停接待并保留旧数据。首次绑定的新工作区从空客户开始；AI 设置沿用，模型密钥共享。</p>{accounts?.message && <p>{accounts.message}</p>}{accountError && <p className="local-wechat-account-error" role="alert">{accountError}</p>}</> : <p>账号数据绑定仅在 Windows 本地版中可用。</p>}</div>

    {connection === 'checking' && <div className="local-wechat-checking" role="status"><Loader2 size={17} className="spin" /><span>仅检查本地组件配置，不读取微信会话。</span></div>}

    {needsSetup && <div className="local-wechat-setup"><div className="local-wechat-setup-copy"><h3>{connection === 'remote' || connection === 'unavailable' ? '在本机运行即可直接读取微信' : '准备好本地组件，再开始提取'}</h3><p>{connection === 'remote' ? '当前是在线工作台。请下载本地版，在这台 Windows 电脑中启动，再读取本人有权使用的微信私聊。' : statusMessage || '请按照下面的步骤准备本地环境，完成后重新检查。'}</p><ol className="local-wechat-install-steps"><li><span>1</span>解压本地版，运行<strong>启动客序.cmd</strong></li><li><span>2</span>运行<strong>安装微信提取组件.cmd</strong></li><li><span>3</span>登录电脑版微信，回到本页提取</li></ol><div className="local-wechat-setup-actions"><a className="btn primary" href="/kexu-local.zip" download><Download size={15} />下载 Windows 本地版</a>{connection !== 'remote' && <button className="btn secondary" onClick={() => { void checkStatus(); }}><RefreshCw size={14} />重新检查</button>}</div><p className="local-wechat-file-note"><FolderInput size={13} />组件就绪后可主动选择私聊并提取；在线版不会假装连接本机微信。</p></div><div className="local-wechat-setup-aside"><ShieldCheck size={29} /><h4>由你选择，才会读取</h4><p>页面不会自动扫描微信，也不会自动发消息。读取仅限已登录微信中当前可用的私聊。</p>{connection !== 'remote' && status && <div className="local-wechat-components"><span><i className={status.pythonReady ? 'ok' : ''} />Python 环境{status.pythonReady ? '已就绪' : '待安装'}</span><span><i className={status.exporterReady ? 'ok' : ''} />微信提取组件{status.exporterReady ? '已就绪' : '待安装'}</span><span><i className={status.configured ? 'ok' : ''} />本地配置{status.configured ? '已就绪' : '待配置'}</span></div>}</div></div>}

    {ready && <div className="local-wechat-content"><div className="local-wechat-workflow"><div className="local-wechat-step"><span className="local-wechat-step-number">1</span><div><h3>选择微信私聊</h3><p>可全选私聊，自动按每批最多 {MAX_CHATS} 位导入。</p></div><button className="btn secondary sm" disabled={reading || selectionLocked} onClick={() => { void readChats(); }}>{reading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}{reading ? '正在读取…' : chatsLoaded ? '重新读取会话' : '读取微信会话'}</button></div>
      <div className="local-wechat-presearch"><div className="local-wechat-search"><Search size={15} /><input aria-label="搜索微信私聊" maxLength={100} value={query} onChange={event => setQuery(event.target.value)} placeholder="可先输入客户名称，再点击读取会话" disabled={selectionLocked || reading} />{query && <button className="icon-button" aria-label="清空搜索" disabled={selectionLocked || reading} onClick={() => setQuery('')}><X size={13} /></button>}</div><span>按关键词读取，或留空查看全部私聊</span></div>
      {!chatsLoaded && !reading && <div className="local-wechat-read-prompt"><MessageCircle size={24} /><div><strong>点击“读取微信会话”后，再选择客户</strong><p>{selectedIds.length ? `已保留 ${selectedIds.length} 位客户的选择，重新读取后会校验是否仍可用。` : '只有你主动点击，才会访问本机微信会话。'}</p></div></div>}
      {reading && <div className="local-wechat-read-prompt" role="status"><Loader2 className="spin" size={22} /><div><strong>正在读取可用的私聊会话</strong><p>请保持电脑版微信已登录。</p></div></div>}
      {chatsLoaded && !reading && <div className="local-wechat-selection"><div className="local-wechat-list-toolbar"><small>当前筛选 {visibleChats.length} 位私聊</small><span>已选 <strong>{selectedIds.length}</strong> 位</span><div className="local-wechat-bulk-actions"><button className="local-wechat-text-button" disabled={selectionLocked || !visibleIds.length} onClick={() => setSelectedIds(current => selectImportResults(current, visibleIds, !allVisibleSelected))}>{allVisibleSelected ? '取消全选当前结果' : '全选当前结果'}</button>{!!selectedIds.length && <button className="local-wechat-text-button" disabled={selectionLocked} onClick={() => setSelectedIds([])}>清空全部</button>}</div></div><div className="local-wechat-chat-list">{visibleChats.length ? visibleChats.map(chat => <label key={chat.id} className={`local-wechat-chat ${selectedIds.includes(chat.id) ? 'selected' : ''}`}><input type="checkbox" checked={selectedIds.includes(chat.id)} disabled={selectionLocked} onChange={() => toggleChat(chat.id)} /><span className="local-wechat-chat-avatar">{chat.name.slice(-2) || '微'}</span><span className="local-wechat-chat-name"><strong>{chat.name || '未命名联系人'}</strong><small>{chat.id}</small></span><span className="local-wechat-checkmark">{selectedIds.includes(chat.id) && <Check size={12} />}</span></label>) : <div className="local-wechat-no-chats"><Search size={21} /><p>{chats.length ? '没有匹配的私聊，试试其他关键词。' : '没有可用的好友私聊，请检查微信登录和本地组件。'}</p></div>}</div><p className="local-wechat-selection-note">全选和取消全选只影响当前筛选结果，筛选外已选 {selectedIds.length - visibleSelected} 位会保留。每批最多 {MAX_CHATS} 位；工作区最多500位客户，仍受消息条数和容量限制，超限会停止并保留余下选择。刷新后需重新读取并核验余下会话。</p></div>}
      {warnings.length > 0 && <div className="local-wechat-warning"><AlertCircle size={15} /><div>{warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}
    </div><div className="local-wechat-range"><div className="local-wechat-step"><span className="local-wechat-step-number">2</span><div><h3>选择时间范围</h3><p>默认近 7 天，单次最多 {MAX_DAYS} 天。</p></div></div><div className="local-wechat-date-fields"><label>开始日期<div><CalendarDays size={15} /><input type="date" aria-label="开始提取日期" value={start} max={end || today()} disabled={selectionLocked} onChange={event => setStart(event.target.value)} /></div></label><span className="local-wechat-date-separator">—</span><label>结束日期<div><CalendarDays size={15} /><input type="date" aria-label="结束提取日期" value={end} min={start || undefined} max={today()} disabled={selectionLocked} onChange={event => setEnd(event.target.value)} /></div></label></div><div className="local-wechat-range-footer"><span className={!validRange ? 'invalid' : ''}>{validRange ? `共 ${rangeDays} 天，包含结束当天` : '请选择不超过 31 天的有效范围，结束日期不晚于今天'}</span><div>{[7, 14, 30].map(days => <button key={days} disabled={selectionLocked} className={start === shiftDate(1 - days) && end === today() ? 'active' : ''} onClick={() => { setStart(shiftDate(1 - days)); setEnd(today()); }}>近 {days} 天</button>)}</div></div></div>
      {batchView && <div className="local-wechat-batch-summary" role="status">本次共 {batchView.totalPeople} 位，分 {batchView.batches} 批；已处理 {batchView.completedPeople} 位，剩余 {batchView.remainingPeople} 位。{batchView.remainingPeople > 0 && ` 当前第 ${batchView.batch}/${batchView.batches} 批。`}每批最多 {MAX_CHATS} 位，已保存批次不会因后续失败被撤销。</div>}
      <div className="local-wechat-extract-row"><div><strong>{selectedIds.length && chatsLoaded ? `提取 ${selectedIds.length} 位客户的私聊` : '准备好后，一键提取并导入'}</strong><p>全选后自动分批提取，每批保存成功再继续下一批；不会调用 AI、确认消费或启动自动回复。</p></div><button className="btn primary" disabled={!chatsLoaded || (!selectedIds.length && !batchView?.hasPendingJob) || !validRange || working || reading || cancelling} onClick={() => { void extractAndImport(); }}>{working ? <Loader2 className="spin" size={16} /> : <FolderInput size={16} />}{phase === 'importing' ? '正在导入…' : working ? '正在提取…' : batchView?.hasPendingJob ? '继续检查提取任务' : batchView?.remainingPeople && ['failed', 'cancelled'].includes(phase) ? '继续导入余下联系人' : phase === 'failed' ? '重试提取并导入' : '一键提取并导入'}</button></div>
    </div>}

    {(working || cancelling) && <div className="local-wechat-progress" role="status" aria-live="polite"><div><Loader2 size={16} className="spin" /><strong>{cancelling ? '正在取消任务…' : jobMessage}</strong>{progress !== null && <span>{Math.round(progress)}%</span>}{phase !== 'importing' && <button className="local-wechat-text-button" disabled={cancelling} onClick={() => { void cancelJob(); }}><Square size={11} />取消</button>}</div><div className={`local-wechat-progress-track ${progress === null ? 'indeterminate' : ''}`}><span style={progress === null ? undefined : { width: `${progress}%` }} /></div><p>{phase === 'importing' ? '正在保存到客序，请稍候。' : '离开或刷新页面会停止后续批次，本机当前任务可能继续。已导入批次保留；需要停止时请先点击“取消”。'}</p></div>}
    {failure && <div className="local-wechat-error" role="alert"><AlertCircle size={17} /><div><strong>{phase === 'failed' ? batchView?.completedPeople ? '后续批次已暂停，已导入内容保留' : '本次未完成导入' : '请检查本地提取状态'}</strong><p>{failure}</p><span>{batchView?.hasPendingJob ? '页面已停止等待，本机任务可能仍在运行。可继续检查原任务，或先请求取消。' : '请确认微信已登录、本地组件安装完成；调整范围后可以重试。'}</span>{batchView?.hasPendingJob && phase === 'failed' && <button className="local-wechat-text-button" onClick={() => { void cancelJob(); }} disabled={cancelling}><Square size={11} />取消本机任务</button>}</div></div>}
    {phase === 'success' && result && <div className="local-wechat-result" role="status"><CheckCircle2 size={20} /><div><strong>提取并导入成功</strong><p>{result.files} 份私聊记录{result.messages !== null ? ` · ${result.messages.toLocaleString()} 条消息` : ''}已导入。接下来可在客户档案中核对聊天，主动生成画像。</p></div><ChevronRight size={17} /></div>}
    {(phase === 'cancelled' || (phase === 'idle' && jobMessage)) && !working && <div className="local-wechat-job-note" role="status"><AlertCircle size={15} /><p>{jobMessage}</p></div>}
  </section>;
}
