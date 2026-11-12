'use client';

import { useEffect, useRef, useState } from 'react';
import type { AppState, Customer } from '../../lib/types';
import { today } from '../../lib/domain';
import { linkShopRecords, parseShopRecords, parseSpokenNote, type ShopRecord, type SpokenDraft } from '../../lib/customer-profile';

type Props = {
  state: AppState;
  notify: (text: string, error?: boolean) => void;
  onApply: (next: AppState) => Promise<boolean>;
};

type RecognitionResult = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  start: () => void; stop: () => void;
  onresult: ((event: RecognitionResult) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
};
type RecognitionCtor = new () => Recognition;
const COLORS = ['#7566d9', '#6599a2', '#ce956c', '#8d93be', '#9d85b0'];

function speechConstructor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as Window & { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** 语音转写使用浏览器提供的识别能力，转写文本只在导购确认后写入档案。 */
export default function VoiceProfilePanel({ state, notify, onApply }: Props) {
  const [spoken, setSpoken] = useState('');
  const [recording, setRecording] = useState(false);
  const [draft, setDraft] = useState<SpokenDraft | null>(null);
  const [rawRecords, setRawRecords] = useState('');
  const [parsed, setParsed] = useState<ShopRecord[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const recognitionRef = useRef<Recognition | null>(null);
  useEffect(() => () => { recognitionRef.current?.stop(); }, []);

  const startRecording = () => {
    const Ctor = speechConstructor();
    if (!Ctor) { notify('当前浏览器不支持语音识别，可以直接粘贴口述文字', true); return; }
    const recognition = new Ctor();
    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = event => {
      const text = Array.from(event.results).map(row => row[0]?.transcript ?? '').join('');
      if (text) setSpoken(current => `${current}${text}`);
    };
    recognition.onerror = event => notify(`语音识别失败：${event.error ?? '未知原因'}，可改用文本输入`, true);
    recognition.onend = () => setRecording(false);
    recognitionRef.current = recognition;
    try { recognition.start(); setRecording(true); } catch { notify('无法启动语音识别，请检查麦克风权限', true); }
  };

  const parseSpoken = () => {
    if (!spoken.trim()) { notify('请先录入或粘贴口述内容', true); return; }
    setDraft(parseSpokenNote(spoken, state.products ?? []));
  };

  const createFromDraft = async () => {
    if (!draft || busy) return;
    const name = draft.name.trim();
    if (!name) { notify('口述中未识别到客户称呼，请在文本里写明「客户叫某某」后重新解析', true); return; }
    if (state.customers.length >= 500) { notify('客户数已达 500 位上限，请先整理档案', true); return; }
    setBusy(true);
    try {
      const customer: Customer = {
        id: crypto.randomUUID(), name, wechatId: '', color: COLORS[state.customers.length % COLORS.length], stage: '新客户',
        tags: draft.tags, manualTags: ['语音口述建档'], summary: draft.summary, preferences: draft.preferences,
        budget: draft.budget, note: draft.note, createdAt: today(), lastContactAt: '', nextFollowUpAt: '',
        source: 'manual', evidence: [], messages: [],
        memberId: draft.memberId || undefined, phone: draft.phone || undefined,
      };
      const success = await onApply({ ...state, customers: [customer, ...state.customers] });
      if (success) { notify(`已生成「${name}」的客户档案`); setDraft(null); setSpoken(''); }
    } catch (error) { notify(error instanceof Error ? error.message : '建档失败', true); }
    finally { setBusy(false); }
  };

  const parseRecords = () => {
    const result = parseShopRecords(rawRecords);
    setParsed(result.rows);
    setWarnings(result.warnings);
    if (!result.rows.length) notify('没有解析出可导入的消费记录', true);
  };

  const importRecords = async () => {
    if (!parsed?.length || busy) return;
    setBusy(true);
    try {
      const result = linkShopRecords(state, parsed, { fileName: '店铺现有消费数据' });
      const success = await onApply(result.state);
      if (success) {
        notify(`已绑定 ${result.addedOrders} 笔消费记录，新建 ${result.addedCustomers} 位客户`);
        setParsed(null); setRawRecords(''); setWarnings([]);
      }
    } catch (error) { notify(error instanceof Error ? error.message : '导入失败', true); }
    finally { setBusy(false); }
  };

  return <details className="card" style={{ marginBottom: 16, padding: 16 }}>
    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>语音建档与消费数据导入</summary>
    <div className="button-row" style={{ marginTop: 12 }}>
      <button className="btn secondary sm" type="button" disabled={recording} onClick={startRecording}>开始口述</button>
      <button className="btn ghost sm" type="button" disabled={!recording} onClick={() => { recognitionRef.current?.stop(); setRecording(false); }}>停止口述</button>
      {recording && <span className="muted small">正在聆听…</span>}
    </div>
    <label className="field" style={{ display: 'block', marginTop: 12 }}>口述内容<textarea className="input" rows={4} maxLength={2000} value={spoken} onChange={event => setSpoken(event.target.value)} placeholder="例如：客户叫林女士，会员卡号 A1024，宝宝八个月，问过 DHA 和鱼油的区别，预算 300 元左右" /></label>
    <button className="btn secondary sm" type="button" onClick={parseSpoken}>解析为档案草稿</button>
    {draft && <div className="card" style={{ padding: 12, marginTop: 12 }}>
      <strong>{draft.name || '（称呼待补全）'}</strong>
      <p className="muted small">标签：{draft.tags.length ? draft.tags.join('、') : '暂无'} · 预算：{draft.budget || '未识别'} · 会员卡：{draft.memberId || '未识别'} · 电话：{draft.phone || '未识别'}</p>
      <p className="muted small">偏好：{draft.preferences || '未识别'}</p>
      {draft.warnings.map((warning, index) => <p className="muted small" key={index}>{warning}</p>)}
      <button className="btn primary sm" type="button" disabled={busy} onClick={() => { void createFromDraft(); }}>一键生成客户档案</button>
    </div>}
    <hr style={{ margin: '20px 0', border: 0, borderTop: '1px solid #e5e7eb' }} />
    <label className="field" style={{ display: 'block' }}>粘贴店铺现有消费数据（CSV 或 JSON）<textarea className="input" rows={5} maxLength={60000} value={rawRecords} onChange={event => setRawRecords(event.target.value)} placeholder={'会员卡号,电话,姓名,日期,商品,金额,类型\nA1024,13800000000,林女士,2026-10-01,婴幼儿营养包,328,sale'} /></label>
    <div className="button-row" style={{ marginTop: 8 }}><button className="btn secondary sm" type="button" onClick={parseRecords}>解析并预览</button>{parsed && <button className="btn primary sm" type="button" disabled={busy || !parsed.length} onClick={() => { void importRecords(); }}>导入并绑定 {parsed.length} 条</button>}</div>
    {warnings.map((warning, index) => <p className="muted small" key={index}>{warning}</p>)}
  </details>;
}
