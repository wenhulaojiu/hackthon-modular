'use client';

import { useState } from 'react';
import type { AppState, GuideKnowledge, GuideTopic, ReplyResult } from '../../lib/types';
import { classifyGuideIntent, defaultGuideKnowledge, guideReply } from '../../lib/guide-knowledge';
import { documentToTopics, keywordsFor } from '../../lib/file-import';
import FileImportButton from '../09-公共工具与样式/file-import-button';

type Props = {
  state: AppState;
  notify: (text: string, error?: boolean) => void;
  onSave: (knowledge: GuideKnowledge) => Promise<boolean>;
  standalone?: boolean;
};

function mergeDefaults(saved?: GuideKnowledge): GuideKnowledge {
  const base = defaultGuideKnowledge();
  if (!saved) return base;
  return { topics: saved.topics?.length ? saved.topics : base.topics, policy: { ...base.policy, ...saved.policy } };
}

const DOCUMENT_STYLE = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '24px 32px', lineHeight: 1.8 } as const;
const TITLE_STYLE = { width: '100%', border: 'none', borderBottom: '1px solid #eef0f4', borderRadius: 0, background: 'transparent', padding: '6px 0', fontSize: 17, fontWeight: 600, outline: 'none' } as const;
const BODY_STYLE = { width: '100%', border: 'none', background: 'transparent', padding: '10px 0', fontSize: 14, lineHeight: 1.8, resize: 'none', outline: 'none' } as const;

