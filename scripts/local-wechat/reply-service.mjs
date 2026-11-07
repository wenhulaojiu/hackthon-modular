import path from 'node:path';
import { createReplyEngine } from './reply-engine.mjs';
import { createReplyAdapter } from './reply-adapter.mjs';
import { LocalError, guardLocalRequest, readLocalBody, sendLocalJson } from './service.mjs';

const PREFIX = '/__local-wechat/replies';

export async function createLocalReplyService({ root, reader, origin, fetch: request = globalThis.fetch, adapter: suppliedAdapter, pollMs = 30_000, generate: suppliedGenerate } = {}) {
  const address = new URL(origin);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1') throw new Error('接待后台只能请求同一本机服务。');
  const adapter = suppliedAdapter || createReplyAdapter({ root, reader, fetch: request });
  let closed = false;
  let polling = null;
  const generate = suppliedGenerate || (async (work, { signal } = {}) => {
    // 本地身份cookie仅在回环开发服务有效，云端不接受此身份。
    const response = await request(`${address.origin}/api/reply`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(75_000)]),
      headers: { Origin: address.origin, 'Content-Type': 'application/json', Cookie: '__sites_local_auth=1' },
      body: JSON.stringify({ customerId: work.customerId, message: work.message, context: work.context }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '接待回复生成失败，请检查AI配置。');
    return data;
  });
  const engine = await createReplyEngine({ directory: path.join(root, '.local-wechat', 'replies'), send: input => adapter.send(input), generate });

  async function status() {
    return { ...await engine.status(), adapter: await adapter.status({ probe: true }), pollIntervalSeconds: Math.round(pollMs / 1000) };
  }

  async function poll() {
    if (closed || polling || !(await engine.status()).running) return;
    if (closed || polling) return;
    polling = (async () => {
      try {
        const config = await engine.getConfig();
        adapter.syncConfig(config);
        const events = await adapter.poll();
        // 读取期间暂停或关闭后，不再将刚读出的新消息加入接待队列。
        if (closed || !(await engine.status()).running) return;
        for (const event of events) await engine.ingest(event);
      } catch (error) {
        adapter.fail(error);
        await engine.pause(error?.message || '本机新消息读取失败。');
      }
    })().finally(() => { polling = null; });
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
      if (closed) throw new LocalError(503, '本机接待服务已停止。');
      const route = pathname.slice(PREFIX.length);
      if (request.method === 'GET' && route === '/status') sendLocalJson(response, 200, await status());
      else if (write) {
        const input = await readLocalBody(request, route === '/config' ? 1_400_000 : 24_000);
        const empty = () => { if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length) throw new LocalError(400, '此操作不接收额外参数。'); };
        if (route === '/config') {
          // 配置变更先停发，避免规则校验与后台发送交叉；需商家确认后重新启动。
          adapter.pause();
          await engine.pause();
          if (input?.settings?.mode === 'auto' && !(await adapter.status({ probe: true })).canSend) throw new LocalError(409, '自动发送尚未接通，请使用草稿接待。');
          await engine.syncConfig(input);
          const config = await engine.getConfig();
          adapter.syncConfig(config);
          if (!config.settings.enabled) adapter.pause();
        } else if (route === '/start') {
          empty();
          const config = await engine.getConfig();
          if (!config?.settings.enabled) throw new LocalError(400, '请先保存并启用接待规则。');
          await adapter.start(config);
          try { await engine.start(); } catch (error) { adapter.pause(); throw error; }
          void poll().catch(() => {});
        } else if (route === '/pause') { empty(); adapter.pause(); await engine.pause(); }
        else if (route === '/takeover') { await engine.takeover(input); adapter.syncConfig(await engine.getConfig()); }
        else if (route === '/work') { empty(); sendLocalJson(response, 200, await engine.claimWork()); return true; }
        else {
          const match = route.match(/^\/jobs\/([0-9a-f-]{36})\/(approve|reject|result)$/);
          if (!match) throw new LocalError(404, '未找到该接待操作。');
          if (match[2] === 'approve') {
            empty();
            if (!(await adapter.status({ probe: true })).canSend) throw new LocalError(409, '自动发送尚未接通。请复制草稿手动发送，或先安装并验收发送网关。');
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
      if (!response.headersSent && !response.destroyed) sendLocalJson(response, Number.isInteger(error.status) ? error.status : 503, { error: error.status ? error.message : '本机接待暂不可用，请检查组件或配置。' });
    }
    return true;
  }

  async function close() {
    closed = true;
    clearInterval(timer);
    adapter.pause();
    await engine.close();
    // reader.close由拥有者调用，会取消正在执行的只读导出。
  }
  return { handle, close, status, poll };
}
