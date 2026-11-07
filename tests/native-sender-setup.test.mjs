import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkedProxy, setupNativeSender } from '../scripts/local-wechat/native-sender-setup.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kexu-native-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.local-wechat'));
  await writeFile(path.join(root, '.local-wechat/config.json'), JSON.stringify({ pythonPath: path.join(root, 'synthetic-python.exe') }), 'utf8');
  const text = Buffer.from('合成许可，仅供安装边界测试\n', 'utf8');
  const dll = Buffer.from('不是真实的可执行文件，仅用于合成指纹测试', 'utf8');
  const componentLock = { version: 1, repository: 'example/synthetic', commit: 'a'.repeat(40), sources: { 'LICENSE': hash(text) }, dll: { path: 'native/build_text/text_bridge.dll', size: dll.length, sha256: hash(dll) }, pefileVersion: '2023.2.7' };
  const calls = [];
  const execute = async (program, args) => { calls.push({ program, args }); };
  return { root, text, dll, componentLock, calls, execute };
}

test('组件安装核对固定来源和指纹，仅准备隔离依赖，不执行下载的发送模块', async t => {
  const f = await fixture(t);
  const urls = [];
  const request = async (url, options) => { urls.push(url); assert.equal(options.redirect, 'error'); return new Response(url.endsWith('/LICENSE') ? f.text : f.dll); };
  const result = await setupNativeSender({ ...f, request, platform: 'win32' });
  assert.equal(result.installed, true);
  assert.equal(urls.length, 2);
  assert.ok(urls.every(url => url.startsWith(`https://raw.githubusercontent.com/example/synthetic/${'a'.repeat(40)}/`)));
  assert.deepEqual(f.calls[0].args.slice(0, 2), ['-m', 'venv']);
  assert.ok(f.calls[1].args.includes('pefile==2023.2.7'));
  assert.ok(!JSON.stringify(f.calls).includes('--dispatch'));
  assert.equal(await readFile(path.join(f.root, '.local-wechat/native-sender/component/LICENSE'), 'utf8'), f.text.toString('utf8'));
});

test('下载内容损坏时不运行Python或写入安装完成记录', async t => {
  const f = await fixture(t);
  await assert.rejects(setupNativeSender({ ...f, request: async () => new Response('错误内容'), platform: 'win32' }), /指纹/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(readFile(path.join(f.root, '.local-wechat/native-sender/installed.json')), { code: 'ENOENT' });
});

test('组件代理只接受明确的本机HTTP代理，拒绝凭据和外部地址', () => {
  assert.equal(checkedProxy('http://127.0.0.1:7890'), 'http://127.0.0.1:7890/');
  assert.equal(checkedProxy(undefined), undefined);
  for (const value of ['http://proxy.example:7890', 'http://user:password@127.0.0.1:7890', 'https://127.0.0.1:7890', 'http://127.0.0.1:7890/path']) assert.throws(() => checkedProxy(value));
});

test('非Windows环境不会进行下载或启动依赖安装', async t => {
  const f = await fixture(t);
  await assert.rejects(setupNativeSender({ ...f, request: async () => { throw new Error('不应请求'); }, platform: 'linux' }), /Windows/);
  assert.equal(f.calls.length, 0);
});
