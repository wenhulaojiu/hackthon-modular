import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertAdditiveEnrollment, isEnrollmentChatId, isFriendAddedSystemText } from './reply-enrollment.mjs';

// 收件复用只读导出组件；发送网关须由用户另行安装并在本机验收。
export function createReplyAdapter({ root, reader, fetch: request = globalThis.fetch, now = Date.now, workspace, currentWorkspace, nativeSender, excludedChatIds = () => [] } = {}) {
  let config;
  let startedAt = 0;
  let paused = true;
  let lastError = '';
  let activeScopedGrant = null;
  let sendQueue = Promise.resolve();
  let lifecycle = 0;
  let configRevision = 0;
  let activeTransport = null;
  let nativePause = Promise.resolve();
  let discoveryCursor = 0;
  let probeCache = null;
  const watermarks = new Map();
  const nativeAttempts = new Map();
  const scopedAttempts = new Map();
  const scopedType = 'scoped-test-http';
  const privateChatId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value) && value !== 'filehelper' && !value.endsWith('@chatroom');
  function assertCurrent() {
    if (workspace && currentWorkspace?.() !== workspace.workspaceToken) throw Object.assign(new Error('微信工作区已切换，接待已停止，请刷新后重新启动。'), { status: 409, code: 'WORKSPACE_CHANGED' });
  }

  function pauseNative() {
    let pending;
    try { pending = Promise.resolve(nativeSender?.pause()); } catch (error) { pending = Promise.reject(error); }
    nativePause = Promise.all([nativePause.catch(() => {}), pending]).then(() => {});
    nativePause.catch(() => {});
    return nativePause;
  }

  async function nativeStatus(probe) {
    if (!nativeSender) return null;
    const value = await nativeSender.status({ probe });
    assertCurrent();
    if (!value || typeof value.configured !== 'boolean' || value.configured === false && value.canSend === true) throw new Error('内置原生发送器状态不完整。');
    if (value.workspaceToken !== undefined && value.workspaceToken !== workspace?.workspaceToken) throw new Error('内置原生发送器账号与当前工作区不一致。');
    if (value.configured && (value.mode !== 'native-background' || value.requiresForeground !== false || ['start', 'syncConfig', 'pause', 'send'].some(method => typeof nativeSender[method] !== 'function'))) throw new Error('内置原生发送器尚未提供完整的后台发送能力。');
    return value;
  }

  function nativeRecipient(chatId) {
    const selected = new Set(config?.settings?.selectedCustomerIds || []);
    const matches = (config?.customers || []).filter(customer => customer.wechatId === chatId);
    return config?.settings?.enabled === true && privateChatId(chatId) && matches.length === 1 && selected.has(matches[0].id) && matches[0].autoReplyEnabled === true && !matches[0].humanTakeover;
  }

  async function sendNative(input, ticket, revision) {
    const { chatId, text, idempotencyKey } = input;
    if (typeof text !== 'string' || !text.trim() || text.length > 4000 || typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 200 || /[\u0000-\u001f]/.test(idempotencyKey) || !nativeRecipient(chatId)) return { status: 'failed', error: '原生发送请求或客户白名单无效。' };
    const textSha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    const prior = nativeAttempts.get(idempotencyKey);
    if (prior) return prior.chatId === chatId && prior.textSha256 === textSha256 ? prior.result : { status: 'failed', error: '同一幂等标识不能用于不同会话或正文。' };
    try {
      const current = await nativeStatus(true);
      if (!current?.configured || !current.canSend) throw new Error();
      assertCurrent();
      if (paused || ticket !== lifecycle || revision !== configRevision || !nativeRecipient(chatId)) throw new Error();
    } catch { return { status: 'failed', error: '原生后台发送尚未就绪，或接待规则已变化，请重新核对后启动。' }; }
    if (nativeAttempts.size >= 5000) return { status: 'failed', error: '本次接待的发送记录已满，请暂停整理后重启。' };
    // 先保留未知结果，再调用原生发送；异常不重试，也不改用其他发送器。
    const attempt = { chatId, textSha256, result: { status: 'unknown', error: '原生发送结果未知，请核对微信；不会重发。' } };
    nativeAttempts.set(idempotencyKey, attempt);
    try {
      const result = await nativeSender.send({ chatId, text, idempotencyKey });
      assertCurrent();
      if (result?.status === 'sent' && typeof result.messageId === 'string' && result.messageId.trim() && result.messageId.length <= 200 && !/[\u0000-\u001f]/.test(result.messageId)) attempt.result = { status: 'sent', messageId: result.messageId };
      else if (result?.status === 'failed') attempt.result = { status: 'failed', error: '原生发送未执行成功，请检查本机发送器状态。' };
    } catch { /* 请求可能已生效，保留未知状态供人工核对。 */ }
    return attempt.result;
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
    let canManualSend = false;
    let configured = false;
    let target = null;
    let nativeInfo = null;
    let message = local.message || '本机只读组件可生成接待草稿；自动发送尚未接通。';
    try {
      if (nativeSender) {
        // 内置发送器一旦被明确选择，即使停用或异常也不自动降级到旧网关。
        target = { type: 'native-background' }; configured = true;
        nativeInfo = await nativeStatus(probe);
        if (nativeInfo.configured) {
          canSend = nativeInfo.canSend === true;
          canManualSend = canSend && typeof nativeSender.sendManual === 'function';
          message = typeof nativeInfo.message === 'string' ? nativeInfo.message.slice(0, 400) : '已选择内置原生后台发送器。';
        } else { target = null; configured = false; }
      }
      if (!target) target = await gateway();
      configured = !!target;
      if (target?.type === 'native-background') { /* 原生状态由已绑定工作区的发送器核验。 */ }
      else if (target && probe) {
        canSend = await probeGateway(target, candidate);
        message = canSend ? target.type === scopedType ? '临时单会话测试网关已就绪，仅限已授权客户、五分钟内最多三条发送尝试。' : '已连接本机发送网关；发送后须按会话回读确认。' : '发送网关未报告稳定会话 ID、发送防重和消息回读能力。';
      } else if (target) message = '已配置本机发送网关，等待检测连接。';
    } catch (error) { canSend = false; canManualSend = false; message = target?.type === 'native-background' ? '内置原生后台发送器暂不可用，请检查本机配置。' : error.message; }
    assertCurrent();
    return { info: { configured, canReceive, canSend, canManualSend, type: 'exporter-poll', ...(target?.type === 'native-background' ? { mode: 'native-background', requiresForeground: false } : {}), message: lastError || message }, target };
  }

  async function status(options) { return (await inspectStatus(options)).info; }

  async function start(next) {
    assertCurrent();
    const ticket = ++lifecycle;
    const revision = configRevision;
    paused = true;
    await pauseNative();
    const { info: ready, target } = await inspectStatus({ probe: true, candidate: next });
    assertCurrent();
    if (ticket !== lifecycle || revision !== configRevision) throw new Error('接待启动期间规则已变化，请重新启动。');
    if (!ready.canReceive) throw new Error(ready.message || '请先安装并配置本机微信只读组件。');
    if (target?.type === scopedType && !ready.canSend) throw new Error(ready.message);
    if (next.settings.mode === 'auto' && !ready.canSend) throw new Error('自动发送尚未接通，请先使用草稿接待，或安装并验收本机发送网关。');
    const allowed = new Set(next.settings.selectedCustomerIds);
    const ids = next.customers.filter(c => allowed.has(c.id) && c.autoReplyEnabled && !c.humanTakeover).map(c => c.wechatId);
    if ((!ids.length && !(next.settings.enabled === true && next.settings.autoEnrollNewContacts !== false)) || ids.length > 500 || new Set(ids).size !== ids.length) throw new Error('本地接待最多支持500位微信标识明确且不重复的好友；空名单需启用新私聊接待。');
    if (target?.type === 'native-background') {
      if (next.settings.enabled !== true || ids.some(id => !privateChatId(id) || next.customers.filter(customer => customer.wechatId === id).length !== 1)) throw new Error('请先启用规则，并核对原生发送的私聊白名单。');
      if (ready.canSend) {
        try {
          await nativeSender.start(next);
          assertCurrent();
          if (ticket !== lifecycle || revision !== configRevision) throw new Error('接待启动期间已暂停或规则已变化。');
        } catch (error) { await pauseNative().catch(() => {}); throw error; }
      }
    }
    config = next;
    activeTransport = target?.type === 'native-background' ? 'native-background' : 'http';
    activeScopedGrant = target?.type === scopedType ? { key: grantKey(target), target } : null;
    // 原始消息为秒精度；取下一秒，避免处理启动前同一秒的旧消息。
    startedAt = Math.ceil(now() / 1000) * 1000;
    probeCache = null; watermarks.clear();
    lastError = '';
    paused = false;
  }

  async function syncConfig(next) {
    assertCurrent();
    if (JSON.stringify(config) !== JSON.stringify(next)) { configRevision += 1; probeCache = null; }
    config = next;
    try {
      if (nativeSender) await nativeSender.syncConfig(next);
      assertCurrent();
    } catch (error) { paused = true; lifecycle += 1; await pauseNative().catch(() => {}); throw error; }
  }

  async function enrollCustomers(next) {
    assertCurrent();
    if (paused || !config || activeScopedGrant) throw new Error('接待已暂停或属于临时单会话授权，不能自动扩大客户范围。');
    assertAdditiveEnrollment(config, next);
    const ticket = lifecycle, revision = configRevision;
    // 与发送共用串行队列，原有请求核实结束后才扩大本次已授权的私聊范围。
    const pending = sendQueue.then(async () => {
      assertCurrent();
      if (paused || ticket !== lifecycle || revision !== configRevision) throw new Error('接纳期间接待已暂停或规则变化，请重新核对。');
      if (activeTransport === 'native-background') {
        if (typeof nativeSender?.enrollCustomers !== 'function') throw new Error('原生组件尚不支持新私聊增量授权，请更新后重试。');
        await nativeSender.enrollCustomers(next);
        assertCurrent();
      }
      if (paused || ticket !== lifecycle || revision !== configRevision) throw new Error('接纳期间接待已暂停或规则变化，请重新核对。');
      config = next;
    });
    sendQueue = pending.catch(() => {});
    return pending;
  }

  async function readBatches(ids, ticket, revision) {
    const snapshots = [];
    for (let offset = 0; offset < ids.length; offset += 20) {
      const batch = await reader.readForReplies(ids.slice(offset, offset + 20));
      assertCurrent();
      if (paused || ticket !== lifecycle || revision !== configRevision) return null;
      if (!Array.isArray(batch)) throw new Error('私聊读取结果格式不完整。');
      snapshots.push(...batch);
    }
    return snapshots;
  }

  function messageEvents(snapshots, ids, scopedGrant = null) {
    const events = [];
    for (const snapshot of snapshots) {
      const chatId = snapshot.metadata?.chat_username;
      if (!ids.includes(chatId) || snapshot.metadata?.chat_type !== 'private' || !Array.isArray(snapshot.messages)) throw new Error('读取结果与接待白名单不一致。');
      for (const message of snapshot.messages) {
        const time = message.timestamp * 1000;
        if (!Number.isFinite(time) || time < startedAt || time > now() + 5000) continue;
        // 只认明确方向，不用昵称猜测；未知作者不会触发回复。
        const localType = String(message.local_type);
        const sender = ['10000', '10002'].includes(localType) ? 'system' : message.sender === '我' ? 'merchant' : message.sender_username === chatId ? 'customer' : 'system';
        if (scopedGrant && (sender === 'system' || sender === 'customer' && (String(message.local_type) !== '1' || typeof message.content !== 'string' || !scopedGrant.target.acceptUnprefixedTestMessages && !message.content.startsWith(scopedGrant.target.testPrefix)))) continue;
        const serverId = String(message.server_id || '');
        const localId = String(message.local_id || '');
        const identity = /^\d+$/.test(serverId) && /[1-9]/.test(serverId) ? `server:${serverId}` : localId && message.source_database ? `local:${message.source_database}:${localId}` : '';
        if (!identity || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 8000) continue;
        const scope = workspace && workspace.id !== 'legacy' ? `${workspace.id}|` : '';
        const id = createHash('sha256').update(`${scope}${chatId}|${identity}`).digest('hex');
        const kind = localType === '10000' && message.sender === '系统' && isFriendAddedSystemText(message.content) ? 'friend-added' : localType === '1' ? 'text' : 'unsupported';
        events.push({ id: `wx:${id}`, nativeMessageId: /^\d+$/.test(serverId) && /[1-9]/.test(serverId) ? serverId : undefined, chatId, sender, text: message.content, date: new Date(time).toISOString(), source: 'realtime', kind });
      }
    }
    return events.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  }

  async function discover() {
    assertCurrent();
    const empty = { contacts: [], events: [] };
    if (paused || !config?.settings.enabled || config.settings.autoEnrollNewContacts === false || activeScopedGrant || typeof reader.probePrivateChats !== 'function') return empty;
    const ticket = lifecycle, revision = configRevision;
    const chats = probeCache?.ticket === ticket && probeCache.revision === revision ? probeCache.chats : await reader.probePrivateChats(startedAt);
    probeCache = null;
    assertCurrent();
    if (paused || ticket !== lifecycle || revision !== configRevision) return empty;
    if (!Array.isArray(chats) || chats.length > 2000) throw new Error('新私聊目录无法核验，已停止自动接纳。');
    const known = new Set(config.customers.map(customer => customer.wechatId));
    const candidates = new Map();
    for (const chat of chats) if (chat?.type === 'private' && (chat.inbound === true && chat.lastIncomingAt >= startedAt || chat.systemChanged === true && chat.lastSystemAt >= startedAt) && isEnrollmentChatId(chat.id) && !known.has(chat.id) && !excludedChatIds().includes(chat.id) && watermarks.get(chat.id) !== chat.watermark && !candidates.has(chat.id)) candidates.set(chat.id, { wechatId: chat.id, name: typeof chat.name === 'string' && chat.name.trim() ? chat.name.slice(0, 120) : chat.id });
    const capacity = Math.max(0, 500 - config.customers.length);
    if (!capacity || !candidates.size) return empty;
    const unknown = [...candidates.keys()];
    const offset = discoveryCursor % unknown.length;
    // 目录可能多于档案容量，分轮检查，避免前面的旧会话长期挡住后来的新私聊。
    const ids = [...unknown.slice(offset), ...unknown.slice(0, offset)].slice(0, 500);
    discoveryCursor = (offset + ids.length) % unknown.length;
    const snapshots = await readBatches(ids, ticket, revision);
    if (!snapshots) return empty;
    for (const chat of chats) if (ids.includes(chat.id)) watermarks.set(chat.id, chat.watermark);
    const events = messageEvents(snapshots, ids);
    const contacts = [];
    const triggers = new Map();
    const firstActivity = new Map();
    for (const event of events) if (event.kind === 'friend-added' || event.sender === 'customer' && event.kind === 'text') {
      if (!firstActivity.has(event.chatId)) firstActivity.set(event.chatId, event.date);
    }
    for (const event of events) if (event.kind === 'friend-added') triggers.set(event.chatId, triggers.get(event.chatId) || event);
    for (const event of events) if (event.sender === 'customer' && event.kind === 'text' && !triggers.has(event.chatId)) triggers.set(event.chatId, event);
    for (const [chatId, event] of [...triggers].slice(0, capacity)) {
      contacts.push({ ...candidates.get(chatId), date: firstActivity.get(chatId) || event.date });
    }
    const accepted = new Set(contacts.map(contact => contact.wechatId));
    // 好友提示只产生欢迎事件；系统正文不进入客户咨询或模型上下文。
    return { contacts, welcomes: [...triggers.values()].filter(event => accepted.has(event.chatId) && !events.some(item => item.chatId === event.chatId && item.sender === 'merchant' && item.date >= event.date)).map(event => ({ chatId: event.chatId, eventId: `${event.kind === 'friend-added' ? 'friend-added' : 'new-private'}:${event.id}`, date: event.date })), events: events.filter(event => accepted.has(event.chatId) && event.date >= firstActivity.get(event.chatId) && event.sender !== 'system' && event.kind === 'text') };
  }

  async function poll() {
    assertCurrent();
    if (paused || !config) return [];
    const scopedGrant = activeScopedGrant;
    if (scopedGrant) assertScopedSelection(scopedGrant.target, config);
    const selected = new Set(config.settings.selectedCustomerIds);
    let ids = config.customers.filter(c => selected.has(c.id) && c.autoReplyEnabled && !c.humanTakeover).map(c => c.wechatId);
    if (ids.length > 500 || new Set(ids).size !== ids.length) throw new Error('接待客户映射不明确或超过500位，已暂停。');
    if (!scopedGrant && typeof reader.probePrivateChats === 'function') {
      const ticket = lifecycle, revision = configRevision;
      const chats = await reader.probePrivateChats(startedAt);
      assertCurrent();
      if (paused || ticket !== lifecycle || revision !== configRevision) return [];
      probeCache = { ticket, revision, chats };
      const changed = new Set(chats.filter(chat => watermarks.get(chat.id) !== chat.watermark).map(chat => chat.id));
      ids = ids.filter(id => changed.has(id));
    }
    if (!ids.length) return [];
    const snapshots = await readBatches(ids, lifecycle, configRevision);
    assertCurrent();
    if (paused || !snapshots) return [];
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
    lastError = '';
    if (probeCache) for (const chat of probeCache.chats) if (ids.includes(chat.id)) watermarks.set(chat.id, chat.watermark);
    return messageEvents(snapshots, ids, scopedGrant);
  }

  async function sendOne({ chatId, text, idempotencyKey }) {
    try { assertCurrent(); } catch (error) { return { status: 'failed', error: error.message }; }
    if (paused || !config) return { status: 'failed', error: '本地接待已暂停。' };
    const selected = new Set(config.settings.selectedCustomerIds);
    if (!config.customers.some(c => c.wechatId === chatId && selected.has(c.id) && c.autoReplyEnabled && !c.humanTakeover)) return { status: 'failed', error: '该会话不在客服白名单或已由人工接管。' };
    const ticket = lifecycle, revision = configRevision;
    if (activeTransport === 'native-background') return sendNative({ chatId, text, idempotencyKey }, ticket, revision);
    if (nativeSender) {
      try {
        const current = await nativeStatus(true);
        if (current.configured || paused || ticket !== lifecycle || revision !== configRevision) return { status: 'failed', error: '发送器或接待规则已变化，请重新核对后启动。' };
      } catch { return { status: 'failed', error: '无法核对原生发送器，未调用其他发送网关。' }; }
    }
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

  async function sendManualOne({ chatId, text, idempotencyKey } = {}) {
    try { assertCurrent(); } catch (error) { return { status: 'failed', error: error.message }; }
    if (!isEnrollmentChatId(chatId) || typeof text !== 'string' || !text.trim() || text.length > 300 || !text.isWellFormed() || text.includes('\0') || Buffer.byteLength(text, 'utf8') > 1023 || typeof idempotencyKey !== 'string' || !/^manual:[0-9a-f-]{36}$/i.test(idempotencyKey)) return { status: 'failed', error: '手动回复的会话、正文或唯一请求编号不正确。' };
    if (typeof nativeSender?.sendManual !== 'function') return { status: 'failed', error: '当前发送网关不支持单次手动回复，请使用已启用的原生后台发送组件。' };
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');
    const previous = nativeAttempts.get(idempotencyKey);
    if (previous) return previous.chatId === chatId && previous.textSha256 === digest ? previous.result : { status: 'failed', error: '同一手动请求不能更换会话或正文。' };
    try {
      await nativePause;
      const current = await nativeStatus(true);
      if (!current?.configured || !current.canSend) throw new Error();
      assertCurrent();
    } catch { return { status: 'failed', error: '本机原生发送组件尚未就绪，请启用并核对当前微信账号。' }; }
    if (nativeAttempts.size >= 5000) return { status: 'failed', error: '本次发送记录已满，请先整理记录。' };
    // 人工单次授权独立于自动接待开关，派发后结果不明也不改用其他网关或重发。
    const attempt = { chatId, textSha256: digest, result: { status: 'unknown', error: '手动发送结果未知，请核对微信；不会重发。' } };
    nativeAttempts.set(idempotencyKey, attempt);
    try {
      const result = await nativeSender.sendManual({ chatId, text, idempotencyKey });
      assertCurrent();
      if (result?.status === 'sent' && result.chatId === chatId && result.workspaceToken === workspace?.workspaceToken && result.readback === true && result.textSha256 === digest && typeof result.messageId === 'string' && /^[0-9]{1,40}$/.test(result.messageId) && /[1-9]/.test(result.messageId)) attempt.result = { status: 'sent', messageId: result.messageId };
      else if (result?.status === 'failed') attempt.result = { status: 'failed', error: '原生组件未执行本次手动发送，请核对组件状态。' };
    } catch { /* 已有单次尝试必须保持未知，不猜测是否送达。 */ }
    return attempt.result;
  }

  function sendManual(input) {
    const pending = sendQueue.then(() => sendManualOne(input));
    sendQueue = pending.catch(() => {});
    return pending;
  }

  function pause() { paused = true; lifecycle += 1; probeCache = null; return pauseNative(); }
  function fail(error) { lastError = error?.message || '本地读取异常。'; return pause(); }
  return { status, start, syncConfig, enrollCustomers, discover, poll, send, sendManual, pause, fail };
}
