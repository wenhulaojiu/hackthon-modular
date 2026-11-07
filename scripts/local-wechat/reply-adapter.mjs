import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// 收件复用只读导出组件；发送网关须由用户另行安装并在本机验收。
export function createReplyAdapter({ root, reader, fetch: request = globalThis.fetch, now = Date.now, workspace, currentWorkspace } = {}) {
  let config;
  let startedAt = 0;
  let paused = true;
  let lastError = '';
  let activeScopedGrant = null;
  let sendQueue = Promise.resolve();
  const scopedAttempts = new Map();
  const scopedType = 'scoped-test-http';
  const privateChatId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value) && value !== 'filehelper' && !value.endsWith('@chatroom');
  function assertCurrent() {
    if (workspace && currentWorkspace?.() !== workspace.workspaceToken) throw Object.assign(new Error('微信工作区已切换，接待已停止，请刷新后重新启动。'), { status: 409, code: 'WORKSPACE_CHANGED' });
  }

  async function gateway() {
    let value;
    try { value = JSON.parse(await readFile(path.join(root, '.local-wechat', 'reply-adapter.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('本机发送网关配置无法读取。'); }
    let url;
    try { url = new URL(value.baseUrl); } catch { throw new Error('本机发送网关地址格式不正确。'); }
    if (!['verified-http', scopedType].includes(value.type) || url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('发送网关需要 verified-http 或 scoped-test-http 类型和本机 HTTP 回环地址，不得包含路径或凭据。');
    if (typeof value.token !== 'string' || value.token.length < 16 || value.token.length > 8000 || /[\r\n]/.test(value.token)) throw new Error('请在本机配置有效的发送网关 token。');
    return { origin: url.origin, token: value.token, type: value.type, ...(value.type === scopedType ? { workspaceToken: value.workspaceToken, allowedChatIds: value.allowedChatIds, expiresAt: value.expiresAt, maxSends: value.maxSends, testPrefix: value.testPrefix, acceptUnprefixedTestMessages: value.acceptUnprefixedTestMessages === undefined ? false : value.acceptUnprefixedTestMessages } : {}) };
  }

  const grantKey = target => JSON.stringify([target.type, target.origin, target.token, target.workspaceToken, target.allowedChatIds, target.expiresAt, target.maxSends, target.testPrefix, target.acceptUnprefixedTestMessages]);

  function assertScopedSelection(target, candidate) {
    assertCurrent();
    if (!workspace?.workspaceToken || target.workspaceToken !== workspace.workspaceToken) throw new Error('临时测试网关不属于当前微信工作区。');
    if (!Array.isArray(target.allowedChatIds) || target.allowedChatIds.length !== 1 || !privateChatId(target.allowedChatIds[0])) throw new Error('临时测试网关必须固定唯一的真实私聊标识。');
    if (typeof target.testPrefix !== 'string' || target.testPrefix.length < 4 || target.testPrefix.length > 80 || /[\u0000-\u001f]/.test(target.testPrefix)) throw new Error('临时测试必须固定四至八十字的测试消息前缀。');
    if (typeof target.acceptUnprefixedTestMessages !== 'boolean') throw new Error('临时测试的无前缀授权必须为明确的布尔值。');
    const expiry = typeof target.expiresAt === 'string' && /T.+(?:Z|[+-]\d{2}:\d{2})$/.test(target.expiresAt) ? Date.parse(target.expiresAt) : NaN;
    if (!Number.isFinite(expiry) || expiry <= now() || expiry > now() + 300_000 || target.maxSends !== 3) throw new Error('临时测试授权须在五分钟内有效，并且最多发送三条。');
    const selected = candidate?.settings?.selectedCustomerIds;
    const customers = candidate?.customers;
    if (!Array.isArray(selected) || selected.length !== 1 || !Array.isArray(customers)) throw new Error('临时测试只能选择唯一的已授权客户。');
    const matches = customers.filter(customer => customer.id === selected[0]);
    if (matches.length !== 1 || matches[0].wechatId !== target.allowedChatIds[0] || !matches[0].autoReplyEnabled || matches[0].humanTakeover || customers.filter(customer => customer.wechatId === target.allowedChatIds[0]).length !== 1) throw new Error('接待客户必须唯一映射到临时授权私聊，且不能处于人工接管。');
    return target.allowedChatIds[0];
  }

  function assertScopedStatus(target, candidate, data) {
    assertScopedSelection(target, candidate);
    if (target.acceptUnprefixedTestMessages ? data?.acceptUnprefixedTestMessages !== true : data?.acceptUnprefixedTestMessages !== undefined && data.acceptUnprefixedTestMessages !== false) throw new Error('临时测试的无前缀授权未被网关准确确认。');
    if (data?.protocol !== 'kexu-reply-v1' || data.ready !== true || data.workspaceToken !== target.workspaceToken || !Array.isArray(data.allowedChatIds) || data.allowedChatIds.length !== 1 || data.allowedChatIds[0] !== target.allowedChatIds[0] || data.expiresAt !== target.expiresAt || data.testPrefix !== undefined && data.testPrefix !== target.testPrefix || !Number.isInteger(data.remainingSends) || data.remainingSends < 1 || data.remainingSends > target.maxSends || data.capabilities?.stableChatIds !== false || data.capabilities?.scopedStableChatIds !== true || data.capabilities?.scopeRestricted !== true || data.capabilities?.readback !== true || data.capabilities?.idempotentSend !== true) throw new Error('临时测试网关的账号、单会话范围、期限、配额或受限能力核验失败。');
    if ((scopedAttempts.get(grantKey(target))?.size || 0) >= target.maxSends) throw new Error('临时测试的三条发送尝试配额已用完。');
  }

  async function probeGateway(target, candidate) {
    const data = await call(target, '/kexu/v1/status');
    assertCurrent();
    if (target.type === scopedType) { assertScopedStatus(target, candidate, data); return true; }
    return data.protocol === 'kexu-reply-v1' && data.ready === true && data.capabilities?.stableChatIds === true && data.capabilities?.readback === true && data.capabilities?.idempotentSend === true;
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

  async function inspectStatus({ probe = false, candidate = config } = {}) {
    assertCurrent();
    const local = await reader.inspect();
    const canReceive = local.configured && local.pythonReady && local.exporterReady && local.databaseReady !== false && !local.message;
    let canSend = false;
    let configured = false;
    let target = null;
    let message = local.message || '本机只读组件可生成接待草稿；自动发送尚未接通。';
    try {
      target = await gateway();
      configured = !!target;
      if (target && probe) {
        canSend = await probeGateway(target, candidate);
        message = canSend ? target.type === scopedType ? '临时单会话测试网关已就绪，仅限已授权客户、五分钟内最多三条发送尝试。' : '已连接本机发送网关；发送后须按会话回读确认。' : '发送网关未报告稳定会话 ID、发送防重和消息回读能力。';
      } else if (target) message = '已配置本机发送网关，等待检测连接。';
    } catch (error) { message = error.message; }
    return { info: { configured, canReceive, canSend, type: 'exporter-poll', message: lastError || message }, target };
  }

  async function status(options) { return (await inspectStatus(options)).info; }

  async function start(next) {
    assertCurrent();
    paused = true;
    const { info: ready, target } = await inspectStatus({ probe: true, candidate: next });
    assertCurrent();
    if (!ready.canReceive) throw new Error(ready.message || '请先安装并配置本机微信只读组件。');
    if (target?.type === scopedType && !ready.canSend) throw new Error(ready.message);
    if (next.settings.mode === 'auto' && !ready.canSend) throw new Error('自动发送尚未接通，请先使用草稿接待，或安装并验收本机发送网关。');
    const allowed = new Set(next.settings.selectedCustomerIds);
    const ids = next.customers.filter(c => allowed.has(c.id) && c.autoReplyEnabled && !c.humanTakeover).map(c => c.wechatId);
    if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length) throw new Error('本地接待每次支持 1–20 位微信标识明确且不重复的好友。');
    config = next;
    activeScopedGrant = target?.type === scopedType ? { key: grantKey(target), target } : null;
    // 原始消息为秒精度；取下一秒，避免处理启动前同一秒的旧消息。
    startedAt = Math.ceil(now() / 1000) * 1000;
    lastError = '';
    paused = false;
  }

  function syncConfig(next) { config = next; }

  async function poll() {
    assertCurrent();
    if (paused || !config) return [];
    const scopedGrant = activeScopedGrant;
    if (scopedGrant) assertScopedSelection(scopedGrant.target, config);
    const selected = new Set(config.settings.selectedCustomerIds);
    const ids = config.customers.filter(c => selected.has(c.id) && c.autoReplyEnabled && !c.humanTakeover).map(c => c.wechatId);
    if (!ids.length) return [];
    if (ids.length > 20 || new Set(ids).size !== ids.length) throw new Error('接待客户映射不明确或超过 20 位，已暂停。');
    const snapshots = await reader.readForReplies(ids);
    assertCurrent();
    if (paused) return [];
    if (scopedGrant) {
      if (activeScopedGrant?.key !== scopedGrant.key) throw new Error('临时测试读取期间授权已变化。');
      assertScopedSelection(scopedGrant.target, config);
      if (scopedGrant.target.acceptUnprefixedTestMessages) {
        // 无前缀测试逐次复核固定授权与网关回显，确认后才把新问题交给生产队列。
        const target = await gateway();
        if (!target || grantKey(target) !== scopedGrant.key) throw new Error('临时测试的无前缀授权已变化，请重新核验后启动。');
        await probeGateway(target, config);
        if (paused) return [];
        if (activeScopedGrant?.key !== scopedGrant.key) throw new Error('临时测试读取期间授权已变化。');
        assertScopedSelection(target, config);
      }
    }
    const events = [];
    for (const snapshot of snapshots) {
      const chatId = snapshot.metadata?.chat_username;
      if (!ids.includes(chatId) || snapshot.metadata?.chat_type !== 'private') throw new Error('读取结果与接待白名单不一致。');
      for (const message of snapshot.messages) {
        const time = message.timestamp * 1000;
        if (!Number.isFinite(time) || time < startedAt || time > now() + 5000) continue;
        // 只认明确方向，不用昵称猜测；未知作者不会触发回复。
        const sender = message.sender === '我' ? 'merchant' : message.sender_username === chatId ? 'customer' : 'system';
        // 默认只收本轮加前缀的新问题；明确双重授权后可收唯一测试号的新纯文本。
        if (scopedGrant && (sender === 'system' || sender === 'customer' && (String(message.local_type) !== '1' || typeof message.content !== 'string' || !scopedGrant.target.acceptUnprefixedTestMessages && !message.content.startsWith(scopedGrant.target.testPrefix)))) continue;
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

  async function sendOne({ chatId, text, idempotencyKey }) {
    try { assertCurrent(); } catch (error) { return { status: 'failed', error: error.message }; }
    if (paused || !config) return { status: 'failed', error: '本地接待已暂停。' };
    const selected = new Set(config.settings.selectedCustomerIds);
    if (!config.customers.some(c => c.wechatId === chatId && selected.has(c.id) && c.autoReplyEnabled && !c.humanTakeover)) return { status: 'failed', error: '该会话不在客服白名单或已由人工接管。' };
    let target;
    try { target = await gateway(); } catch (error) { return { status: 'failed', error: error.message }; }
    if (!target) return { status: 'failed', error: '尚未安装本机发送网关。' };
    let attempt;
    let attempts;
    if (target.type === scopedType || activeScopedGrant) {
      try {
        if (!activeScopedGrant || target.type !== scopedType || activeScopedGrant.key !== grantKey(target)) throw new Error('临时测试授权已变更，请暂停并重新核验单客户接待。');
        const allowedChatId = assertScopedSelection(target, config);
        if (chatId !== allowedChatId || typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 200 || /[\u0000-\u001f]/.test(idempotencyKey)) throw new Error('发送请求不符合临时单会话授权或缺少幂等标识。');
        attempts = scopedAttempts.get(activeScopedGrant.key) || new Map();
        scopedAttempts.set(activeScopedGrant.key, attempts);
        const previous = attempts.get(idempotencyKey);
        if (previous) return previous.chatId === chatId && previous.text === text ? previous.result : { status: 'failed', error: '同一幂等标识不能用于不同的发送内容。' };
        await probeGateway(target, config);
        assertScopedSelection(target, config);
        if (paused || !activeScopedGrant || activeScopedGrant.key !== grantKey(target)) throw new Error('临时测试接待已暂停或授权已变化。');
        // 请求一旦发出即占用配额；结果未知也不会再次发送同一幂等标识。
        attempt = { chatId, text, result: { status: 'unknown', error: '临时测试发送结果未知，不会自动重试。' } };
        attempts.set(idempotencyKey, attempt);
      } catch (error) { return { status: 'failed', error: error.message }; }
    }
    try { assertCurrent(); } catch (error) { return { status: 'failed', error: error.message }; }
    const textSha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    try {
      // 发出请求后无法核验的情况均视为未知，绝不自动重试。
      const result = await call(target, '/kexu/v1/send', { chatId, text, idempotencyKey, ...(target.type === scopedType ? { workspaceToken: target.workspaceToken } : {}) });
      assertCurrent();
      const outcome = result.status === 'sent' && result.chatId === chatId && typeof result.messageId === 'string' && result.messageId.length > 0 && result.messageId.length <= 200 && result.textSha256 === textSha256 && result.readback === true && (target.type !== scopedType || result.workspaceToken === target.workspaceToken) ? { status: 'sent', messageId: result.messageId } : { status: 'unknown', error: '发送网关未提供可核验的会话消息 ID、账号与回读证明，请核对微信；不会重发。' };
      if (attempt) attempt.result = outcome;
      return outcome;
    } catch { const outcome = { status: 'unknown', error: '发送请求超时、断连或回读失败，结果未知，请核对微信；不会重发。' }; if (attempt) attempt.result = outcome; return outcome; }
  }

  function send(input) {
    // 串行化发送预检与配额预留，避免两个并发请求同时消耗最后一条额度。
    const pending = sendQueue.then(() => sendOne(input));
    sendQueue = pending.catch(() => {});
    return pending;
  }

  function pause() { paused = true; }
  function fail(error) { lastError = error?.message || '本地读取异常。'; paused = true; }
  return { status, start, syncConfig, poll, send, pause, fail };
}
