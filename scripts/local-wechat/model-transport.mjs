import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fetch as nodeFetch, ProxyAgent } from 'undici';

const ROUTE = '/__local-wechat/model-transport';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_BODY = 2_000_000;
const MAX_RESPONSE = 2_000_000;

function targetUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) throw new Error('invalid target');
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const privateHost = !host.includes('.') || host.startsWith('[') || /^[\d.]+$/.test(host)
    || /(^|[.-])(?:127|10|0|169[.-]254|192[.-]168|172[.-](?:1[6-9]|2\d|3[01]))[.-]/.test(host)
    || ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'test', 'invalid', 'onion'].some(s => host === s || host.endsWith(`.${s}`));
  if (url.protocol !== 'https:' || privateHost || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443') || !url.pathname.endsWith('/chat/completions')) throw new Error('invalid target');
  return url.href;
}

function reply(response, status, message, code) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(code ? { 'X-Kexu-Transport-Error': code } : {}) });
  response.end(JSON.stringify({ error: { message } }));
}

export function createLocalModelTransport({ root, token, fetch: request = nodeFetch } = {}) {
  let cachedProxy = '';
  let dispatcher;
  let closed = false;
  const active = new Set();

  async function proxy() {
    let value;
    try {
      const file = path.join(root, '.local-wechat', 'network.json');
      if ((await stat(file)).size > 8192) throw new Error('network config too large');
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file)));
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => key !== 'httpsProxy')) throw new Error('invalid network config');
      value = data.httpsProxy;
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('invalid network config'); value = process.env.HTTPS_PROXY || process.env.https_proxy || ''; }
    if (value === '' || value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.length > 500) throw new Error('invalid proxy');
    let url;
    try { url = new URL(value); } catch { throw new Error('invalid proxy'); }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid proxy');
    return url.origin;
  }

  async function status() {
    try {
      const value = await proxy();
      return { configured: !!token, mode: value ? 'proxy' : 'direct', ...(value ? { proxy: value } : {}), message: value ? '模型请求通过本机代理发送；请保持代理软件运行。' : '模型请求使用本机直连网络。' };
    } catch { return { configured: false, mode: 'error', message: '本机模型网络配置格式无效，请检查网络设置。' }; }
  }

  async function handle(incoming, response) {
    if (String(incoming.url || '').split('?')[0] !== ROUTE) return false;
    const supplied = incoming.headers['x-kexu-model-token'];
    const allowed = typeof token === 'string' && token.length >= 32 && typeof supplied === 'string' && Buffer.byteLength(supplied) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
    if (closed || !LOOPBACK.has(incoming.socket.remoteAddress) || !/^(?:127\.0\.0\.1|localhost)(?::[1-9]\d{0,4})?$/i.test(String(incoming.headers.host || '')) || !allowed) { reply(response, 403, '本机模型传输需要内部凭证。', 'config'); return true; }
    if (incoming.method !== 'POST' || !/^application\/json(?:;|$)/i.test(String(incoming.headers['content-type'] || ''))) { reply(response, 405, '模型传输仅接受内部JSON请求。', 'config'); return true; }
    let url;
    const authorization = incoming.headers.authorization;
    try {
      url = targetUrl(incoming.headers['x-kexu-model-url']);
      if (typeof authorization !== 'string' || !/^Bearer [^\r\n\u0000]{1,8192}$/.test(authorization)) throw new Error('invalid authorization');
    } catch { reply(response, 400, '模型接口地址或认证格式不正确。', 'config'); return true; }
    const controller = new AbortController();
    active.add(controller);
    const timer = setTimeout(() => controller.abort(), 45_000);
    const abort = () => controller.abort();
    incoming.once('aborted', abort);
    response.once('close', abort);
    try {
      const chunks = []; let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > MAX_BODY) { reply(response, 413, '模型请求内容过多。', 'config'); return true; }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!data || typeof data !== 'object' || typeof data.model !== 'string' || !Array.isArray(data.messages) || data.stream !== false) { reply(response, 400, '模型请求格式不正确。', 'config'); return true; }
      const selectedProxy = await proxy();
      if (selectedProxy !== cachedProxy) {
        const previous = dispatcher;
        dispatcher = selectedProxy ? new ProxyAgent(selectedProxy) : undefined;
        cachedProxy = selectedProxy;
        void previous?.close().catch(() => {});
      }
      // 仅保留必要请求头，不转发浏览器Cookie、内部凭证或其他上游身份。
      const upstream = await request(url, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json' }, body: bytes, redirect: 'manual', signal: controller.signal, ...(dispatcher ? { dispatcher } : {}) });
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel(); reply(response, 502, '模型接口返回跳转，已拒绝转发密钥。', 'invalid_response'); return true;
      }
      const output = []; let length = 0;
      if (upstream.body) for await (const chunk of upstream.body) {
        length += chunk.length;
        if (length > MAX_RESPONSE) { controller.abort(); reply(response, 502, '模型响应超过本机容量。', 'invalid_response'); return true; }
        output.push(chunk);
      }
      // 不记录请求正文、密钥或供应商响应；由受保护的应用接口继续验证结构。
      response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(Buffer.concat(output));
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        const code = String(error?.cause?.code || error?.code || '');
        const kind = /CERT|TLS|SSL|UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(code) ? 'tls' : /invalid (?:proxy|network config)/.test(error?.message || '') ? 'config' : cachedProxy ? 'proxy_unreachable' : 'upstream_unreachable';
        reply(response, 502, kind === 'tls' ? '模型服务TLS校验失败，请检查本机证书和网络。' : kind === 'config' ? '本机模型代理配置无效。' : kind === 'proxy_unreachable' ? '无法通过本机代理连接模型，请确认代理软件正在运行。' : '本机无法直连模型服务，请检查网络或配置本机代理。', kind);
      }
    } finally {
      clearTimeout(timer); active.delete(controller); incoming.removeListener('aborted', abort); response.removeListener('close', abort);
    }
    return true;
  }

  async function close() { closed = true; for (const controller of active) controller.abort(); await dispatcher?.close(); }
  return { handle, status, close };
}
