import { createLocalWechatService } from "./service.mjs";

/** 本地模式专用的开发插件。@returns {import('vite').Plugin} */
export function localWechatPlugin() {
  let service;
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
        void service.handle(request, response).then((handled) => { if (!handled) next(); }).catch(next);
      });
      server.httpServer?.once("close", () => { void service.close(); });
    },
    async closeBundle() { await service?.close(); },
  };
}

export default localWechatPlugin;
