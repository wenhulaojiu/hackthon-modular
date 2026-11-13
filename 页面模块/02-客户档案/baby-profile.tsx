'use client';

import { useState, type CSSProperties } from 'react';
import type { BabyProfile, Customer } from '../../lib/types';
import { today } from '../../lib/domain';
import { BABY_FEEDING_LABELS, BABY_FORMULA_STAGES, babyAgeMonths, babyProfileLabel, stageHintForMonths } from '../../lib/baby-milestones';

const BADGE: CSSProperties = { display: 'inline-flex', alignItems: 'center', marginTop: 2, padding: '1px 7px', borderRadius: 9, background: '#fdf2f8', color: '#9d174d', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' };
const EMPTY_BADGE: CSSProperties = { ...BADGE, background: '#f1f5f9', color: '#64748b' };

/** 客户列表里每位客户旁边都显示宝宝档案摘要，没登记的提示补全。 */
export function BabyBadge({ baby }: { baby?: BabyProfile }) {
  const label = babyProfileLabel(baby, today());
  const missing = label === '未登记宝宝档案';
  return <span className="baby-badge" style={missing ? EMPTY_BADGE : BADGE}>{missing ? '＋ 登记宝宝档案' : `${label}`}</span>;
}

type EditorProps = {
  customer: Customer;
  onSave: (patch: Partial<Customer>) => Promise<boolean>;
  notify: (text: string, error?: boolean) => void;
};

const blank = (): BabyProfile => ({ name: '', birthDate: '', ageMonths: undefined, gender: '', feeding: '', formulaStage: '', allergies: '', notes: '' });

/** 客户画像中的宝宝档案编辑区：只记录家长提供的事实与医生建议，不作医疗判断。 */
export default function BabyProfileEditor({ customer, onSave, notify }: EditorProps) {
  const [draft, setDraft] = useState<BabyProfile>(() => ({ ...blank(), ...(customer.baby ?? {}) }));
  const [saving, setSaving] = useState(false);
  const patch = (value: Partial<BabyProfile>) => setDraft({ ...draft, ...value });
  const months = babyAgeMonths(draft, today());

  const save = async () => {
    if (saving) return;
    if (!draft.birthDate && typeof draft.ageMonths !== 'number') { notify('请填写出生日期或宝宝月龄，至少填一项', true); return; }
    if (draft.birthDate && !/^\d{4}-\d{2}-\d{2}$/u.test(draft.birthDate)) { notify('出生日期需为 YYYY-MM-DD', true); return; }
    if (typeof draft.ageMonths === 'number' && (!Number.isInteger(draft.ageMonths) || draft.ageMonths < 0 || draft.ageMonths > 72)) { notify('月龄需为 0 至 72 的整数', true); return; }
    setSaving(true);
    try {
      const success = await onSave({ baby: draft });
      if (success) notify('宝宝档案已保存');
    } catch (error) { notify(error instanceof Error ? error.message : '宝宝档案保存失败', true); }
    finally { setSaving(false); }
  };

  return <section className="detail-section">
    <div className="detail-section-heading"><h3>宝宝档案</h3><span className="muted small">{months === null ? '尚未登记月龄' : `当前 ${months} 个月 · ${stageHintForMonths(months)}`}</span></div>
    <div className="form-grid">
      <label className="field">宝宝小名<input className="input" maxLength={80} value={draft.name ?? ''} onChange={event => patch({ name: event.target.value })} placeholder="选填" /></label>
      <label className="field">出生日期<input className="input" type="date" value={draft.birthDate ?? ''} onChange={event => patch({ birthDate: event.target.value })} /></label>
      <label className="field">月龄（未填出生日期时填写）<input className="input" type="number" min={0} max={72} value={draft.ageMonths ?? ''} onChange={event => patch({ ageMonths: event.target.value === '' ? undefined : Number(event.target.value) })} placeholder="如：6" /></label>
      <label className="field">宝宝性别<select className="input" value={draft.gender ?? ''} onChange={event => patch({ gender: event.target.value as BabyProfile['gender'] })}><option value="">未填写</option><option value="男宝">男宝</option><option value="女宝">女宝</option></select></label>
      <label className="field">喂养方式<select className="input" value={draft.feeding ?? ''} onChange={event => patch({ feeding: event.target.value as BabyProfile['feeding'] })}>{(Object.keys(BABY_FEEDING_LABELS) as Array<NonNullable<BabyProfile['feeding']>>).map(key => <option key={key} value={key}>{BABY_FEEDING_LABELS[key]}</option>)}</select></label>
      <label className="field">奶粉段位<select className="input" value={draft.formulaStage ?? ''} onChange={event => patch({ formulaStage: event.target.value as BabyProfile['formulaStage'] })}>{BABY_FORMULA_STAGES.map(stage => <option key={stage} value={stage}>{stage || '未填写'}</option>)}</select></label>
    </div>
    <label className="field" style={{ display: 'block', marginTop: 8 }}>过敏与注意事项<textarea className="input" rows={2} maxLength={500} value={draft.allergies ?? ''} onChange={event => patch({ allergies: event.target.value })} placeholder="选填" /></label>
    <label className="field" style={{ display: 'block', marginTop: 8 }}>医生建议与备注<textarea className="input" rows={2} maxLength={1000} value={draft.notes ?? ''} onChange={event => patch({ notes: event.target.value })} placeholder="选填" /></label>
    <div className="button-row" style={{ marginTop: 8 }}><button className="btn primary sm" type="button" disabled={saving} onClick={() => { void save(); }}>{saving ? '保存中…' : '保存宝宝档案'}</button></div>
  </section>;
}
