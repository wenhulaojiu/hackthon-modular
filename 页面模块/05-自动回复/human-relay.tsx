 'use client';
import { useEffect, useState } from 'react';
import { localRepliesAvailable, replyRequest } from './reply-ui';
import { captureWorkspace, assertWorkspaceCurrent, subscribeWorkspaceInvalidation } from '../../lib/client-workspace';

type Relay = { config: { enabled: boolean; salesChatId: string }; tickets: { id: string; customerName: string; question: string; status: string }[] };
const labels: Record<string, string> = { notifying: '通知发送中', waiting: '等待销售回答', answering: '正在提交答案', sending: '等待客户发送回执', sent: '已回复客户', notification_failed: '通知失败，请人工处理', unknown: '结果不明，请核对微信', needs_review: '会话有变化，请人工处理', cancelled: '已取消', failed: '回复失败', handoff: '需人工处理' };
export default function HumanRelay() {
  const [data, setData] = useState<Relay | null>(null);
  const [chat, setChat] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!localRepliesAvailable()) return;
    let alive = true; const workspace = captureWorkspace();
    const unsubscribe = subscribeWorkspaceInvalidation(() => { alive = false; setData(null); setChat(''); setNote('微信工作区已切换，请刷新页面后重新配置。'); });
    const refresh = async () => {
      try { const result = await replyRequest<{ relay?: Relay }>('/status'); assertWorkspaceCurrent(workspace); if (alive && result.relay) { setData(result.relay); setChat(value => value || result.relay!.config.salesChatId); } }
      catch { if (alive) setData(null); }
    };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { alive = false; clearInterval(timer); unsubscribe(); };
  }, []);
  async function save(enabled: boolean) {
    const workspace = captureWorkspace(); setBusy(true); setNote('');
    try { const result = await replyRequest<{ relay: Relay }>('/relay', { enabled, salesChatId: chat.trim() }); assertWorkspaceCurrent(workspace); setData(result.relay); setNote(enabled ? '已启用：新疑难问题将由B发送给A，请同时启动接待并启用原生发送组件。' : '已停用，未回答问题已取消；已派发发送请核对结果。'); }
    catch (error) { setNote(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  }
  return <section className="reply-rule-block"><h3>A/B微信人工协助</h3><p>B接待客户，遇到难题通知销售私人微信A。A在与B的聊天框发送“#问题编号 答案”，B再回复原客户。首版只识别明确编号的普通文字回复。</p><label className="field">销售私人微信A的准确会话标识<input className="input" value={chat} maxLength={160} disabled={busy || !!data?.config.enabled} onChange={event => setChat(event.target.value)} placeholder="wxid_…（不是昵称）" /></label><p>请先让A和B成为好友。A不能作为客户档案；仅处理启用后新产生的转人工问题。通知会包含客户称呼和部分问题内容。</p><button className="btn primary sm" disabled={busy || !data || !chat.trim()} onClick={() => { void save(!data?.config.enabled); }}>{data?.config.enabled ? '停用人工协助' : '启用人工协助'}</button>{!data && <p>请在最新Windows本地版中使用。</p>}{note && <p role="status">{note}</p>}{data?.tickets.map(ticket => <div key={ticket.id}><strong>{ticket.customerName} · {labels[ticket.status] || ticket.status}</strong><p>{ticket.question}</p><small>#{ticket.id}</small></div>)}</section>;
}
