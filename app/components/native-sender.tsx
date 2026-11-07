'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, Loader2, Monitor, Pause, Play, RefreshCw } from 'lucide-react';
import type { NativeSenderStatus } from '../../lib/types';
import { subscribeWorkspaceInvalidation } from '../../lib/client-workspace';
import { localRepliesAvailable, nativeSenderCanEnable, nativeSenderRequest } from './reply-ui';

type Props = { notify: (message: string, error?: boolean) => void; onChange: () => void };
type Action = 'setup' | 'enable' | 'disable';
const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';
const errorMessage = (error: unknown) => error instanceof Error ? error.name === 'TimeoutError' ? '组件响应超时，请检查客序本地服务后重新检查。' : error.message : '暂时无法连接原生发送组件，请重新检查。';

export default function NativeSender({ notify, onChange }: Props) {
  const [status, setStatus] = useState<NativeSenderStatus | null>(null);
  const [connection, setConnection] = useState<'checking' | 'remote' | 'ready' | 'error'>('checking');
  const [busy, setBusy] = useState<Action | ''>('');
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState('');
  const [locked, setLocked] = useState(false);
  const alive = useRef(true);
  const stopped = useRef(false);
  const acting = useRef(false);
  const propsRef = useRef({ notify, onChange });
  const statusController = useRef<AbortController | null>(null);
  const actionController = useRef<AbortController | null>(null);
  useEffect(() => { propsRef.current = { notify, onChange }; }, [notify, onChange]);

  const refresh = async (manual = false) => {
    if (stopped.current || acting.current) return;
    if (!localRepliesAvailable()) { setConnection('remote'); return; }
    if (statusController.current && !manual) return;
    statusController.current?.abort();
    const controller = new AbortController(); statusController.current = controller;
    setChecking(true);
    try {
      const next = await nativeSenderRequest('status', controller.signal);
      if (!alive.current || stopped.current || controller.signal.aborted) return;
      setStatus(next); setConnection('ready'); setFailure('');
      if (manual) propsRef.current.onChange();
    } catch (error) {
      if (alive.current && !stopped.current && !isAbort(error)) { setConnection('error'); setStatus(null); setFailure(errorMessage(error)); }
    } finally {
      if (statusController.current === controller) { statusController.current = null; if (alive.current) setChecking(false); }
    }
  };

  useEffect(() => {
    alive.current = true; stopped.current = false;
    // 进入页面只查询组件状态，不安装、不启用，也不启动自动回复。
    const initialCheck = setTimeout(() => { void refresh(); }, 0);
    const timer = setInterval(() => { void refresh(); }, 5000);
    const unsubscribe = subscribeWorkspaceInvalidation(message => {
      stopped.current = true; clearTimeout(initialCheck); clearInterval(timer); statusController.current?.abort(); actionController.current?.abort();
      setStatus(null); setConnection('error'); setFailure(message); setLocked(true); setBusy(''); setChecking(false);
    });
    return () => { alive.current = false; stopped.current = true; unsubscribe(); clearTimeout(initialCheck); clearInterval(timer); statusController.current?.abort(); actionController.current?.abort(); };
  }, []);

  const act = async (action: Action) => {
    if (stopped.current || acting.current || !status || status.setupState === 'installing') return;
    if (action !== 'disable' && (!status.available || (action === 'enable' && !nativeSenderCanEnable(status)))) return;
    acting.current = true; setBusy(action); setFailure(''); statusController.current?.abort();
    const controller = new AbortController(); actionController.current = controller;
    try {
      const next = await nativeSenderRequest(action, controller.signal);
      if (!alive.current || stopped.current || controller.signal.aborted) return;
      setStatus(next); setConnection('ready'); propsRef.current.onChange();
      propsRef.current.notify(action === 'setup' ? next.setupState === 'installing' ? '正在准备原生发送组件，完成后可启用' : next.installed ? '原生发送组件已准备，可检查后启用' : next.message : action === 'enable' ? next.enabled ? '原生发送组件已启用；自动回复仍需主动启动' : next.message : next.enabled ? next.message || '正在等待本次发送确认，请稍后检查状态' : '原生发送组件已停用');
    } catch (error) {
      if (alive.current && !stopped.current && !isAbort(error)) { setStatus(null); setConnection('error'); setFailure(errorMessage(error)); propsRef.current.notify(errorMessage(error), true); propsRef.current.onChange(); }
    } finally { acting.current = false; if (alive.current) setBusy(''); }
  };

  const installing = busy === 'setup' || status?.setupState === 'installing';
  const ready = connection === 'ready' && !!status?.available && status.installed && status.enabled && status.compatible && status.ready && !installing;
  const label = connection === 'checking' ? '正在检查' : connection === 'remote' ? '请在本机使用' : connection === 'error' ? '状态待确认' : installing ? '正在准备' : !status?.available ? '本机暂不可用' : !status.installed ? status.setupState === 'failed' ? '准备未完成' : '待安装' : !status.enabled ? status.compatible ? '已暂停' : '待启用' : !status.compatible ? '当前不兼容' : ready ? '已就绪' : '等待就绪';

  return <section className={`card native-sender-card ${ready ? 'ready' : ''}`} aria-labelledby="native-sender-title">
    <div className="native-sender-heading"><span className="native-sender-icon"><Monitor size={21} /></span><div><h3 id="native-sender-title">原生后台发送</h3><p>当前非商业比赛组件 · 保持电脑版微信登录，发送无需微信保持前台。</p></div><span className={`native-sender-status ${ready ? 'ready' : ''}`} role="status">{installing || connection === 'checking' ? <Loader2 size={13} className="spin" /> : ready ? <CheckCircle2 size={13} /> : <span />}{label}</span></div>
    <div className="native-sender-body"><div><p>{connection === 'remote' ? '请在 Windows 本地版中安装和启用组件。' : failure || status?.message || '仅检查本机组件状态，不读取聊天或发送消息。'}</p><small>安装和启用只准备发送组件；保存回复规则并主动启动后才会接待。等待客户说完仍按回复规则执行，默认 60 秒。{status?.componentVersion && <span>组件 {status.componentVersion.slice(0, 7)}</span>}</small></div><div className="native-sender-actions">
      {connection !== 'remote' && <button className="btn secondary sm" disabled={locked || !!busy || checking} onClick={() => { void refresh(true); }}>{checking ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}检查状态</button>}
      {status?.available && (!status.installed || status.setupState === 'failed') && <button className="btn primary sm" disabled={locked || !!busy || installing} onClick={() => { void act('setup'); }}>{installing ? <Loader2 size={14} className="spin" /> : <Download size={14} />}{installing ? '正在准备…' : status.setupState === 'failed' ? '重新准备组件' : '安装组件'}</button>}
      {status?.installed && !status.enabled && <button className="btn primary sm" disabled={locked || !!busy || !nativeSenderCanEnable(status)} title="启用时核对当前微信账号与版本，不会自动启动回复" onClick={() => { void act('enable'); }}>{busy === 'enable' ? <Loader2 size={14} className="spin" /> : <Play size={14} />}启用组件</button>}
      {status?.enabled && <button className="btn secondary sm" disabled={locked || !!busy || installing} onClick={() => { void act('disable'); }}>{busy === 'disable' ? <Loader2 size={14} className="spin" /> : <Pause size={14} />}{busy === 'disable' ? '正在停用…' : '停用组件'}</button>}
    </div></div>
    {failure && <div className="native-sender-error" role="alert"><AlertCircle size={14} />组件状态尚未确认，请重新检查后再操作。</div>}
  </section>;
}
