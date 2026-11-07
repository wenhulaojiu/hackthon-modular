import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createLocalModelTransport } from '../scripts/local-wechat/model-transport.mjs';

const TOKEN = 'synthetic-internal-token-at-least-32';
const payload = { model: 'test-model', messages: [{ role: 'user', content: '合成请求' }], stream: false };

async function fixture(t, responder) {
  const base = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(base, 'kexu-model-transport-'));
  await mkdir(path.join(root, '.local-wechat'));
  await writeFile(path.join(root, '.local-wechat', 'network.json'), JSON.stringify({ httpsProxy: '' }), 'utf8');
  const calls = [];
  const transport = createLocalModelTransport({ root, token: TOKEN, fetch: async (...args) => { calls.push(args); return responder ? responder(...args) : Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }); } });
  const server = http.createServer((req, res) => { void transport.handle(req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (headers = {}, data = payload) => fetch(`${origin}/__local-wechat/model-transport`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kexu-Model-Token': TOKEN, 'X-Kexu-Model-Url': 'https://api.openai.com/v1/chat/completions', Authorization: 'Bearer SYNTHETIC_USER_KEY', ...headers }, body: JSON.stringify(data) });
  t.after(async () => {
    await transport.close(); await new Promise(resolve => server.close(resolve));
    const absolute = await realpath(root); assert.equal(path.dirname(absolute).toLowerCase(), base.toLowerCase()); assert.ok(path.basename(absolute).startsWith('kexu-model-transport-'));
    await rm(absolute, { recursive: true, force: true });
  });
  const rawCall = (headers = {}) => new Promise((resolve, reject) => {
    const request = http.request(`${origin}/__local-wechat/model-transport`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kexu-Model-Token': TOKEN, 'X-Kexu-Model-Url': 'https://api.openai.com/v1/chat/completions', Authorization: 'Bearer SYNTHETIC_USER_KEY', ...headers } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end(JSON.stringify(payload));
  });
  return { root, transport, call, rawCall, calls };
}

test('内部模型桥拒绝缺失令牌和伪Host，不能成为网页可调用的开放代理', async t => {
  const f = await fixture(t);
  assert.equal((await f.call({ 'X-Kexu-Model-Token': 'wrong' })).status, 403);
  assert.equal(await f.rawCall({ Host: 'evil.example' }), 403);
  assert.equal(f.calls.length, 0);
});

test('只转发校验过的HTTPS模型请求，内部令牌与Cookie不流向供应商', async t => {
  const f = await fixture(t);
  const response = await f.call({ Cookie: 'private=synthetic' });
  assert.equal(response.status, 200);
  assert.equal(f.calls.length, 1);
  const [target, init] = f.calls[0];
  assert.equal(target, 'https://api.openai.com/v1/chat/completions');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers.Authorization, 'Bearer SYNTHETIC_USER_KEY');
  assert.equal(init.headers.Cookie, undefined);
  assert.equal(init.headers['X-Kexu-Model-Token'], undefined);
  assert.deepEqual(JSON.parse(init.body.toString('utf8')), payload);
  for (const url of ['http://api.openai.com/v1/chat/completions', 'https://127.0.0.1/v1/chat/completions', 'https://api.example.com:8443/v1/chat/completions', 'https://user:secret@api.example.com/v1/chat/completions', 'https://api.example.com/v1/models', 'https://api.example.com/v1/chat/completions?secret=x']) assert.equal((await f.call({ 'X-Kexu-Model-Url': url })).status, 400);
  assert.equal(f.calls.length, 1);
});

test('供应商重定向不跟随，认证错误原HTTP状态可传给应用校验', async t => {
  let redirect = true;
  const f = await fixture(t, () => redirect ? new Response('', { status: 302, headers: { Location: 'https://other.example' } }) : Response.json({ error: { message: 'unauthorized' } }, { status: 401 }));
  const first = await f.call(); assert.equal(first.status, 502); assert.equal(first.headers.get('x-kexu-transport-error'), 'invalid_response');
  redirect = false;
  assert.equal((await f.call()).status, 401);
  assert.equal(f.calls.length, 2);
});

test('本机代理严格限定回环地址，传输错误不回显凭据', async t => {
  const f = await fixture(t, () => { throw new Error('synthetic network failure with SYNTHETIC_USER_KEY'); });
  await writeFile(path.join(f.root, '.local-wechat', 'network.json'), JSON.stringify({ httpsProxy: 'http://127.0.0.1:7890' }), 'utf8');
  assert.equal((await f.transport.status()).mode, 'proxy');
  const response = await f.call(); const body = await response.text();
  assert.equal(response.status, 502); assert.equal(response.headers.get('x-kexu-transport-error'), 'proxy_unreachable'); assert.ok(!body.includes('SYNTHETIC_USER_KEY'));
  assert.ok(f.calls[0][1].dispatcher);
  await writeFile(path.join(f.root, '.local-wechat', 'network.json'), JSON.stringify({ httpsProxy: 'http://remote.example:8080' }), 'utf8');
  assert.equal((await f.transport.status()).mode, 'error');
  assert.equal((await f.call()).headers.get('x-kexu-transport-error'), 'config');
});
