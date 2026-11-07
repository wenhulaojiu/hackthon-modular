import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger, ensureRuntime, exists, localRoot, projectRoot, readJson, runLogged, writeJsonAtomic } from './setup.mjs';

const port = 5173;
const origin = `http://127.0.0.1:${port}`;
const token = randomUUID();
const lockFile = path.join(localRoot, 'launch.lock');
let ownedLock = false;
let server = null;
let logger;

async function acquireLock() {
  await mkdir(localRoot, { recursive: true });
  if (await exists(lockFile)) {
    const previous = await readJson(lockFile, null);
    if (!previous?.pid) throw new Error('启动锁格式异常，请确认没有客序正在运行后，自行检查 .local-wechat/launch.lock。');
    let alive = true;
    try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('已有客序启动程序正在运行。请返回原启动窗口，不会自动连接或关闭其他进程。');
    await unlink(lockFile);
  }
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }), { encoding: 'utf8', flag: 'wx' });
  ownedLock = true;
}

async function releaseLock() {
  if (!ownedLock) return;
  try {
    const current = await readJson(lockFile, null);
    if (current?.token === token) await unlink(lockFile);
  } catch { /* 只清理由本次启动创建且身份一致的锁。 */ }
  ownedLock = false;
}

async function assertPortFree() {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => reject(new Error(error.code === 'EADDRINUSE' ? `端口${port}已被占用，客序不会连接未知程序。请关闭占用该端口的程序后重试。` : '无法检查本地监听端口。')));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(resolve));
  });
}

