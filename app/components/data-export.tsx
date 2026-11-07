'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, CalendarDays, CheckCircle2, Database, FileJson, FileSpreadsheet, Loader2, ShieldCheck, Users, Wallet, X } from 'lucide-react';
import type { AppState } from '../../lib/types';
import { today } from '../../lib/domain';
import { buildCustomersCsv, buildFullDataJson, buildOrdersCsv, buildTasksCsv } from '../../lib/data-export';

type ExportKind = 'json' | 'customers' | 'orders' | 'tasks';
type DataExportProps = { state: AppState; open: boolean; onClose: () => void; notify: (text: string, error?: boolean) => void; prepareState?: () => Promise<AppState> };
const EXPORTS = {
  json: { label: '完整数据', extension: 'json', build: buildFullDataJson },
  customers: { label: '客户档案', extension: 'csv', build: buildCustomersCsv },
  orders: { label: '消费记录', extension: 'csv', build: buildOrdersCsv },
  tasks: { label: '跟进任务', extension: 'csv', build: buildTasksCsv },
};

export default function DataExport({ state, open, onClose, notify, prepareState }: DataExportProps) {
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const [lastExport, setLastExport] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', close); return () => document.removeEventListener('keydown', close);
  }, [open, busy, onClose]);

  const download = async (kind: ExportKind) => {
    if (busy) return;
    setBusy(kind); setLastExport('');
    try {
      const snapshot = prepareState ? await prepareState() : state;
      if (!alive.current) return;
      const item = EXPORTS[kind];
      const content = item.build(snapshot);
      const fileName = `客序-${item.label}-${today()}.${item.extension}`;
      const url = URL.createObjectURL(new Blob([content], { type: kind === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      setLastExport(fileName); notify(`已发起下载：${fileName}`);
    } catch (error) { notify(error instanceof Error ? error.message : '数据导出失败，请重试', true); }
    finally { if (alive.current) setBusy(null); }
  };
  if (!open) return null;
  const messages = state.customers.reduce((sum, customer) => sum + customer.messages.length, 0);
  const downloadButton = (kind: ExportKind, text = '下载 CSV') => <button className={`btn ${kind === 'json' ? 'primary' : 'secondary'} sm`} disabled={!!busy} onClick={() => { void download(kind); }}>{busy === kind ? <Loader2 size={14} className="spin" /> : <ArrowDownToLine size={14} />}{busy === kind ? '正在准备…' : text}</button>;

  return <div className="modal-overlay data-export-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="modal data-export-modal" role="dialog" aria-modal="true" aria-labelledby="data-export-title"><div className="data-export-heading"><span className="data-export-symbol"><Database size={23} /></span><div><h2 id="data-export-title">导出工作空间数据</h2><p>选择需要的内容，每次单独下载一份文件。</p></div><button className="icon-button" aria-label="关闭数据导出" disabled={!!busy} onClick={onClose}><X size={19} /></button></div>
    <article className="data-export-complete"><div className="data-export-format"><FileJson size={22} /><span>JSON</span></div><div><h3>完整数据</h3><p>客户、画像、聊天、消费、跟进任务、商品与服务、回复规则和 AI 设置。</p><span>{state.customers.length} 位客户 · {messages.toLocaleString()} 条消息 · {state.orders.length} 笔记录</span></div>{downloadButton('json', '下载 JSON')}</article>
    <div className="data-export-section-label"><span>按用途导出表格</span><small>UTF-8 编码 · Excel 兼容</small></div><div className="data-export-options"><article><span className="data-export-option-icon customers"><Users size={21} /></span><h3>客户档案</h3><p>画像、偏好、标签，以及已确认交易计算的累计净消费与消费次数。</p><small>{state.customers.length} 位客户</small>{downloadButton('customers')}</article><article><span className="data-export-option-icon orders"><Wallet size={21} /></span><h3>消费记录</h3><p>逐笔保留金额、状态与证据，单列实际计入金额，退款清晰可查。</p><small>{state.orders.length} 笔记录</small>{downloadButton('orders')}</article><article><span className="data-export-option-icon tasks"><CalendarDays size={21} /></span><h3>跟进任务</h3><p>客户、跟进日期、处理状态、优先级及准备好的话术。</p><small>{state.tasks.length} 项任务</small>{downloadButton('tasks')}</article></div>
    <div className="data-export-scope"><FileSpreadsheet size={15} /><p>表格包含所有状态的记录。待确认和已拒绝消费不计入金额与次数，已确认退款扣减净消费。</p></div><div className="data-export-privacy"><ShieldCheck size={15} /><div><p>不包含保存的模型 API Key、本机密钥配置或本机回复运行队列。完整 JSON 含客户与聊天内容，请妥善保存。</p><p>当前没有一键恢复入口，完整 JSON 可供留存和后续迁移；设置表单中未保存的修改不包含在内。</p></div></div>{lastExport && <div className="data-export-result" role="status"><CheckCircle2 size={14} /><span>已发起下载：{lastExport}</span></div>}<div className="data-export-footer"><span>每个下载按钮只生成一份文件</span><button className="btn secondary" disabled={!!busy} onClick={onClose}>完成</button></div>
  </section></div>;
}