/** 知识库以连续文档的形式书写，回复只引用这里已登记的原文，不编造功效或政策。 */
function PanelBody({ state, notify, onSave, standalone }: Props) {
  const [draft, setDraft] = useState<GuideKnowledge>(() => mergeDefaults(state.guideKnowledge));
  const [saving, setSaving] = useState(false);
  const [sample, setSample] = useState('DHA和鱼油有什么区别');
  const [preview, setPreview] = useState<{ intent: string; result: ReplyResult | null } | null>(null);
  const [query, setQuery] = useState('');

  const keyword = query.trim().toLowerCase();
  const visibleTopics = draft.topics
    .map((topic, index) => ({ topic, index }))
    .filter(({ topic }) => !keyword || `${topic.title}\n${topic.answer}`.toLowerCase().includes(keyword));

  const updateTopic = (index: number, patch: Partial<GuideTopic>) => setDraft({ ...draft, topics: draft.topics.map((topic, current) => current === index ? { ...topic, ...patch } : topic) });
  const addTopic = () => setDraft({ ...draft, topics: [...draft.topics, { id: crypto.randomUUID(), title: '', keywords: [], answer: '', enabled: true }] });
  const removeTopic = (index: number) => setDraft({ ...draft, topics: draft.topics.filter((_, current) => current !== index) });

  // 试答只调用本地纯规则，不请求模型、不写状态、不发送微信。
  const runPreview = () => {
    const match = classifyGuideIntent(sample, draft);
    const result = guideReply(sample, {
      knowledge: draft,
      products: (state.products ?? []).filter(product => product.enabled),
      storeAddress: draft.policy.storeAddress,
      maxReplyChars: 300,
    });
    setPreview({ intent: match.intent ?? '未命中（交回原有流程）', result });
  };

  const save = async () => {
    if (saving) return;
    const topics = draft.topics
      .map(topic => ({
        ...topic,
        title: topic.title.trim(), answer: topic.answer.trim(),
        keywords: Array.from(new Set([...topic.keywords, ...keywordsFor(topic.title)])).filter(word => word.length <= 80).slice(0, 30),
      }))
      .filter(topic => topic.title || topic.answer);
    if (topics.some(topic => !topic.title || !topic.answer)) { notify('每个段落都要写标题和正文，或移除空段落', true); return; }
    if (topics.some(topic => topic.answer.length > 4000)) { notify('单段正文不能超过 4000 字', true); return; }
    setSaving(true);
    try {
      const success = await onSave({ topics, policy: draft.policy });
      if (success) notify('已保存');
    } catch (error) { notify(error instanceof Error ? error.message : '知识库保存失败', true); }
    finally { setSaving(false); }
  };

  const document = <>
    <div style={DOCUMENT_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>门店知识库</h2>
        <FileImportButton notify={notify} label="上传文件" onImport={documents => {
          if (draft.topics.length >= 50) { notify('知识库最多 50 段', true); return; }
          const topics = documentToTopics(documents, () => crypto.randomUUID(), 50 - draft.topics.length);
          if (!topics.length) { notify('未识别到可导入的段落', true); return; }
          setDraft(current => ({ ...current, topics: [...current.topics, ...topics].slice(0, 50) }));
          notify(`识别到 ${topics.length} 个段落，检查后保存`);
        }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 8px' }}>
        <input className="input" type="search" style={{ maxWidth: 260 }} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索段落标题或正文…" aria-label="搜索知识库段落" />
        {keyword && <span className="muted small">匹配 {visibleTopics.length} / {draft.topics.length} 段</span>}
      </div>
      {visibleTopics.map(({ topic, index }) => <div key={topic.id} style={{ padding: '14px 0', borderTop: '1px solid #f1f3f6' }}>
        <input className="input" aria-label={`第 ${index + 1} 段标题`} maxLength={200} value={topic.title} onChange={event => updateTopic(index, { title: event.target.value })} placeholder="段落标题" style={TITLE_STYLE} />
        <textarea className="input" aria-label={`第 ${index + 1} 段正文`} rows={Math.max(4, topic.answer.split('\n').length + 2)} maxLength={4000} value={topic.answer} onChange={event => updateTopic(index, { answer: event.target.value })} placeholder="在这里写正文…" style={BODY_STYLE} />
        <div style={{ textAlign: 'right' }}><button className="text-button danger-text" type="button" onClick={() => removeTopic(index)}>移除</button></div>
      </div>)}
      {keyword && !visibleTopics.length && <p className="muted small">没有匹配的段落。</p>}
    </div>
    <div className="button-row" style={{ marginTop: 12 }}><button className="btn secondary sm" type="button" disabled={draft.topics.length >= 50} onClick={addTopic}>新增段落</button></div>
    <div className="modal-actions" style={{ marginTop: 12 }}><button className="btn primary" type="button" disabled={saving} onClick={() => { void save(); }}>{saving ? '保存中…' : '保存'}</button></div>
    <details style={{ marginTop: 16 }}><summary className="muted small" style={{ cursor: 'pointer' }}>试答</summary>
      <label className="field" style={{ display: 'block', marginTop: 8 }}>客户消息<input className="input" maxLength={500} value={sample} onChange={event => setSample(event.target.value)} /></label>
      <button className="btn primary sm" type="button" onClick={runPreview}>试答</button>
      {preview && <div className="card" style={{ marginTop: 10, padding: 10 }}>
        <p className="small">命中规则：<strong>{preview.intent}</strong> · 处理动作：<strong>{preview.result?.action ?? '交回原有流程'}</strong></p>
        <p className="small">回复内容：{preview.result?.reply || '（不生成固定回复，交给原有可核验流程或转人工）'}</p>
        <p className="muted small">依据：{preview.result?.reason || '未命中导购知识库规则'}</p>
      </div>}
    </details>
  </>;
  if (standalone) return <>{document}</>;
  return <details className="card" style={{ marginBottom: 16, padding: 16 }}>
    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>导购知识库</summary>
    {document}
  </details>;
}

/** 门店资料变化时重挂载草稿，而不是在 effect 里同步 setState。 */
export default function GuideKnowledgePanel(props: Props) {
  return <PanelBody key={props.state.guideKnowledge ? JSON.stringify(props.state.guideKnowledge) : 'default'} {...props} />;
}