async function npmCli() {
  const candidates = [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  if (process.env.npm_execpath?.endsWith('npm-cli.js')) candidates.push(process.env.npm_execpath);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error('当前 Node.js 没有可用的 npm。请安装包含 npm 的官方 Node.js 24 后重试。');
}

async function prepareKey() {
  const filename = path.join(projectRoot, '.dev.vars');
  if (!await exists(filename)) {
    const value = randomBytes(32).toString('base64');
    logger.addSecret(value);
    await writeFile(filename, `APP_ENCRYPTION_KEY=${value}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await logger.log('已新建本地应用加密配置，密钥未输出。');
    return;
  }
  const content = await readFile(filename, 'utf8');
  const match = content.match(/^\s*APP_ENCRYPTION_KEY\s*=\s*([^\r\n]+)\s*$/m);
  const value = match?.[1].trim().replace(/^['"]|['"]$/g, '');
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || Buffer.from(value, 'base64').length !== 32) throw new Error('已有 .dev.vars 缺少有效的32字节 Base64 APP_ENCRYPTION_KEY。为保护已保存密钥，启动器不会覆盖该文件，请按本地文档检查。');
  logger.addSecret(value);
}

const normalizedSql = value => value.replace(/;\s*$/, '').replace(/\bIF\s+NOT\s+EXISTS\b/gi, '').replace(/[`"\[\]]/g, '').replace(/\s+/g, '').toLowerCase();

function createsFrom(sql) {
  return sql.split(/-->\s*statement-breakpoint/).flatMap(statement => {
    const match = statement.trim().match(/^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"\[]?([\w]+)[`"\]]?/i);
    return match ? [{ type: match[1].toLowerCase(), name: match[2], sql: normalizedSql(statement.trim()) }] : [];
  });
}

async function migrateLocalDatabase() {
  const config = path.join(projectRoot, 'dist', 'server', 'wrangler.json');
  const wrangler = path.join(projectRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const runner = ['--import', pathToFileURL(path.join(projectRoot, 'scripts', 'sites-env.mjs')).href, wrangler, 'd1', 'execute', 'DB', '--local', '--config', config, '--persist-to', path.join(projectRoot, '.wrangler', 'state')];
  const markerFile = path.join(localRoot, 'd1-migrations.json');
  const pendingFile = path.join(localRoot, 'migration-pending.json');
  const marker = await readJson(markerFile, { version: 1, migrations: [] });
  if (marker.version !== 1 || !Array.isArray(marker.migrations)) throw new Error('本地迁移记录格式无效，已停止以保护现有数据。');
  const pending = await readJson(pendingFile, null);
  const journal = await readJson(path.join(projectRoot, 'drizzle', 'meta', '_journal.json'), null);
  if (!journal || !Array.isArray(journal.entries)) throw new Error('缺少 Drizzle 迁移目录，无法初始化本地数据。');
  const entries = [...journal.entries].sort((left, right) => left.idx - right.idx);
  if (pending && !entries.some(entry => entry.tag === pending.tag)) throw new Error('存在不属于当前版本的未完成迁移记录，请人工核对。');
  for (const entry of entries) {
    if (!/^\d+_[A-Za-z0-9_]+$/.test(entry.tag)) throw new Error('迁移日志含有不符合预期的文件名。');
    const filename = path.join(projectRoot, 'drizzle', `${entry.tag}.sql`);
    const sql = await readFile(filename, 'utf8');
    const digest = createHash('sha256').update(sql).digest('hex');
    const recorded = marker.migrations.find(migration => migration.tag === entry.tag);
    if (recorded && recorded.sha256 !== digest) throw new Error(`已应用迁移 ${entry.tag} 的文件发生变化。请人工检查，不会重复执行。`);
    const result = await runLogged(process.execPath, [...runner, '--command', "SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%';", '--json'], logger);
    let payload;
    try { payload = JSON.parse(result.stdout.trim()); } catch { throw new Error('本地数据库检查没有返回可解析结果，未执行迁移。'); }
    const rows = Array.isArray(payload) ? payload.flatMap(item => item.results || []) : payload.results || [];
    const creates = createsFrom(sql);
    const matching = creates.filter(create => rows.some(row => row.name === create.name && row.type === create.type && normalizedSql(row.sql || '') === create.sql));
    const existing = creates.filter(create => rows.some(row => row.name === create.name));
    const alreadyPresent = creates.length > 0 && matching.length === creates.length;
    if (recorded) {
      if (creates.length && existing.length !== creates.length) throw new Error('迁移记录与本地数据库结构不一致，请人工核对，启动器不会覆盖或重复建表。');
      if (pending?.tag === entry.tag && await exists(pendingFile)) await unlink(pendingFile);
      continue;
    }
    if (pending && pending.tag === entry.tag && !alreadyPresent) throw new Error(`迁移 ${entry.tag} 上次未确认完成。请先核对数据库，启动器不会自动重跑。`);
    if (existing.length && !alreadyPresent) throw new Error('发现部分已存在或结构不同的数据表。为避免重复执行危险DDL，已停止初始化，请保留数据并查看日志。');
    if (!alreadyPresent) {
      if (!creates.length && marker.migrations.length === 0 && rows.some(row => !row.name.startsWith('_cf_'))) throw new Error('现有数据库缺少可信迁移记录，不能判定此迁移是否已执行，请人工核对。');
      await writeJsonAtomic(pendingFile, { tag: entry.tag, sha256: digest, startedAt: new Date().toISOString() });
      console.log(`正在初始化本地数据：${entry.tag}……`);
      await runLogged(process.execPath, [...runner, '--file', filename, '--json'], logger);
    } else await logger.log(`已核对现有完整表结构，登记 ${entry.tag}，未重复运行建表语句。`);
    marker.migrations.push({ tag: entry.tag, sha256: digest, appliedAt: new Date().toISOString(), adoptedExisting: alreadyPresent });
    await writeJsonAtomic(markerFile, marker);
    if (await exists(pendingFile)) await unlink(pendingFile);
  }
}

function stopServer() {
  if (!server?.pid || server.exitCode !== null) return;
  const killer = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  const child = spawn(killer, ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
  child.on('error', () => server?.kill());
}

async function launchServer() {
  await assertPortFree();
  const launchId = randomUUID();
  server = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'run-framework.mjs'), 'dev', '--hostname', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: projectRoot, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, KEXU_LOCAL_WECHAT: '1', KEXU_LOCAL_LAUNCH_ID: launchId, NO_COLOR: '1' } });
  let ended = false;
  let failure = '';
  const completion = new Promise(resolve => {
    server.once('error', error => { ended = true; failure = error.message; resolve(1); });
    server.once('exit', code => { ended = true; resolve(code ?? 1); });
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
      for (const line of lines) void logger.log(line);
    });
    stream.on('end', () => { if (buffer) void logger.log(buffer); });
  }
  const deadline = Date.now() + 180_000;
  let ready = false;
  while (!ended && Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/__local-wechat/status`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      if (response.ok) {
        const value = await response.json();
        if (value.app === 'kexu-local' && value.launchId === launchId) { ready = true; break; }
        throw new Error('端口返回了其他程序或其他启动会话的数据，未打开浏览器。');
      }
    } catch (error) {
      if (error.message?.includes('其他程序')) { stopServer(); throw error; }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready || ended) { stopServer(); throw new Error(failure || '本地服务启动失败或未及时就绪，请查看日志。'); }
  console.log(`客序已启动：${origin}/`);
  console.log(process.env.KEXU_NO_BROWSER === '1' ? '请手动打开上述本机地址，保留本窗口；按 Ctrl+C 停止服务。' : '正在打开浏览器。请保留本窗口；按 Ctrl+C 停止本次本地服务。');
  if (process.env.KEXU_NO_BROWSER !== '1') {
    const opener = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', `${origin}/`], { windowsHide: true, shell: false, detached: true, stdio: 'ignore' });
    opener.on('error', () => console.log(`浏览器未自动打开，请手动访问 ${origin}/`));
    opener.unref();
  }
  const code = await completion;
  if (code !== 0) throw new Error('本地服务已退出，请查看启动日志。');
}

async function main() {
  ensureRuntime();
  logger = await createLogger('launch');
  await acquireLock();
  try {
    await assertPortFree();
    await prepareKey();
    const npm = await npmCli();
    if (!await exists(path.join(projectRoot, 'node_modules'))) {
      console.log('首次启动，正在安装项目依赖……');
      await runLogged(process.execPath, [npm, 'ci'], logger);
    }
    if (!await exists(path.join(projectRoot, 'dist', 'server', 'wrangler.json'))) {
      console.log('首次启动，正在构建本地运行配置……');
      await runLogged(process.execPath, [npm, 'run', 'build'], logger);
    }
    await migrateLocalDatabase();
    console.log('正在启动客序本地工作台，不会自动读取微信……');
    await launchServer();
  } finally { await releaseLock(); }
}

process.on('SIGINT', () => { stopServer(); void releaseLock().finally(() => { process.exitCode = 0; }); });
process.on('SIGTERM', () => { stopServer(); void releaseLock().finally(() => { process.exitCode = 0; }); });
main().catch(async error => {
  stopServer();
  if (logger) { await logger.log(error.stack || error); console.error(logger.redact(error.message || '启动失败。')); console.error(`启动日志：${logger.filename}`); }
  else console.error(error.message || '启动失败。');
  await releaseLock();
  process.exitCode = 1;
});
