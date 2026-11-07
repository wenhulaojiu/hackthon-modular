import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// 收件复用只读导出组件；发送网关须由用户另行安装并在本机验收。
export function createReplyAdapter({ root, reader, fetch: request = globalThis.fetch, now = Date.now, workspace, currentWorkspace } = {}) {
  let config;
  let startedAt = 0;
  let paused = true;
  let lastError = '';
  function assertCurrent() {
    if (workspace && currentWorkspace?.() !== workspace.workspaceToken) throw Object.assign(new Error('微信工作区已切换，接待已停止，请刷新后重新启动。'), { status: 409, code: 'WORKSPACE_CHANGED' });
  }

  async function gateway() {
    let value;
    try { value = JSON.parse(await readFile(path.join(root, '.local-wechat', 'reply-adapter.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('本机发送网关配置无法读取。'); }
    let url;
    try { url = new URL(value.baseUrl); } catch { throw new Error('本机发送网关地址格式不正确。'); }
    if (value.type !== 'verified-http' || url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('发送网关需要 verified-http 类型和本机 HTTP 回环地址，不得包含路径或凭据。');
    if (typeof value.token !== 'string' || value.token.length < 16 || value.token.length > 8000 || /[\r\n]/.test(value.token)) throw new Error('请在本机配置有效的发送网关 token。');
    return { origin: url.origin, token: value.token };
  }

  async function call(target, endpoint, data) {
    assertCurrent();
    const response = await request(`${target.origin}${endpoint}`, {
      method: data === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(data === undefined ? 5000 : 60_000),
      headers: { Authorization: `Bearer ${target.token}`, Accept: 'application/json', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    if (!response.ok) throw new Error(`本机发送网关请求失败（HTTP ${response.status}）。`);
    if (Number(response.headers.get('content-length')) > 16_384) throw new Error('发送网关返回数据过多。');
    const body = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const next = await body.read();
      if (next.done) break;
      length += next.value.length;
      if (length > 16_384) { await body.cancel(); throw new Error('发送网关返回数据过多。'); }
      chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  }

  async function status({ probe = false } = {}) {
    assertCurrent();
    const local = await reader.inspect();
    const canReceive = local.configured && local.pythonReady && local.exporterReady && local.databaseReady !== false && !local.message;
    let canSend = false;
    let configured = false;
    let message = local.message || '本机只读组件可生成接待草稿；自动发送尚未接通。';
    try {
      const target = await gateway();
      configured = !!target;
      if (target && probe) {
        const data = await call(target, '/kexu/v1/status');
        canSend = data.protocol === 'kexu-reply-v1' && data.ready === true && data.capabilities?.stableChatIds === true && data.capabilities?.readback === true && data.capabilities?.idempotentSend === true;
        message = canSend ? '已连接本机发送网关；发送后须按会话回读确认。' : '发送网关未报告稳定会话 ID、发送防重和消息回读能力。';
      } else if (target) message = '已配置本机发送网关，等待检测连接。';
    } catch (error) { message = error.message; }
    return { configured, canReceive, canSend, type: 'exporter-poll', message: lastError || message };
  }

  async function start(next) {
    assertCurrent();
    const ready = await status({ probe: true });
    assertCurrent();
    if (!ready.canReceive) throw new Error(ready.message || '请先安装并配置本机微信只读组件。');
    if (next.settings.mode === 'auto' && !ready.canSend) throw new Error('自动发送尚未接通，请先使用草稿接待，或安装并验收本机发送网关。');
    const allowed = new Set(next.settings.selectedCustomerIds);
    const ids = next.customers.filter(c => allowed.has(c.id) && c.autoReplyEnabled && !c.humanTakeover).map(c => c.wechatId);
    if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length) throw new Error('本地接待每次支持 1–20 位微信标识明确且不重复的好友。');
    config = next;
    // 原始消息为秒精度；取下一秒，避免处理启动前同一秒的旧消息。
    startedAt = Math.ceil(now() / 1000) * 1000;
    lastError = '';
    paused = false;
  }

  function syncConfig(next) { config = next; }

  async function poll() {
    assertCurrent();
    if (paused || !config) return [];
    const selected = new Set(config.settings.selectedCustomerIds);
    const ids = config.customers.filter(c => selected.has(c.id) && c.autoReplyEnabled && !c.humanTakeover).map(c => c.wechatId);
    if (!ids.length) return [];
    if (ids.length > 20 || new Set(ids).size !== ids.length) throw new Error('接待客户映射不明确或超过 20 位，已暂停。');
    const snapshots = await reader.readForReplies(ids);
    assertCurrent();
    const events = [];
    for (const snapshot of snapshots) {
      const chatId = snapshot.metadata?.chat_username;
      if (!ids.includes(chatId) || snapshot.metadata?.chat_type !== 'private') throw new Error('读取结果与接待白名单不一致。');
      for (const message of snapshot.messages) {
        const time = message.timestamp * 1000;
        if (!Number.isFinite(time) || time < startedAt || time > now() + 5000) continue;
        // 只认明确方向，不用昵称猜测；未知作者不会触发回复。
        const sender = message.sender === '我' ? 'merchant' : message.sender_username === chatId ? 'customer' : 'system';
        const serverId = String(message.server_id || '');
        const localId = String(message.local_id || '');
        const identity = /^\d+$/.test(serverId) && /[1-9]/.test(serverId) ? `server:${serverId}` : localId && message.source_database ? `local:${message.source_database}:${localId}` : '';
        if (!identity || typeof message.content !== 'string' || message.content.length > 8000) continue;
        const scope = workspace && workspace.id !== 'legacy' ? `${workspace.id}|` : '';
        const id = createHash('sha256').update(`${scope}${chatId}|${identity}`).digest('hex');
        events.push({ id: `wx:${id}`, nativeMessageId: /^\d+$/.test(serverId) && /[1-9]/.test(serverId) ? serverId : undefined, chatId, sender, text: message.content, date: new Date(time).toISOString(), source: 'realtime', kind: String(message.local_type) === '1' ? 'text' : 'unsupported' });
      }
    }
    lastError = '';
    return events.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  }

  async function send({ chatId, text, idempotencyKey }) {
    try { assertCurrent(); } catch (error) { return { status: 'failed', error: error.message }; }
    if (paused || !config) return { status: 'failed', error: '本地接待已暂停。' };
    const selected = new Set(config.settings.selectedCustomerIds);
    if (!config.customers.some(c => c.wechatId === chatId && selected.has(c.id) && c.autoReplyEnabled && !c.humanTakeover)) return { status: 'failed', error: '该会话不在客服白名单或已由人工接管。' };
    let target;
    try { target = await gateway(); } catch (error) { return { status: 'failed', error: error.message }; }
    if (!target) return { status: 'failed', error: '尚未安装本机发送网关。' };
    try { assertCurrent(); } catch (error) { return { status: 'failed', error: error.message }; }
    const textSha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    try {
      // 发出请求后无法核验的情况均视为未知，绝不自动重试。
      const result = await call(target, '/kexu/v1/send', { chatId, text, idempotencyKey });
      if (result.status === 'sent' && result.chatId === chatId && typeof result.messageId === 'string' && result.messageId.length > 0 && result.messageId.length <= 200 && result.textSha256 === textSha256 && result.readback === true) return { status: 'sent', messageId: result.messageId };
      return { status: 'unknown', error: '发送网关未提供可核验的会话消息 ID 与回读证明，请核对微信；不会重发。' };
    } catch { return { status: 'unknown', error: '发送请求超时、断连或回读失败，结果未知，请核对微信；不会重发。' }; }
  }

  function pause() { paused = true; }
  function fail(error) { lastError = error?.message || '本地读取异常。'; paused = true; }
  return { status, start, syncConfig, poll, send, pause, fail };
}
