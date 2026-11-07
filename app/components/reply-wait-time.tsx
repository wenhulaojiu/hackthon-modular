'use client';

import { useState } from 'react';
import { Clock3, Loader2, Save } from 'lucide-react';
import { replyWaitLabel, replyWaitSeconds, replyWaitValue, type ReplyWaitUnit } from './reply-timing';

type Props = { seconds: number; running: boolean; disabled: boolean; busy: boolean; onSave: (seconds: number) => Promise<boolean> };
const PRESETS = [{ seconds: 10, label: '10秒' }, { seconds: 30, label: '30秒' }, { seconds: 60, label: '1分钟' }, { seconds: 120, label: '2分钟' }, { seconds: 300, label: '5分钟' }];

export default function ReplyWaitTime({ seconds, running, disabled, busy, onSave }: Props) {
  const [entry, setEntry] = useState<{ basis: number; value: string; unit: ReplyWaitUnit }>(() => ({ basis: seconds, value: String(seconds), unit: 'seconds' }));
  const [saved, setSaved] = useState(false);
  // 已保存值变化时按当前单位显示新值，不覆盖其他回复规则的草稿。
  const value = entry.basis === seconds ? entry.value : replyWaitValue(seconds, entry.unit);
  const parsed = replyWaitSeconds(value, entry.unit);
  const dirty = parsed !== seconds;
  const edit = (next: string, unit = entry.unit) => { setEntry({ basis: seconds, value: next, unit }); setSaved(false); };

  return <section className="card reply-wait-card" id="reply-wait-time" aria-labelledby="reply-wait-title">
    <div className="reply-wait-heading"><span className="reply-wait-icon"><Clock3 size={21} /></span><div><h3 id="reply-wait-title">回复等待时间</h3><p>默认10秒，从客户最后一条消息开始计时；连续发消息会重新计时，等客户说完再合并回复。</p></div><span className="reply-wait-current">当前：<strong>{replyWaitLabel(seconds)}</strong></span></div>
    <form onSubmit={event => { event.preventDefault(); if (!disabled && parsed !== null && dirty) void onSave(parsed).then(ok => { if (ok) setSaved(true); }); }}>
      <div className="reply-wait-controls"><label className="reply-wait-input"><span className="sr-only">回复等待时长</span><input className="input" type="number" min={0} max={entry.unit === 'minutes' ? 60 : 3600} step="any" value={value} disabled={disabled} aria-invalid={parsed === null} aria-describedby="reply-wait-help" onChange={event => edit(event.target.value)} /></label><label><span className="sr-only">回复等待时间单位</span><select className="input" value={entry.unit} disabled={disabled} onChange={event => { const unit = event.target.value as ReplyWaitUnit; edit(parsed === null ? value : replyWaitValue(parsed, unit), unit); }}><option value="seconds">秒</option><option value="minutes">分钟</option></select></label><div className="reply-wait-presets">{PRESETS.map(preset => <button key={preset.seconds} type="button" disabled={disabled} className={parsed === preset.seconds ? 'active' : ''} onClick={() => edit(replyWaitValue(preset.seconds, entry.unit))}>{preset.label}</button>)}</div><button className="btn primary sm" type="submit" disabled={disabled || parsed === null || !dirty}>{busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />}{busy ? '正在保存…' : '保存等待时间'}</button></div>
      <p className={`reply-wait-help ${parsed === null ? 'invalid' : ''}`} id="reply-wait-help">{parsed === null ? '请输入0–3600整秒；分钟可填小数，换算后必须是整数秒，最多60分钟。' : parsed === 0 ? '不额外等待，实际回复还包含消息同步与AI生成时间。' : `将等待${replyWaitLabel(parsed)}后处理这一轮消息，实际回复还包含消息同步与AI生成时间。`} 同一客户的回复冷却间隔独立生效。</p>
      <div className="reply-wait-footer"><span>{dirty && parsed !== null ? '等待时间尚未保存。保存会暂停本机接待，之后请重新点击启动。' : saved ? running ? '等待时间已保存，当前接待正在运行。' : '等待时间已保存，接待已暂停；准备好后请重新点击启动。' : '默认10秒；保存只更新等待时间，不会保存其他未提交的规则，也不会自动启动接待。'}</span>{saved && !dirty && <strong role="status">{running ? '已保存 · 运行中' : '已保存 · 需重新启动'}</strong>}</div>
    </form>
  </section>;
}
