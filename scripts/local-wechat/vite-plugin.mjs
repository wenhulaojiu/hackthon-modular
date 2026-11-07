import { createLocalWechatService } from "./service.mjs";
import { createLocalReplyService } from "./reply-service.mjs";

/** 本地模式专用的开发插件。@returns {import('vite').Plugin} */
export function localWechatPlugin() {
  let service;
  let replies;
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
      service = createLocalWechatService({ root: server.config.root });
      replies = createLocalReplyService({ root: server.config.root, reader: service, origin: `http://127.0.0.1:${server.config.server?.port || 5173}` });
      // 初始化失败时保留明确错误，避免产生未处理的异步拒绝。
      replies.catch(() => {});
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
          if (requested === "/__local-wechat/replies" || requested.startsWith("/__local-wechat/replies/")) {
            try { if (await (await replies).handle(request, response)) return; }
            catch { response.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify({ error: "本机接待队列无法初始化，请备份后检查本地运行目录。" })); return; }
          }
          if (!await service.handle(request, response)) next();
        })().catch(next);
      });
      server.httpServer?.once("close", () => { void replies.then(value => value.close()).catch(() => {}).finally(() => service.close()); });
    },
    async closeBundle() { if (replies) await replies.then(value => value.close()).catch(() => {}); await service?.close(); },
  };
}

export default localWechatPlugin;
