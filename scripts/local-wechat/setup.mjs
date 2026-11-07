import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, access, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const localRoot = path.join(projectRoot, '.local-wechat');
export const upstreamCommit = 'd82f241e88e9357dc3a553c958ef516605bb85be';

// 只排除商店启动占位程序，不能误伤包目录内已验证可用的真实 Python。
export function isPythonAlias(filename) {
  return /[\\/]WindowsApps[\\/]python(?:3(?:\.\d+)?)?\.exe$/i.test(filename);
}

export function ensureRuntime() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('请先安装 Node.js 24 或更新版本，再重新运行。');
  if (process.platform !== 'win32') throw new Error('本地微信提取组件当前仅支持 Windows。');
}

export async function exists(filename) {
  try { await access(filename); return true; } catch { return false; }
}

export async function readJson(filename, fallback) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`配置文件格式无效：${path.basename(filename)}`); }
}

export async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(temporary, filename);
}

export async function createLogger(name) {
  await mkdir(path.join(localRoot, 'logs'), { recursive: true });
  const filename = path.join(localRoot, 'logs', `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const secrets = new Set(Object.entries(process.env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value?.length >= 8).map(([, value]) => value));
  try {
    const envText = await readFile(path.join(projectRoot, '.dev.vars'), 'utf8');
    for (const line of envText.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
      if (match && match[2].length >= 8) secrets.add(match[2].replace(/^['"]|['"]$/g, ''));
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const redact = value => {
    let text = String(value);
    for (const secret of secrets) text = text.split(secret).join('[已隐藏]');
    return text;
  };
  let chain = Promise.resolve();
  const log = value => { chain = chain.then(() => appendFile(filename, redact(value) + '\n', 'utf8')); return chain; };
  return { filename, log, redact, addSecret: value => { if (value?.length >= 8) secrets.add(value); } };
}

export async function runLogged(executable, args, logger, options = {}) {
  await logger.log(`运行：${path.basename(executable)} ${args.map(arg => /KEY|TOKEN|SECRET/i.test(arg) ? '[敏感参数]' : arg).join(' ')}`);
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: projectRoot, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...options.env } });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    const buffers = { stdout: '', stderr: '' };
    const collect = (stream, chunk) => {
      const text = chunk.toString('utf8');
      if (stream === 'stdout') stdout = (stdout + text).slice(-5_000_000);
      else stderr = (stderr + text).slice(-100_000);
      buffers[stream] += text;
      const lines = buffers[stream].split(/\r?\n/);
      buffers[stream] = lines.pop() || '';
      for (const line of lines) void logger.log(line);
    };
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    const timer = options.timeout ? setTimeout(() => { child.kill(); reject(new Error('准备步骤超时，已停止当前子进程，请查看日志。')); }, options.timeout) : null;
    child.once('error', error => { if (timer) clearTimeout(timer); reject(error); });
    child.once('close', code => {
      if (timer) clearTimeout(timer);
      for (const text of Object.values(buffers)) if (text) void logger.log(text);
      if (code !== 0) reject(new Error(`${path.basename(executable)} 执行失败（退出码${code ?? '未知'}），请查看日志。`));
      else resolve({ stdout, stderr });
    });
  });
}

async function probePython(executable, prefix = []) {
  if (path.isAbsolute(executable) && isPythonAlias(executable)) return null;
  const source = 'import json,sys,sqlite3,struct; print(json.dumps({"path":sys.executable,"major":sys.version_info.major,"minor":sys.version_info.minor,"deserialize":hasattr(sqlite3.Connection,"deserialize"),"bits":struct.calcsize("P")*8}))';
  return await new Promise(resolve => {
    const child = spawn(executable, [...prefix, '-c', source], { cwd: projectRoot, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    child.stdout.setEncoding('utf8');
    let output = '';
    const timeout = setTimeout(() => { child.kill(); resolve(null); }, 10_000);
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
    child.once('error', () => { clearTimeout(timeout); resolve(null); });
    child.once('close', code => {
      clearTimeout(timeout);
      try {
        const value = JSON.parse(output.trim());
        if (code === 0 && value.major === 3 && value.minor >= 11 && value.deserialize && value.bits === 64 && path.isAbsolute(value.path) && !isPythonAlias(value.path)) resolve(value.path);
        else resolve(null);
      } catch { resolve(null); }
    });
  });
}

async function findPython() {
  if (process.env.KEXU_PYTHON) {
    if (!path.isAbsolute(process.env.KEXU_PYTHON)) throw new Error('KEXU_PYTHON 必须是现有 Python 解释器的绝对路径。');
    const explicit = await probePython(process.env.KEXU_PYTHON);
    if (!explicit) throw new Error('KEXU_PYTHON 不可用：需要64位 Python 3.11+，并支持 sqlite3.deserialize。');
    return explicit;
  }
  const launcher = await probePython('py.exe', ['-3']);
  if (launcher) return launcher;
  const where = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
  const candidates = await new Promise(resolve => {
    const child = spawn(where, ['python.exe', 'python3.exe'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.setEncoding('utf8');
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
    child.once('error', () => resolve([]));
    child.once('close', () => resolve(output.split(/\r?\n/).map(value => value.trim()).filter(value => path.isAbsolute(value) && !isPythonAlias(value))));
  });
  for (const candidate of candidates) { const valid = await probePython(candidate); if (valid) return valid; }
  throw new Error('未找到可用的64位 Python 3.11+。请自行安装官方 Python 后重试，或通过 KEXU_PYTHON 指定解释器绝对路径。安装器不会安装系统 Python、自动提权或关闭防护。');
}

async function validateExporter(root) {
  if (!path.isAbsolute(root)) throw new Error('KEXU_EXPORTER_ROOT 必须是工具源码的绝对路径。');
  for (const relative of ['scripts/export_wechat.py', 'requirements.txt', 'SKILL.md']) {
    if (!(await stat(path.join(root, relative))).isFile()) throw new Error('微信导出工具目录不完整，请指定包含 SKILL.md 的源码根目录。');
  }
  return root;
}

export function archiveExtractionCode() {
  return `import json,re,shutil,stat,sys,zipfile
from pathlib import Path,PurePosixPath
archive,folder,expected=sys.argv[1:]
root=Path(folder).resolve()
seen=set()
total=0
count=0
with zipfile.ZipFile(archive) as source:
 entries=source.infolist()
 if len(entries)>2000: raise ValueError('Archive contains too many entries')
 for entry in entries:
  name=entry.filename.replace('\\\\','/')
  parts=PurePosixPath(name).parts
  if not parts or parts[0]!=expected or name.startswith('/') or any(p in ('.','..') or ':' in p or p.endswith((' ','.')) for p in parts): raise ValueError('Unsafe archive path')
  if any(re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\..*)?',p) for p in parts): raise ValueError('Reserved Windows filename')
  if stat.S_ISLNK(entry.external_attr>>16): raise ValueError('Archive symlinks are not allowed')
  if entry.file_size>20000000: raise ValueError('Archive entry is too large')
  total+=entry.file_size
  if total>100000000: raise ValueError('Archive is too large')
  relative=parts[1:]
  if not relative: continue
  identity='/'.join(relative).casefold()
  if identity in seen: raise ValueError('Duplicate archive entry')
  seen.add(identity)
  target=root.joinpath(*relative).resolve()
  if not target.is_relative_to(root): raise ValueError('Archive path escaped destination')
  if entry.is_dir(): target.mkdir(parents=True,exist_ok=True)
  else:
   target.parent.mkdir(parents=True,exist_ok=True)
   with source.open(entry) as data,target.open('xb') as output: shutil.copyfileobj(data,output)
   count+=1
print(json.dumps({'source_files':count,'safe_unpack':True}))`;
}

async function prepareExporter(logger, previous, basePython) {
  if (process.env.KEXU_EXPORTER_ROOT) return await validateExporter(process.env.KEXU_EXPORTER_ROOT);
  if (previous?.exporterRoot && await exists(previous.exporterRoot)) return await validateExporter(previous.exporterRoot);
  const toolsRoot = path.join(localRoot, 'tools');
  const destination = path.join(toolsRoot, `wechat-chat-export-${upstreamCommit}`);
  await mkdir(toolsRoot, { recursive: true });
  if (await exists(destination)) {
    const installed = await readJson(path.join(localRoot, 'installed-tool.json'), null);
    if (installed?.commit !== upstreamCommit || installed.exporterRoot !== destination) throw new Error('工具目标目录已有未登记内容，安装器不会覆盖。请显式设置 KEXU_EXPORTER_ROOT 复用已审核的源码，或先自行移走该目录。');
    return await validateExporter(destination);
  }
  console.log('正在下载指定版本的公开源码，不读取微信……');
  const address = `https://codeload.github.com/yeklongdi/wechat-chat-export/zip/${upstreamCommit}`;
  const response = await fetch(address, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
  if (!response.ok) throw new Error(`工具源码下载失败（HTTP ${response.status}）。请检查网络后重试。`);
  if (Number(response.headers.get('content-length')) > 20_000_000) throw new Error('工具源码包超过预期大小，已停止安装。');
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 20_000_000) throw new Error('工具源码包超过预期大小，已停止安装。');
    chunks.push(chunk);
  }
  const archive = path.join(localRoot, `tool-source-${randomUUID()}.zip`);
  const staging = path.join(toolsRoot, `.install-${randomUUID()}`);
  await writeFile(archive, Buffer.concat(chunks), { flag: 'wx' });
  await mkdir(staging);
  const expected = `wechat-chat-export-${upstreamCommit}`;
  const unpack = archiveExtractionCode();
  await runLogged(basePython, ['-c', unpack, archive, staging, expected], logger);
  await validateExporter(staging);
  await rename(staging, destination);
  await writeJsonAtomic(path.join(localRoot, 'installed-tool.json'), { commit: upstreamCommit, exporterRoot: destination, installedAt: new Date().toISOString() });
  return destination;
}

