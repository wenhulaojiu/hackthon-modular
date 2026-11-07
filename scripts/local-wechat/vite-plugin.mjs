import { createLocalWechatService, LocalError, guardLocalRequest, readLocalBody, sendLocalJson } from "./service.mjs";
import { createLocalReplyService } from "./reply-service.mjs";
import { createAccountRegistry } from "./accounts.mjs";
import { createLocalModelTransport } from "./model-transport.mjs";

function trustedHeader(request, name, value) {
  delete request.headers[name];
  if (Array.isArray(request.rawHeaders)) {
    for (let index = request.rawHeaders.length - 2; index >= 0; index -= 2) if (request.rawHeaders[index].toLowerCase() === name) request.rawHeaders.splice(index, 2);
  }
  if (value !== undefined) { request.headers[name] = value; request.rawHeaders?.push(name, value); }
}

// 账号切换由唯一运行时串行完成；旧服务闭包在关闭开始时立即失效。
export async function createLocalAccountRuntime({ root, origin, registry: suppliedRegistry, readerFactory = createLocalWechatService, replyFactory = createLocalReplyService, providerNetwork } = {}) {
  const registry = suppliedRegistry || await createAccountRegistry({ root });
  let reader;
  let replies;
  let busy = false;
  let closed = false;
  const currentWorkspace = () => busy || closed ? null : registry.active().workspaceToken;
  function openServices() {
    const workspace = registry.active();
    reader = readerFactory({ root, workspace, currentWorkspace, providerNetwork, expectedDbDir: () => registry.binding?.() });
    replies = Promise.resolve(replyFactory({ root, reader, origin, workspace, currentWorkspace }));
    replies.catch(() => {});
  }
  async function stopServices() {
    await Promise.all([reader?.close(), replies?.then(value => value.close()).catch(() => {})]);
  }
  function expected(request) {
    if (request.headers['x-kexu-workspace'] !== registry.active().workspaceToken) throw new LocalError(409, '微信工作区已切换，请刷新页面后重试。', 'WORKSPACE_CHANGED');
  }
  openServices();

  async function handle(request, response) {
    const pathname = String(request.url || '').split('?')[0];
    const local = pathname === '/__local-wechat' || pathname.startsWith('/__local-wechat/');
    const api = pathname.startsWith('/api/');
    // 从浏览器移除伪造的权威头，再由本机运行时设置真实作用域。
    trustedHeader(request, 'x-kexu-local-scope');
    trustedHeader(request, 'x-kexu-local-revision');
    if (!busy && !closed) {
      const active = registry.active();
      trustedHeader(request, 'x-kexu-local-scope', active.id);
      trustedHeader(request, 'x-kexu-local-revision', active.workspaceToken.split('@')[1]);
    }
    if (!local && !api) return false;
    try {
      if (busy || closed) throw new LocalError(503, '正在切换微信工作区，请稍候刷新页面。');
      if (api) {
        if (!(request.method === 'GET' && pathname === '/api/state' && request.headers['x-kexu-workspace'] === undefined)) expected(request);
        const active = registry.active();
        trustedHeader(request, 'x-kexu-local-scope', active.id);
        trustedHeader(request, 'x-kexu-local-revision', active.workspaceToken.split('@')[1]);
        return false;
      }
      if (pathname === '/__local-wechat/accounts' && request.method === 'GET') {
        guardLocalRequest(request, '/accounts', false);
        const result = await registry.list();
        if (busy || closed) throw new LocalError(503, '正在切换微信工作区，请稍候重试。');
        sendLocalJson(response, 200, result);
        return true;
      }
      if (pathname === '/__local-wechat/accounts/select' && request.method === 'POST') {
        guardLocalRequest(request, '/accounts/select', true);
        expected(request);
        const input = await readLocalBody(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'accountId') || typeof input.accountId !== 'string') throw new LocalError(400, '请选择列表中的微信账号。');
        if (busy || closed) throw new LocalError(503, '正在切换微信工作区，请稍候重试。');
        expected(request);
        busy = true;
        try {
          await stopServices();
          await registry.select(input.accountId);
        } finally {
          if (!closed) openServices();
          busy = false;
        }
        const active = registry.active();
        sendLocalJson(response, 200, { active, workspaceToken: active.workspaceToken, reload: true });
        return true;
      }
      if (pathname === '/__local-wechat/replies' || pathname.startsWith('/__local-wechat/replies/')) return await (await replies).handle(request, response);
      return await reader.handle(request, response);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendLocalJson(response, error.status || 503, { error: error.status ? error.message : '本机工作区暂不可用，请检查本地账号配置后重试。', ...(error.code === 'WORKSPACE_CHANGED' ? { code: error.code } : {}) });
      return true;
    }
  }

  async function close() { closed = true; busy = true; await stopServices(); }
  return { handle, close, active: registry.active };
}

