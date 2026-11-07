import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createReplyEngine } from './reply-engine.mjs';
import { createReplyAdapter } from './reply-adapter.mjs';
import { containsCredentialLikeText } from './credential-guard.mjs';
import { assertAdditiveEnrollment, requestReplyEnrollment } from './reply-enrollment.mjs';
import { LocalError, guardLocalRequest, readLocalBody, sendLocalJson } from './service.mjs';

const PREFIX = '/__local-wechat/replies';

export async function createLocalReplyService({ root, reader, origin, fetch: request = globalThis.fetch, adapter: suppliedAdapter, pollMs = 30_000, generate: suppliedGenerate, workspace, currentWorkspace, nativeSender, nativeVerificationMode = false } = {}) {
  const address = new URL(origin);
  const requestLocalAPI = request;
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1') throw new Error('接待后台只能请求同一本机服务。');
  if (workspace && workspace.id !== 'legacy' && !/^acct-[a-f0-9]{20}$/.test(workspace.id)) throw new Error('接待工作区标识不正确。');
  const adapter = suppliedAdapter || createReplyAdapter({ root, reader, fetch: request, workspace, currentWorkspace, nativeSender });
  let closed = false;
  let polling = null;
  let runEpoch = 0;
  let pollController = null;
  let stateRevision;
  function assertCurrent() {
    if (closed || workspace && currentWorkspace?.() !== workspace.workspaceToken) throw new LocalError(409, '微信工作区已切换，接待已停止，请刷新页面。', 'WORKSPACE_CHANGED');
  }
  function checkWorkspace(incoming) {
    assertCurrent();
    if (workspace && incoming.headers['x-kexu-workspace'] !== workspace.workspaceToken) throw new LocalError(409, '微信工作区已切换，请刷新页面后重试。', 'WORKSPACE_CHANGED');
  }
  const generateReply = suppliedGenerate || (async (work, { signal } = {}) => {
    if (containsCredentialLikeText(work.message?.text) || work.messages?.some(message => containsCredentialLikeText(message?.text))) throw new Error('消息可能包含密钥，已停止自动处理，请人工核对。');
    let scopedTest = false;
    try {
      const policy = JSON.parse(await readFile(path.join(root, '.local-wechat', 'reply-adapter.json'), 'utf8'));
      scopedTest = policy.type === 'scoped-test-http' && policy.workspaceToken === workspace?.workspaceToken;
    } catch { /* 没有临时测试配置时沿用正常接待上下文。 */ }
    // 本地身份cookie仅在回环开发服务有效，云端不接受此身份。
    const response = await request(`${address.origin}/api/reply`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(75_000)]),
      headers: { Origin: address.origin, 'Content-Type': 'application/json', Cookie: '__sites_local_auth=1', ...(workspace ? { 'X-Kexu-Workspace': workspace.workspaceToken } : {}) },
      // 临时验收只提交本批新问题，不把历史导入资料作为模型上下文。
      body: JSON.stringify({ customerId: work.customerId, message: work.message, ...(work.messages ? { messages: work.messages } : {}), context: scopedTest || nativeSender && nativeVerificationMode === true ? [] : (work.context || []).filter(message => !containsCredentialLikeText(message?.text)) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '接待回复生成失败，请检查AI配置。');
    return data;
  });
  const generate = async (...args) => { assertCurrent(); const result = await generateReply(...args); assertCurrent(); return result; };
  const queueDirectory = path.join(root, '.local-wechat', 'replies', ...(workspace && workspace.id !== 'legacy' ? [workspace.id] : []));
  const engine = await createReplyEngine({ directory: queueDirectory, send: input => { assertCurrent(); return adapter.send(input); }, ...(typeof adapter.sendManual === 'function' ? { sendManual: input => { assertCurrent(); return adapter.sendManual(input); } } : {}), generate });

  async function pause() {
    runEpoch += 1; pollController?.abort();
    // 同步封禁适配器并停止引擎，不强杀已经进入原生调用的任务。
    let stopping;
    try { stopping = Promise.resolve(adapter.pause()); } catch (error) { stopping = Promise.reject(error); }
    stopping.catch(() => {});
    try { return await engine.pause(); } finally { await stopping; }
  }

  async function status() {
    assertCurrent();
    const result = { ...await engine.status(), adapter: await adapter.status({ probe: true }), pollIntervalSeconds: Math.round(pollMs / 1000), ...(stateRevision !== undefined ? { stateRevision } : {}), ...(workspace ? { active: workspace, workspaceToken: workspace.workspaceToken } : {}) };
    assertCurrent();
    return result;
  }

  async function poll() {
    if (closed || polling || !(await engine.status()).running) return;
    if (closed || polling) return;
    const ticket = runEpoch;
    const controller = new AbortController(); pollController = controller;
    const stillRunning = async () => !closed && ticket === runEpoch && (await engine.status()).running;
    polling = (async () => {
      try {
        assertCurrent();
        let config = await engine.getConfig();
        await adapter.syncConfig(config);
        const events = await adapter.poll();
        assertCurrent();
        // 读取期间暂停或关闭后，不再将刚读出的新消息加入接待队列。
        if (!await stillRunning()) return;
        const discovered = typeof adapter.discover === 'function' ? await adapter.discover() : { contacts: [], events: [] };
        if (!await stillRunning()) return;
        for (let offset = 0; offset < discovered.contacts.length; offset += 20) {
          const contacts = discovered.contacts.slice(offset, offset + 20);
          const enrolled = await requestReplyEnrollment({ origin: address.origin, request, contacts, workspace, signal: controller.signal });
          assertCurrent();
          if (!await stillRunning()) return;
          assertAdditiveEnrollment(config, enrolled.config);
          await adapter.enrollCustomers(enrolled.config);
          if (!await stillRunning()) return;
          await engine.enrollCustomers(enrolled.config);
          if (!await stillRunning()) return;
          config = await engine.getConfig();
          stateRevision = enrolled.revision;
        }
        const allowed = new Set(config.customers.filter(customer => config.settings.selectedCustomerIds.includes(customer.id) && customer.autoReplyEnabled && !customer.humanTakeover).map(customer => customer.wechatId));
        events.push(...discovered.events.filter(event => allowed.has(event.chatId)));
        const manualChats = new Set(events.filter(event => event.sender === 'merchant').map(event => event.chatId));
        const welcomeEvents = [...(discovered.welcomes || []), ...events.filter(event => event.kind === 'friend-added' || event.sender === 'customer' && event.kind === 'text').map(event => ({ chatId: event.chatId, eventId: `${event.kind === 'friend-added' ? 'friend-added' : 'new-private'}:${event.id}`, date: event.date }))];
        const welcomed = new Set();
        for (const welcome of welcomeEvents) {
          if (!await stillRunning()) return;
          // engine仅允许持久化新接纳资格；已有人手动回复的同批会话不再发欢迎。
          if (allowed.has(welcome.chatId) && !manualChats.has(welcome.chatId) && !welcomed.has(welcome.chatId)) { await engine.enqueueWelcome(welcome); welcomed.add(welcome.chatId); }
        }
        events.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
        for (const event of events) if (event.kind !== 'friend-added') await engine.ingest(event);
      } catch (error) {
        if (closed || ticket !== runEpoch) return;
        runEpoch += 1;
        const stopping = Promise.resolve(adapter.fail(error));
        stopping.catch(() => {});
        try { await engine.pause(error?.message || '本机新消息读取失败。'); } finally { await stopping; }
      }
    })().finally(() => { polling = null; if (pollController === controller) pollController = null; });
    return polling;
  }
  const timer = setInterval(() => { void poll().catch(() => {}); }, pollMs);
  timer.unref?.();

  async function handle(request, response) {
    const pathname = String(request.url || '').split('?')[0];
    if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;
    try {
      const write = request.method === 'POST';
      guardLocalRequest(request, '/replies', write);
      checkWorkspace(request);
      if (closed) throw new LocalError(503, '本机接待服务已停止。');
      const route = pathname.slice(PREFIX.length);
      if (request.method === 'GET' && route === '/status') sendLocalJson(response, 200, await status());
      else if (request.method === 'GET' && /^\/jobs\/[0-9a-f-]{36}$/.test(route)) {
        const job = await engine.getJob(route.slice('/jobs/'.length));
        if (!job) throw new LocalError(404, '未找到该发送任务，请核对微信实际记录；不会自动重发。');
        sendLocalJson(response, 200, { job });
      }
      else if (write) {
        const input = await readLocalBody(request, route === '/config' ? 1_400_000 : 24_000);
        checkWorkspace(request);
        const empty = () => { if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length) throw new LocalError(400, '此操作不接收额外参数。'); };
        if (route === '/config') {
          // 配置变更先停发，避免规则校验与后台发送交叉；需商家确认后重新启动。
          await pause();
          assertCurrent();
          if (input?.settings?.mode === 'auto' && !(await adapter.status({ probe: true })).canSend) throw new LocalError(409, '自动发送尚未接通，请使用草稿接待。');
          await engine.syncConfig(input);
          const config = await engine.getConfig();
          assertCurrent();
          await adapter.syncConfig(config);
          if (!config.settings.enabled) await adapter.pause();
        } else if (route === '/start') {
          empty();
          runEpoch += 1;
          const config = await engine.getConfig();
          if (!config?.settings.enabled) throw new LocalError(400, '请先保存并启用接待规则。');
          await adapter.start(config);
          try { assertCurrent(); await engine.start(); } catch (error) { await adapter.pause(); throw error; }
          void poll().catch(() => {});
        } else if (route === '/pause') { empty(); await pause(); }
        else if (route === '/manual') {
          if (!input || Array.isArray(input) || Object.keys(input).some(key => !['jobId', 'requestId', 'text'].includes(key)) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.jobId || '') || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId || '') || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 300 || !input.text.isWellFormed() || input.text.includes('\0') || Buffer.byteLength(input.text, 'utf8') > 1023) throw new LocalError(400, '手动回复仅接收原任务编号、唯一请求编号和300字以内的消息。');
          const source = await engine.getJob(input.jobId);
          if (!source) throw new LocalError(404, '原接待任务不存在，请刷新处理队列。');
          // 客户身份只从当前工作区持久资料核对，浏览器不能指定另一位收件人。
          const stateResponse = await requestLocalAPI(`${address.origin}/api/state`, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Origin: address.origin, 'X-Kexu-Local': '1', Cookie: '__sites_local_auth=1', ...(workspace ? { 'X-Kexu-Workspace': workspace.workspaceToken } : {}) } });
          const saved = await stateResponse.json();
          assertCurrent();
          if (!stateResponse.ok || !Array.isArray(saved?.state?.customers)) throw new LocalError(503, '当前客户资料无法核验，未发送手动回复。');
          const matches = saved.state.customers.filter(customer => customer.id === source.customerId);
          if (matches.length !== 1 || matches[0].source === 'demo' || matches[0].wechatId !== source.chatId || saved.state.customers.filter(customer => customer.wechatId === source.chatId).length !== 1) throw new LocalError(409, '原任务必须唯一对应当前工作区的真实微信客户，未发送。');
          const existing = await engine.getManualRequest(input);
          if (existing && existing.status !== 'draft') { sendLocalJson(response, 200, { job: existing }); return true; }
          if (typeof adapter.sendManual !== 'function' || !(await adapter.status({ probe: true })).canManualSend) throw new LocalError(409, '单次手动发送尚未就绪，请先启用并核对原生后台发送组件。');
          assertCurrent();
          const prepared = await engine.prepareManual({ ...input, text: input.text.trim() });
          // 人工接管保存在本地引擎，不改动页面经营资料的revision与自动接待开关。
          await adapter.syncConfig(await engine.getConfig());
          assertCurrent();
          const job = prepared.job.status === 'draft' ? await engine.dispatchManual(prepared.job.id) : prepared.job;
          assertCurrent();
          sendLocalJson(response, 200, { job }); return true;
        }
        else if (route === '/followup') {
          if (!input || Array.isArray(input) || Object.keys(input).some(key => key !== 'taskId') || typeof input.taskId !== 'string' || !input.taskId || input.taskId.length > 160 || /[\u0000-\u001f]/.test(input.taskId)) throw new LocalError(400, '一键跟进只接收已保存的任务编号。');
          const ticket = runEpoch;
          if (!(await engine.status()).running) throw new LocalError(409, '本地回复尚未运行，请在自动回复页核对规则后主动启动。');
          if (!(await adapter.status({ probe: true })).canSend) throw new LocalError(409, '本地发送组件尚未就绪，请先检查并启用。');
          const preparedResponse = await requestLocalAPI(`${address.origin}/api/followup`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Origin: address.origin, 'Content-Type': 'application/json', 'X-Kexu-Local': '1', Cookie: '__sites_local_auth=1', ...(workspace ? { 'X-Kexu-Workspace': workspace.workspaceToken } : {}) }, body: JSON.stringify({ taskId: input.taskId }) });
          const prepared = await preparedResponse.json();
          assertCurrent();
          if (!preparedResponse.ok) throw new LocalError(preparedResponse.status, typeof prepared.error === 'string' ? prepared.error : '已保存的跟进任务尚不满足发送条件。');
          if (!prepared || Object.keys(prepared).some(key => !['taskId', 'customerId', 'text'].includes(key)) || prepared.taskId !== input.taskId || typeof prepared.customerId !== 'string' || !prepared.customerId || typeof prepared.text !== 'string' || !prepared.text.trim() || prepared.text.length > 300 || !prepared.text.isWellFormed() || prepared.text.includes('\0')) throw new LocalError(502, '已保存的跟进话术回执无法核验，未发送。');
          if (ticket !== runEpoch || !(await engine.status()).running) throw new LocalError(409, '准备跟进期间接待已暂停或规则变化，未发送。');
          const followup = await engine.enqueueFollowup(prepared);
          assertCurrent();
          sendLocalJson(response, 200, { followup, job: followup.jobId ? await engine.getJob(followup.jobId) : null }); return true;
        }
        else if (route === '/takeover') { await engine.takeover(input); await adapter.syncConfig(await engine.getConfig()); }
        else if (route === '/work') { empty(); sendLocalJson(response, 200, await engine.claimWork()); return true; }
        else {
          const match = route.match(/^\/jobs\/([0-9a-f-]{36})\/(approve|reject|result)$/);
          if (!match) throw new LocalError(404, '未找到该接待操作。');
          if (match[2] === 'approve') {
            empty();
            if (!(await adapter.status({ probe: true })).canSend) throw new LocalError(409, '自动发送尚未接通。请复制草稿手动发送，或先安装并验收发送网关。');
            assertCurrent();
            await engine.approve(match[1]);
          } else if (match[2] === 'reject') {
            if (!input || Object.keys(input).some(key => key !== 'reason') || (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 500))) throw new LocalError(400, '请填写500字以内的取消原因。');
            await engine.reject(match[1], input.reason);
          } else {
            if (!input || Object.keys(input).some(key => !['leaseId', 'result', 'error'].includes(key))) throw new LocalError(400, '草稿结果格式不正确。');
            await engine.completeWork({ jobId: match[1], ...input });
          }
        }
        sendLocalJson(response, 200, await status());
      } else throw new LocalError(405, '该接待接口不支持此操作。');
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendLocalJson(response, Number.isInteger(error.status) ? error.status : 503, { error: error.status ? error.message : '本机接待暂不可用，请检查组件或配置。', ...(error.code === 'WORKSPACE_CHANGED' ? { code: error.code } : {}) });
    }
    return true;
  }

  async function close() {
    closed = true;
    runEpoch += 1; pollController?.abort();
    clearInterval(timer);
    let stopping;
    try { stopping = Promise.resolve(adapter.pause()); } catch (error) { stopping = Promise.reject(error); }
    stopping.catch(() => {});
    try { await engine.close(); await polling; } finally { await stopping; }
    // reader.close由拥有者调用，会取消正在执行的只读导出。
  }
  return { handle, close, pause, status, poll };
}