async function main() {
  ensureRuntime();
  const logger = await createLogger('setup');
  try {
    const previous = await readJson(path.join(localRoot, 'config.json'), null);
    const basePython = await findPython();
    const exporterRoot = await prepareExporter(logger, previous, basePython);
    const environment = path.join(localRoot, 'venv');
    const pythonPath = path.join(environment, 'Scripts', 'python.exe');
    if (await exists(environment)) {
      if (!await exists(path.join(environment, 'pyvenv.cfg')) || !await probePython(pythonPath)) throw new Error('本地组件环境目录已有不可复用的内容，安装器不会覆盖。请检查 .local-wechat/venv。');
    } else {
      console.log('正在创建项目独立 Python 环境……');
      await runLogged(basePython, ['-m', 'venv', environment], logger);
    }
    console.log('正在安装锁定版本依赖，不执行微信扫描或导出……');
    await runLogged(pythonPath, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--only-binary=:all:', '-r', path.join(exporterRoot, 'requirements.txt')], logger);
    const config = { exporterRoot, pythonPath };
    const selectedDb = process.env.KEXU_WECHAT_DB_DIR || previous?.dbDir;
    if (selectedDb) {
      if (!path.isAbsolute(selectedDb) || path.basename(selectedDb).toLowerCase() !== 'db_storage' || !(await stat(selectedDb)).isDirectory()) throw new Error('KEXU_WECHAT_DB_DIR 需要指向本人已选账号的 db_storage 绝对目录。');
      config.dbDir = path.resolve(selectedDb);
    }
    await writeJsonAtomic(path.join(localRoot, 'config.json'), config);
    await logger.log('安装完成。只准备代码与依赖；未读取微信、未生成数据库密钥。');
    console.log('微信提取组件已准备好。请启动客序，并在页面中选择好友和范围后提取。');
    console.log(`安装日志：${logger.filename}`);
  } catch (error) {
    await logger.log(error?.stack || error);
    console.error(logger.redact(error?.message || '组件安装失败。'));
    console.error(`安装日志：${logger.filename}`);
    process.exitCode = 1;
  }
}

// 比较真实文件路径，兼容Windows桌面别名及目录联接；导入模块时不执行安装。
export async function isDirectSetupInvocation(entry = process.argv[1], moduleUrl = import.meta.url) {
  if (!entry) return false;
  try {
    const [entryPath, modulePath] = await Promise.all([realpath(path.resolve(entry)), realpath(fileURLToPath(moduleUrl))]);
    return process.platform === 'win32' ? entryPath.toLowerCase() === modulePath.toLowerCase() : entryPath === modulePath;
  } catch { return false; }
}

if (await isDirectSetupInvocation()) {
  main().catch(error => { console.error(error.message || '无法启动安装器。'); process.exitCode = 1; });
}
