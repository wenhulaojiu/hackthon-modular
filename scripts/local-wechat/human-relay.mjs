import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isEnrollmentChatId } from './reply-enrollment.mjs';

const fail = message => { throw Object.assign(new Error(message), { status: 409 }); };
export function parseRelayAnswer(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[ \t\r\n]+([\s\S]+)$/i);
  if (!match) return null;
  const text = match[2].trim();
  if (!text || text.length > 300 || !text.isWellFormed() || text.includes('\0') || Buffer.byteLength(text) > 1023) return null;
  return { id: match[1].toLowerCase(), text };
}

// 每个微信工作区独立存储；所有状态转换串行，先记录发送意图再触发收发。
export async function createHumanRelay({ directory, engine, reader, notify, answer, assertCurrent = () => {}, now = Date.now }) {
  const file = path.join(directory, 'human-relay.json');
  await mkdir(directory, { recursive: true });
  let state = { version: 1, config: { enabled: false, salesChatId: '', since: 0 }, tickets: [] };
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.version !== 1 || !saved.config || typeof saved.config.enabled !== 'boolean' || !Array.isArray(saved.tickets) || saved.tickets.length > 5000 || saved.config.enabled && !isEnrollmentChatId(saved.config.salesChatId)) fail('人工协助记录损坏，请人工检查，原文件未覆盖。');
    state = saved;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let chain = Promise.resolve();
  const serial = work => { const pending = chain.then(work); chain = pending.catch(() => {}); return pending; };
  async function save() {
    assertCurrent();
    const temporary = file + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  }
  for (const ticket of state.tickets) if (['notifying', 'answering'].includes(ticket.status)) ticket.status = 'unknown';
  await save();
  function status() { return structuredClone({ config: state.config, tickets: state.tickets.slice(-100).reverse() }); }
  async function configure(input) {
    return serial(async () => {
      assertCurrent();
      if (!input || Object.keys(input).some(key => !['enabled', 'salesChatId'].includes(key)) || typeof input.enabled !== 'boolean' || typeof input.salesChatId !== 'string' || input.enabled && !isEnrollmentChatId(input.salesChatId)) fail('请填写销售私人微信A的准确会话标识。');
      const config = await engine.getConfig();
      if (input.enabled && config?.customers.some(c => c.wechatId === input.salesChatId)) fail('A已存在于客户档案，请先移除A的客户档案，避免把销售当成客户接待。');
      if (state.config.enabled && input.enabled && input.salesChatId !== state.config.salesChatId) fail('切换A之前请先停用人工协助。');
      if (!input.enabled || input.salesChatId !== state.config.salesChatId) for (const t of state.tickets) if (t.status === 'waiting') t.status = 'cancelled';
      state.config = { ...input, since: input.enabled && state.config.enabled ? state.config.since : now() };
      await save(); return status();
    });
  }
  async function tick() {
    return serial(async () => {
      assertCurrent();
      if (!state.config.enabled || !(await engine.status()).running) return;
      const config = await engine.getConfig();
      if (config.customers.some(c => c.wechatId === state.config.salesChatId)) fail('A不能同时作为客户接待，请停用并检查配置。');
      const jobs = await engine.relayJobs();
      for (const job of jobs) {
        if (job.kind !== 'reply' || job.status !== 'handoff' || Date.parse(job.createdAt) < state.config.since || state.tickets.some(t => t.sourceJobId === job.id) || job.chatId === state.config.salesChatId || job.resolvedAt) continue;
        if (state.tickets.length >= 5000) fail('人工协助队列已满，请整理历史记录。');
        const customer = config.customers.find(c => c.id === job.customerId && c.wechatId === job.chatId);
        if (!customer) continue;
        await engine.takeover({ customerId: job.customerId, enabled: true });
        const ticket = { id: randomUUID(), sourceJobId: job.id, requestId: randomUUID(), salesChatId: state.config.salesChatId, customerId: job.customerId, chatId: job.chatId, customerName: customer.name, question: job.message.text, createdAt: new Date(now()).toISOString(), status: 'notifying' };
        state.tickets.push(ticket); await save();
        // 通知控制在原生单条发送上限内；编号由系统生成，不采用客户提供的路由指令。
        const message = `【需销售解答】客户：${String(customer.name).slice(0, 24)}\n问题：${job.message.text.slice(0, 160)}\n请回复：#${ticket.id} 您的答案`;
        let receipt;
        try { receipt = await notify({ chatId: ticket.salesChatId, text: message, idempotencyKey: 'manual:' + ticket.id }); } catch { receipt = { status: 'unknown' }; }
        assertCurrent();
        ticket.status = receipt?.status === 'sent' && receipt.messageId ? 'waiting' : receipt?.status === 'failed' ? 'notification_failed' : 'unknown';
        ticket.notificationMessageId = receipt?.messageId; await save();
      }
      const waiting = state.tickets.filter(t => t.status === 'waiting' && t.salesChatId === state.config.salesChatId);
      if (waiting.length) {
        const snapshots = await reader.readForReplies([state.config.salesChatId]);
        assertCurrent();
        if (!Array.isArray(snapshots) || snapshots.length !== 1 || snapshots[0]?.metadata?.chat_type !== 'private' || snapshots[0].metadata.chat_username !== state.config.salesChatId || !Array.isArray(snapshots[0].messages)) fail('销售A的私聊读取无法核验。');
        for (const m of snapshots[0].messages) {
          if (m.sender === '我' || m.sender_username !== state.config.salesChatId || String(m.local_type) !== '1' || !/^[0-9]+$/.test(String(m.server_id)) || !/[1-9]/.test(String(m.server_id)) || !Number.isFinite(Number(m.timestamp))) continue;
          const parsed = parseRelayAnswer(m.content);
          const ticket = parsed && waiting.find(t => t.id === parsed.id && t.status === 'waiting');
          if (!ticket || Number(m.timestamp) * 1000 > now() + 5000 || Number(m.timestamp) * 1000 < Date.parse(ticket.createdAt)) continue;
          const source = await engine.getJob(ticket.sourceJobId);
          const latest = await engine.relayJobs();
          if (!source || source.status !== 'handoff' || source.resolvedAt || latest.some(j => j.chatId === ticket.chatId && j.id !== source.id && (j.kind === 'manual' || Date.parse(j.createdAt) > Date.parse(ticket.createdAt)))) { ticket.status = 'needs_review'; await save(); continue; }
          ticket.status = 'answering'; ticket.answer = parsed.text; ticket.answerMessageId = String(m.server_id); await save();
          try {
            const result = await answer({ jobId: ticket.sourceJobId, requestId: ticket.requestId, text: parsed.text });
            assertCurrent(); ticket.manualJobId = result.id; ticket.status = result.status === 'sent' ? 'sent' : ['failed', 'unknown', 'handoff'].includes(result.status) ? result.status : 'sending';
          } catch { ticket.status = 'unknown'; }
          await save();
        }
      }
      for (const t of state.tickets.filter(t => t.status === 'sending' && t.manualJobId)) {
        const job = await engine.getJob(t.manualJobId);
        if (job && ['sent', 'failed', 'unknown', 'handoff'].includes(job.status)) { t.status = job.status; await save(); }
      }
    });
  }
  return { status, configure, tick, salesChatId: () => state.config.salesChatId };
}
