import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const validId = value => value === 'legacy' || /^acct-[a-f0-9]{20}$/.test(value);
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const within = (root, child) => { const relative = path.relative(root, child); return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const failure = message => Object.assign(new Error(message), { status: 503 });

async function privateJson(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256_000) throw failure('本地账号配置无法安全读取，原数据未被覆盖。');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(filename)));
}

async function atomicJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try { if ((await lstat(filename)).isSymbolicLink()) throw failure('账号配置不能是符号链接。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
}

function validateRegistry(value) {
  if (value?.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !validId(value.activeId) || !(value.dataRoot === null || typeof value.dataRoot === 'string' && path.isAbsolute(value.dataRoot)) || !Array.isArray(value.accounts) || value.accounts.length > 1000 || value.accounts.some(account => !validId(account?.id) || !(account.dbDir === null || typeof account.dbDir === 'string' && path.isAbsolute(account.dbDir) && path.basename(account.dbDir).toLowerCase() === 'db_storage')) || new Set(value.accounts.map(account => account.id)).size !== value.accounts.length || !value.accounts.some(account => account.id === value.activeId)) throw failure('本地账号登记格式异常，请备份后检查，原数据未被覆盖。');
  if (value.pending && (!value.pending.previousConfig || typeof value.pending.previousConfig !== 'object' || Array.isArray(value.pending.previousConfig))) throw failure('账号切换恢复记录异常，原数据未被覆盖。');
  return value;
}

// 只登记目录身份，不读取数据库、聊天、密钥，也不猜测微信当前登录账号。
export async function createAccountRegistry({ root }) {
  const directory = path.join(path.resolve(root), '.local-wechat');
  const filename = path.join(directory, 'accounts.json');
  const configuration = path.join(directory, 'config.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!within(await realpath(root), await realpath(directory))) throw failure('本地账号配置目录越过工作区，未修改任何绑定。');
  let registry;
  try { registry = validateRegistry(await privateJson(filename)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw failure(error.status ? error.message : '本地账号登记无法读取，请备份后检查。');
    let config = {};
    try { config = await privateJson(configuration); } catch (error) { if (error.code !== 'ENOENT') throw failure('本地微信配置无法读取。'); }
    let dbDir = null;
    if (typeof config.dbDir === 'string' && path.isAbsolute(config.dbDir) && path.basename(config.dbDir).toLowerCase() === 'db_storage') {
      try { dbDir = await realpath(config.dbDir); } catch { dbDir = path.resolve(config.dbDir); }
    }
    let dataRoot = dbDir ? path.dirname(path.dirname(dbDir)) : null;
    if (dataRoot) { try { dataRoot = await realpath(dataRoot); } catch { /* 暂不可用的目录仍保留绑定，不改成其他账号。 */ } }
    registry = { version: 1, revision: 1, activeId: 'legacy', dataRoot, accounts: [{ id: 'legacy', dbDir }] };
    await atomicJson(filename, registry);
  }
  // 切换中途退出时恢复旧配置；已保存的旧工作区与队列从不迁移或删除。
  if (registry.pending) {
    await atomicJson(configuration, registry.pending.previousConfig);
    delete registry.pending;
    await atomicJson(filename, registry);
  }

  const active = () => {
    const account = registry.accounts.find(item => item.id === registry.activeId);
    const suffix = account?.dbDir ? path.basename(path.dirname(account.dbDir)).replace(/[\u0000-\u001f]/g, '').slice(-8) : '';
    return { id: registry.activeId, label: suffix ? `微信尾号 ${suffix}${registry.activeId === 'legacy' ? ' · 原有工作区' : ''}` : '原有工作区（尚未绑定微信）', workspaceToken: `${registry.activeId}@${registry.revision}` };
  };

  async function candidates() {
    const result = [];
    if (!registry.dataRoot) return result;
    let dataRoot;
    try { dataRoot = await realpath(registry.dataRoot); } catch { return result; }
    const entries = await readdir(dataRoot, { withFileTypes: true });
    if (entries.length > 2000) throw failure('微信数据根目录项目过多，请人工检查绑定目录。');
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        const dbDir = await realpath(path.join(dataRoot, entry.name, 'db_storage'));
        if (!within(dataRoot, dbDir) || !samePath(path.dirname(path.dirname(dbDir)), dataRoot) || !(await stat(dbDir)).isDirectory()) continue;
        const registered = registry.accounts.find(item => item.dbDir && samePath(item.dbDir, dbDir));
        const id = registered?.id || `acct-${createHash('sha256').update(process.platform === 'win32' ? dbDir.toLowerCase() : dbDir).digest('hex').slice(0, 20)}`;
        result.push({ id, dbDir, label: `微信尾号 ${entry.name.replace(/[\u0000-\u001f]/g, '').slice(-8)}${id === 'legacy' ? ' · 原有工作区' : ''}`, active: id === registry.activeId });
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw failure('部分微信账号目录暂不可用，请检查本机目录权限。'); }
    }
    return result;
  }

  async function list() {
    const available = await candidates();
    return { active: active(), accounts: available.map(({ id, label, active: selected }) => ({ id, label, active: selected })), message: '请选择已登录的微信账号对应目录；目录存在不代表该账号当前已登录。' };
  }

  async function select(accountId) {
    if (!validId(accountId)) throw Object.assign(new Error('请选择列表中的微信账号。'), { status: 400 });
    const candidate = (await candidates()).find(item => item.id === accountId);
    if (!candidate) throw Object.assign(new Error('该账号目录已不可用，请重新检查账号列表。'), { status: 400 });
    const previousConfig = await privateJson(configuration);
    if (accountId === registry.activeId) {
      try { if (samePath(await realpath(previousConfig.dbDir), candidate.dbDir)) return active(); } catch { /* 外部更改或失效绑定通过明确选择恢复。 */ }
    }
    if (registry.revision >= Number.MAX_SAFE_INTEGER - 1) throw failure('账号切换次数已达到限制，请备份后检查。');
    const next = { ...registry, revision: registry.revision + 1, activeId: accountId, accounts: registry.accounts.some(item => item.id === accountId) ? registry.accounts : [...registry.accounts, { id: candidate.id, dbDir: candidate.dbDir }] };
    await atomicJson(filename, { ...registry, pending: { previousConfig } });
    try {
      await atomicJson(configuration, { ...previousConfig, dbDir: candidate.dbDir });
      await atomicJson(filename, next);
      registry = next;
    } catch (error) {
      await atomicJson(configuration, previousConfig);
      await atomicJson(filename, registry);
      throw error;
    }
    return active();
  }

  return { active, list, select, binding: () => registry.accounts.find(item => item.id === registry.activeId)?.dbDir || null };
}