/** 本地模式专用的开发插件。@returns {import('vite').Plugin} */
export function localWechatPlugin({ modelBridgeToken } = {}) {
  let runtime;
  let transport;
  let closing;
  const closeAll = () => closing ||= (async () => { if (runtime) await runtime.then(value => value.close()).catch(() => {}); await transport?.close(); })();
  const enabled = () => process.env.KEXU_LOCAL_WECHAT === "1";
  return {
    name: "kexu-local-wechat",
    apply: "serve",
    config(config) {
      if (enabled()) return { server: { host: "127.0.0.1", fs: { deny: [...new Set([".env", ".env.*", "*.{crt,pem}", "**/.git/**", ...(config.server?.fs?.deny || []), "**/.local-wechat/**", "**/.dev.vars*", "**/.env*", "**/.wrangler/**"])] } } };
    },
    configResolved(config) {
      if (enabled() && !["127.0.0.1", "localhost", "::1"].includes(config.server.host)) throw new Error("本地微信模式只允许监听本机回环地址。");
    },
    configureServer(server) {
      if (!enabled()) return;
      if (modelBridgeToken) transport = createLocalModelTransport({ root: server.config.root, token: modelBridgeToken });
      runtime = createLocalAccountRuntime({ root: server.config.root, origin: `http://127.0.0.1:${server.config.server?.port || 5173}`, providerNetwork: transport ? () => transport.status() : undefined });
      // 初始化失败时保留明确错误，避免产生未处理的异步拒绝。
      runtime.catch(() => {});
      server.middlewares.use((request, response, next) => {
        // 阻止开发服务器通过静态文件或 /@fs 暴露本地配置与临时聊天。
        let requested;
        try {
          requested = (request.url || "").split("?")[0];
          for (let index = 0; index < 3; index += 1) {
            const decoded = decodeURIComponent(requested);
            if (decoded === requested) break;
            requested = decoded;
          }
          requested = requested.replace(/\\/g, "/");
        } catch { response.statusCode = 400; response.end(); return; }
        if (/(?:^|\/)(?:\.local-wechat|\.wrangler|\.git)(?:\/|$)|(?:^|\/)(?:\.env[^/]*|\.dev\.vars[^/]*)(?:\/|$)/i.test(requested)) { response.statusCode = 403; response.end("本地私有文件不能通过网页直接读取。"); return; }
        void (async () => {
          // 模型代理使用独立的服务端凭证，在账号切换期间仍可结束已有模型请求。
          if (transport && await transport.handle(request, response)) return;
          try { if (!await (await runtime).handle(request, response)) next(); }
          catch { sendLocalJson(response, 503, { error: '本地工作区无法初始化，请备份后检查本地运行目录。' }); }
        })().catch(next);
      });
      server.httpServer?.once("close", () => { void closeAll(); });
    },
    async closeBundle() { await closeAll(); },
  };
}

export default localWechatPlugin;
