'use client';

import { useEffect, useRef } from 'react';
import type { GuideKnowledge, SharedProps } from '../../lib/types';
import { assertWorkspaceCurrent, captureWorkspace } from '../../lib/client-workspace';
import { loadSavedReplyConfig, localRepliesAvailable, replyRequest } from '../05-自动回复/reply-ui';
import GuideKnowledgePanel from '../06-商品与服务/guide-knowledge-panel';
import CustomerKnowledgePanel from './customer-knowledge-panel';
import './knowledge.css';

export default function KnowledgeBase({ state, onChange, notify }: SharedProps) {
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const save = async (knowledge: GuideKnowledge): Promise<boolean> => {
    const expected = captureWorkspace();
    let paused = false;
    if (localRepliesAvailable()) {
      let runtime: { running: boolean } | null = null;
      try { runtime = await replyRequest<{ running: boolean }>('/status'); }
      catch { /* 本地组件未启用时，仍可保存资料。 */ }
      if (runtime?.running) {
        try { await replyRequest('/pause', {}); paused = true; }
        catch { notify('未能暂停正在运行的本机接待，资料尚未修改', true); return false; }
      }
    }
    assertWorkspaceCurrent(expected);
    if (!await onChange({ ...stateRef.current, guideKnowledge: knowledge })) return false;
    assertWorkspaceCurrent(expected);
    if (localRepliesAvailable()) {
      try { await replyRequest('/config', await loadSavedReplyConfig()); }
      catch (error) { notify(`已保存，但本机知识同步未确认：${error instanceof Error ? error.message : '请检查本地组件'}`, true); return true; }
    }
    notify(paused ? '已保存，本地接待已暂停，请回自动回复中心确认后启动' : '已保存');
    return true;
  };

  return <div className="knowledge-columns">
    <GuideKnowledgePanel state={state} notify={notify} onSave={save} standalone />
    <CustomerKnowledgePanel state={state} onChange={onChange} notify={notify} />
  </div>;
}
