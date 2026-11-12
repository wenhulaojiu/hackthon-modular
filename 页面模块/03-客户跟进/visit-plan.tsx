'use client';

import { useState } from 'react';
import type { AppState } from '../../lib/types';
import { today } from '../../lib/domain';
import { createRevisitTasks, DEFAULT_REVISIT_SCRIPT, REVISIT_LIMITS } from '../../lib/visit-plan';

type Props = {
  state: AppState;
  notify: (text: string, error?: boolean) => void;
  onApply: (next: AppState) => Promise<boolean>;
};

/** 只生成回访待办与可编辑话术，不自动发送，也不替客户做医疗判断。 */
export default function VisitPlanPanel({ state, notify, onApply }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [startDate, setStartDate] = useState(() => today());
  const [intervalDays, setIntervalDays] = useState('30');
  const [times, setTimes] = useState('3');
  const [script, setScript] = useState(() => state.guideKnowledge?.policy.revisitScript || DEFAULT_REVISIT_SCRIPT);
  const [busy, setBusy] = useState(false);
  const candidates = state.customers.filter(customer => customer.source !== 'demo');

  const apply = async () => {
    if (busy) return;
    if (!selected.length) { notify('请先选择需要回访的客户', true); return; }
    const result = createRevisitTasks(state, {
      customerIds: selected, startDate, intervalDays: Number(intervalDays), times: Number(times), script,
    });
    if (result.error) { notify(result.error, true); return; }
    setBusy(true);
    try {
      const success = await onApply(result.state);
      if (success) {
        notify(`已生成 ${result.created.length} 条回访待办`);
        setSelected([]);
      }
    } catch (error) { notify(error instanceof Error ? error.message : '回访待办保存失败', true); }
    finally { setBusy(false); }
  };

  return <details className="card" style={{ marginBottom: 16, padding: 16 }}>
    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>定期回访</summary>
    <div className="form-grid" style={{ marginTop: 12 }}>
      <label className="field">首次回访日期<input className="input" type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></label>
      <label className="field">间隔天数（{REVISIT_LIMITS.minIntervalDays}–{REVISIT_LIMITS.maxIntervalDays}）<input className="input" type="number" min={REVISIT_LIMITS.minIntervalDays} max={REVISIT_LIMITS.maxIntervalDays} value={intervalDays} onChange={event => setIntervalDays(event.target.value)} /></label>
      <label className="field">回访次数（1–{REVISIT_LIMITS.maxTimes}）<input className="input" type="number" min={1} max={REVISIT_LIMITS.maxTimes} value={times} onChange={event => setTimes(event.target.value)} /></label>
    </div>
    <label className="field" style={{ display: 'block', marginTop: 12 }}>回访话术（{script.length}/{REVISIT_LIMITS.maxScriptChars} 字）<textarea className="input" rows={4} maxLength={REVISIT_LIMITS.maxScriptChars} value={script} onChange={event => setScript(event.target.value)} /></label>
    <div style={{ marginTop: 12, maxHeight: 160, overflowY: 'auto' }}>
      {candidates.length ? candidates.map(customer => <label className="checkbox-label" key={customer.id} style={{ display: 'inline-flex', marginRight: 16 }}>
        <input type="checkbox" checked={selected.includes(customer.id)} onChange={event => setSelected(current => event.target.checked ? [...current, customer.id] : current.filter(id => id !== customer.id))} />{customer.name}
      </label>) : <p className="muted small">暂无可安排回访的客户</p>}
    </div>
    <div className="modal-actions" style={{ marginTop: 12 }}><button className="btn primary" type="button" disabled={busy} onClick={() => { void apply(); }}>{busy ? '生成中…' : '生成回访待办'}</button><span className="muted small">已选 {selected.length} 位客户</span></div>
  </details>;
}
