import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProxyAgent } from 'undici';

export function checkedProxy(value) {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('本机组件代理配置不正确。');
  return url.href;
}

async function exists(filename) { try { await lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
const sha = data => createHash('sha256').update(data).digest('hex');

async function writablePath(root, filename) {
  const relative = path.relative(root, filename);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('组件安装路径越界。');
  for (let current = filename; current !== root; current = path.dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('组件安装路径不能是符号链接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function installFile(root, filename, data) {
  await writablePath(root, filename);
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
  await rename(temporary, filename);
}

function command(executable, args, cwd, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    const timer = setTimeout(() => { child.kill(); reject(new Error('组件准备超时，请检查本机网络和Python。')); }, timeout);
    child.once('error', () => { clearTimeout(timer); reject(new Error('无法启动已配置的Python。')); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error('Python隔离依赖准备失败，请检查本机环境。')); });
  });
}

export async function setupNativeSender({ root, request = fetch, execute = command, platform = process.platform, componentLock } = {}) {
  if (platform !== 'win32') throw new Error('原生后台发送组件仅支持Windows。');
  root = await realpath(root);
  const lock = componentLock || JSON.parse(await readFile(new URL('./native-component-lock.json', import.meta.url), 'utf8'));
  const directory = path.join(root, '.local-wechat', 'native-sender');
  const component = path.join(directory, 'component');
  await writablePath(root, directory);
  await mkdir(component, { recursive: true, mode: 0o700 });
  let proxy;
  try { proxy = checkedProxy(JSON.parse(await readFile(path.join(root, '.local-wechat/network.json'), 'utf8')).httpsProxy); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('请检查本机网络代理配置。'); }
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  try {
    const records = [...Object.entries(lock.sources).map(([filename, checksum]) => ({ filename, checksum })), { filename: lock.dll.path, checksum: lock.dll.sha256, size: lock.dll.size }];
    for (const record of records) {
      const target = path.join(component, record.filename);
      await writablePath(root, target);
      let data;
      try { data = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!data || sha(data) !== record.checksum) {
        // 复用上次用户授权验证过的本机文件，仍逐字节核对固定版本，绝不复制运行配置或聊天。
        const prior = path.join(root, '.local-wechat/native-background-verification', `helper-${lock.commit}`, record.filename);
        try { const candidate = await readFile(prior); if (sha(candidate) === record.checksum) data = candidate; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (!data || sha(data) !== record.checksum) {
        const response = await request(`https://raw.githubusercontent.com/${lock.repository}/${lock.commit}/${record.filename}`, { redirect: 'error', signal: AbortSignal.timeout(20_000), ...(dispatcher ? { dispatcher } : {}) });
        if (!response.ok || Number(response.headers.get('content-length')) > 2_000_000) throw new Error('固定版本组件下载失败。');
        const chunks = []; let length = 0;
        for await (const chunk of response.body) { length += chunk.length; if (length > 2_000_000) throw new Error('组件文件超过预期大小。'); chunks.push(chunk); }
        data = Buffer.concat(chunks);
      }
      if (sha(data) !== record.checksum || record.size !== undefined && data.length !== record.size) throw new Error('组件文件指纹不一致，未运行。');
      if (!record.filename.endsWith('.dll')) new TextDecoder('utf-8', { fatal: true }).decode(data);
      await installFile(root, target, data);
    }
    const python = path.join(directory, 'venv', 'Scripts', 'python.exe');
    await writablePath(root, python);
    if (!await exists(python)) {
      const config = JSON.parse(await readFile(path.join(root, '.local-wechat/config.json'), 'utf8'));
      if (typeof config.pythonPath !== 'string' || !path.isAbsolute(config.pythonPath)) throw new Error('请先安装本机微信读取组件。');
      await execute(config.pythonPath, ['-m', 'venv', path.dirname(path.dirname(python))], root);
    }
    await execute(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--retries', '1', '--timeout', '20', ...(proxy ? ['--proxy', proxy] : []), `pefile==${lock.pefileVersion}`], root);
    await installFile(root, path.join(directory, 'installed.json'), Buffer.from(JSON.stringify({ version: 1, commit: lock.commit, installedAt: new Date().toISOString() }) + '\n', 'utf8'));
    return { installed: true, componentVersion: lock.commit, setupState: 'ready' };
  } finally { await dispatcher?.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--root') { process.stdout.write(JSON.stringify({ installed: false, message: '请通过本地设置页面安装原生发送组件。' }) + '\n'); process.exitCode = 1; }
  else setupNativeSender({ root: args[1] }).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stdout.write(JSON.stringify({ installed: false, setupState: 'failed', message: error.message }) + '\n'); process.exitCode = 1; });
}
