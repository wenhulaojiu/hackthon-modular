import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { LocalError, guardLocalRequest, readLocalBody, sendLocalJson } from './service.mjs';
import { assertAdditiveEnrollment } from './reply-enrollment.mjs';

const VERSION = '9004a6cd98d32ebdcb50f35f15649e6c964e7720';
const PREFIX = '/__local-wechat/native-sender';
const sending = new Map();
const installations = new Map();
const validScope = value => value === 'legacy' || /^acct-[a-f0-9]{20}$/.test(value);
const validChat = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,127}$/.test(value) && value !== 'filehelper' && !value.startsWith('gh_');
const failure = (status, message, code) => new LocalError(status, message, code);
const unknown = code => ({ status: 'unknown', code, error: '后台发送结果尚未核实，请核对微信；不会自动重发。' });
const rejected = (message, code = 'NATIVE_SEND_BLOCKED') => ({ status: 'failed', code, error: message });
const safeCode = (value, fallback) => typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value) ? value : fallback;

// 子进程退出前始终保留所有权；超量输出也只丢弃，不强杀可能已调度的原生任务。
export function createNativeSenderRunner(spawn = nodeSpawn) {
  return ({ command, args, cwd, input }) => new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    } catch { reject(failure(503, '无法启动后台发送组件。', 'NATIVE_PROCESS_UNAVAILABLE')); return; }
    const output = [];
    let bytes = 0;
    let oversized = false;
    let spawnError = false;
    child.on('error', () => { spawnError = true; });
    child.stdin.on('error', () => {});
    const collect = (chunk, keep) => {
      bytes += chunk.length;
      if (bytes > 128_000) { oversized = true; return; }
      if (keep) output.push(chunk);
    };
    child.stdout.on('data', chunk => collect(chunk, true));
    child.stderr.on('data', chunk => collect(chunk, false));
    child.once('close', (code, signal) => {
      if (spawnError || signal || oversized) { reject(failure(503, '后台发送组件未正常结束。', 'NATIVE_PROCESS_UNVERIFIED')); return; }
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(output)));
        if (!value || Array.isArray(value) || typeof value !== 'object' || code !== 0 && !['failed', 'unknown', 'blocked'].includes(value.status) && value.ready !== false) throw new Error('invalid output');
        resolve(value);
      } catch { reject(failure(503, '后台发送组件返回了无法核验的结果。', 'NATIVE_RESULT_UNVERIFIED')); }
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input) + '\n', 'utf8');
  });
}

export function createNativeSenderService({ root, workspace, currentWorkspace, platform = process.platform, run, setupRun, onDisable, sendTimeoutMs = 90_000, now = Date.now } = {}) {
  if (!root || !workspace || !validScope(workspace.id) || !new RegExp(`^${workspace.id}@[1-9][0-9]*$`).test(workspace.workspaceToken || '')) throw new Error('后台发送服务需要明确的微信工作区。');
  const project = path.resolve(root);
  const directory = path.join(project, '.local-wechat', 'native-sender');
  const scopeDirectory = path.join(directory, 'scopes', workspace.id);
  const filename = path.join(scopeDirectory, 'config.json');
  const helperRoot = path.join(directory, 'component');
  const pythonPath = path.join(directory, 'venv', 'Scripts', 'python.exe');
  const worker = path.join(project, 'scripts', 'local-wechat', 'native-background-sender.py');
  const key = platform === 'win32' ? project.toLowerCase() : project;
  const runner = createNativeSenderRunner();
  const execute = run || ((action, args, input) => runner({ command: pythonPath, args: ['-B', worker, action, ...args], cwd: project, input }));
  const install = setupRun || (args => runner({ command: process.execPath, args: [path.join(project, 'scripts', 'local-wechat', 'native-sender-setup.mjs'), ...args], cwd: project }));
  const args = () => ['--root', project, '--workspace-token', workspace.workspaceToken, '--config', filename];
  if (!installations.has(key)) installations.set(key, { state: 'idle', installed: false });
  const setup = installations.get(key);
  let closed = false;
  let active = false;
  let requestedRunning = false;
  let epoch = 0;
  let control = Promise.resolve();
  let lastProbe = null;
  let probePromise = null;
  let authorizationSignature = null;
  let authorizationConfig = null;
  const inflight = new Set();

  function assertCurrent({ allowClosed = false } = {}) {
    if (!allowClosed && closed) throw failure(503, '后台发送服务已关闭。', 'NATIVE_SERVICE_CLOSED');
    if (typeof currentWorkspace === 'function' && currentWorkspace() !== workspace.workspaceToken) throw failure(409, '微信工作区已切换，请刷新页面。', 'WORKSPACE_CHANGED');
  }
  function checkRequest(request) {
    assertCurrent();
    if (request.headers['x-kexu-workspace'] !== workspace.workspaceToken) throw failure(409, '微信工作区已切换，请刷新页面。', 'WORKSPACE_CHANGED');
  }
  function serial(operation) {
    const result = control.then(operation);
    control = result.catch(() => {});
    return result;
  }
  async function checkDirectory(target, create = false) {
    const base = await realpath(project);
    let current = base;
    for (const part of path.relative(project, target).split(path.sep).filter(Boolean)) {
      if (part === '..') throw failure(503, '后台发送配置目录无效。', 'NATIVE_PATH_UNVERIFIED');
      current = path.join(current, part);
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if (error.code !== 'ENOENT' || !create) throw error;
        await mkdir(current, { mode: 0o700 });
        info = await lstat(current);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw failure(503, '后台发送配置目录无效。', 'NATIVE_PATH_UNVERIFIED');
    }
  }
  async function configFile() {
    try {
      await checkDirectory(scopeDirectory);
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128_000) throw new Error('invalid file');
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(filename)));
      const allowed = ['version', 'enabled', 'running', 'workspaceToken', 'selfWxid', 'pid', 'processCreated', 'allowedChatIds', 'settingsGeneration', 'helperRoot', 'pythonPath'];
      if (!value || Array.isArray(value) || Object.keys(value).some(field => !allowed.includes(field)) || value.version !== 1 || typeof value.enabled !== 'boolean' || typeof value.running !== 'boolean' || !new RegExp(`^${workspace.id}@[1-9][0-9]*$`).test(value.workspaceToken || '') || !Number.isSafeInteger(value.settingsGeneration) || value.settingsGeneration < 1 || value.settingsGeneration >= Number.MAX_SAFE_INTEGER || value.helperRoot !== helperRoot || value.pythonPath !== pythonPath || !Array.isArray(value.allowedChatIds) || value.allowedChatIds.length > 500 || new Set(value.allowedChatIds).size !== value.allowedChatIds.length || value.allowedChatIds.some(chat => !validChat(chat))) throw new Error('invalid configuration');
      if (value.enabled && (!validChat(value.selfWxid) || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.processCreated !== 'string' || !/^[0-9]{1,24}$/.test(value.processCreated))) throw new Error('invalid identity');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw failure(503, '后台发送配置无法核验，请检查本机配置。', 'NATIVE_CONFIG_UNVERIFIED');
    }
  }
  async function save(value) {
    await checkDirectory(scopeDirectory, true);
    try { if ((await lstat(filename)).isSymbolicLink()) throw failure(503, '后台发送配置不能为链接。', 'NATIVE_PATH_UNVERIFIED'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path.join(scopeDirectory, `.config-${randomUUID()}.tmp`);
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
      await file.sync();
      await file.close(); file = null;
      await rename(temporary, filename);
    } finally { await file?.close(); await rm(temporary, { force: true }); }
  }
  async function installedFiles() {
    try {
      await checkDirectory(helperRoot);
      for (const target of [path.join(helperRoot, 'native', 'build_text', 'text_bridge.dll'), pythonPath]) {
        await checkDirectory(path.dirname(target));
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink()) return false;
      }
      return true;
    } catch { return false; }
  }
  function generation(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER - 1) throw failure(503, '后台发送配置版本已达到限制。', 'NATIVE_GENERATION_INVALID');
    return value + 1;
  }
  function selection(config) {
    const selected = config?.settings?.selectedCustomerIds;
    const customers = config?.customers;
    if (config?.settings?.autoEnrollNewContacts !== undefined && typeof config.settings.autoEnrollNewContacts !== 'boolean') throw failure(400, '自动接待新私聊需要为明确的开关。', 'NATIVE_SELECTION_INVALID');
    if (!Array.isArray(selected) || selected.length > 500 || selected.some(id => typeof id !== 'string') || new Set(selected).size !== selected.length || !Array.isArray(customers)) throw failure(400, '请选择最多500位真实私聊客户。', 'NATIVE_SELECTION_INVALID');
    const result = [];
    for (const id of selected) {
      const matches = customers.filter(customer => customer?.id === id);
      if (matches.length !== 1 || !validChat(matches[0].wechatId) || customers.filter(customer => customer?.wechatId === matches[0].wechatId).length !== 1) throw failure(400, '客户必须唯一对应真实微信私聊。', 'NATIVE_SELECTION_INVALID');
      if (matches[0].autoReplyEnabled && !matches[0].humanTakeover) result.push(matches[0].wechatId);
    }
    return result.sort();
  }
  const signature = (config, allowedChatIds) => JSON.stringify([config.settings.enabled === true, allowedChatIds]);
  const probeIdentity = config => config ? JSON.stringify([config.workspaceToken, config.enabled, config.selfWxid, config.pid, config.processCreated]) : null;
  const cachedFor = config => lastProbe?.identity === probeIdentity(config);
  async function inspect(config, { fresh = false } = {}) {
    const identity = probeIdentity(config);
    // 发送时原生模块会暂留进程，不能让状态轮询把它误判为外部桥接。
    if (sending.has(key)) {
      if (fresh) throw failure(409, '后台发送尚未结束，请先核对当前结果。', 'NATIVE_SEND_BUSY');
      return cachedFor(config) ? lastProbe : { ready: false, compatible: false, installed: false };
    }
    const age = lastProbe ? now() - lastProbe.at : Infinity;
    if (!fresh && cachedFor(config) && age >= 0 && age < 10_000) return lastProbe;
    if (probePromise) {
      if (probePromise.identity === identity) return probePromise.promise;
      await probePromise.promise.catch(() => {});
      return inspect(config, { fresh });
    }
    const turn = epoch;
    const pending = Promise.resolve().then(() => execute('inspect', args())).then(result => {
      assertCurrent();
      const checked = { identity, at: now(), ready: result?.ready === true, compatible: result?.compatible === true, installed: result?.installed === true };
      if (turn === epoch) lastProbe = checked;
      return checked;
    }).catch(error => {
      if (turn === epoch) lastProbe = { identity, at: now(), ready: false, compatible: false, installed: true };
      throw error;
    });
    probePromise = { identity, promise: pending };
    try { return await pending; }
    finally { if (probePromise?.promise === pending) probePromise = null; }
  }
  async function status({ probe = false } = {}) {
    assertCurrent();
    let config = null;
    let invalid = false;
    try { config = await configFile(); } catch { invalid = true; }
    const bound = config?.workspaceToken === workspace.workspaceToken;
    let installed = await installedFiles() || setup.installed;
    if (probe && platform === 'win32' && bound && installed && !invalid && setup.state !== 'installing') {
      try { await inspect(config); }
      catch { assertCurrent(); }
    }
    assertCurrent();
    if (cachedFor(config)) installed = lastProbe.installed;
    const enabled = bound && config.enabled === true;
    const compatible = bound && cachedFor(config) && lastProbe.compatible === true;
    const ready = platform === 'win32' && enabled && installed && compatible && lastProbe?.ready === true && setup.state !== 'installing' && !invalid;
    const message = platform !== 'win32' ? '后台发送目前仅支持本机 Windows 微信。' : invalid ? '后台发送配置无法核验，请检查本机配置。' : setup.state === 'installing' ? '正在安装后台发送组件。' : setup.state === 'failed' ? '后台发送组件安装失败，请重试。' : !installed ? '请先安装后台发送组件。' : !bound ? '请启用后台发送并核对当前微信账号。' : !enabled ? '后台发送组件已关闭。' : !ready ? '当前微信账号或版本尚未通过核验，请保持微信登录后重试。' : '后台发送已就绪，无需微信位于前台。';
    return { available: platform === 'win32', installed: !!installed, enabled: !!enabled, ready: !!ready, requiresForeground: false, mode: 'native-background', compatible: !!compatible, message, componentVersion: VERSION, source: 'helper', setupState: setup.state === 'idle' && installed ? 'ready' : setup.state, configured: !!config || invalid, canSend: !!ready };
  }
  async function enable() {
    active = false;
    requestedRunning = false;
    authorizationSignature = null;
    authorizationConfig = null;
    const turn = ++epoch;
    return serial(async () => {
      assertCurrent();
      if (platform !== 'win32' || setup.state === 'installing' || !(await installedFiles() || setup.installed)) throw failure(503, '请先安装可用的 Windows 后台发送组件。', 'NATIVE_NOT_INSTALLED');
      const previous = await configFile();
      const base = { version: 1, enabled: false, running: false, workspaceToken: workspace.workspaceToken, allowedChatIds: [], settingsGeneration: generation(previous?.settingsGeneration || 1), helperRoot, pythonPath };
      await save(base);
      const result = await execute('bind', args());
      assertCurrent();
      if (turn !== epoch || result?.compatible !== true || result?.installed !== true || result?.ready !== true || !Number.isSafeInteger(result.pid) || result.pid <= 0 || !validChat(result.selfWxid) || typeof result.processCreated !== 'string' || !/^[0-9]{1,24}$/.test(result.processCreated)) throw failure(409, '当前登录账号尚未通过后台发送绑定。', 'NATIVE_BIND_UNVERIFIED');
      const bound = { ...base, enabled: true, pid: result.pid, selfWxid: result.selfWxid, processCreated: result.processCreated, settingsGeneration: generation(base.settingsGeneration) };
      await save(bound);
      if (turn !== epoch) throw failure(409, '后台发送设置已变化，请重新操作。', 'NATIVE_CONFIGURATION_CHANGED');
      lastProbe = { identity: probeIdentity(bound), at: now(), ready: true, compatible: true, installed: true };
      return status();
    });
  }
  function syncConfig(config) {
    config = structuredClone(config);
    let allowedChatIds;
    try { allowedChatIds = selection(config); }
    catch (error) { return Promise.reject(error); }
    const nextSignature = signature(config, allowedChatIds);
    // 读取轮询也会同步相同配置；没有授权变化时不能中断正在回读的发送。
    if (authorizationSignature === nextSignature) return serial(async () => { assertCurrent(); authorizationConfig = config; });
    const previousSignature = authorizationSignature;
    authorizationSignature = nextSignature;
    if (config.settings.enabled !== true) requestedRunning = false;
    const keepRunning = requestedRunning;
    active = false;
    const turn = ++epoch;
    return serial(async () => {
      assertCurrent();
      const current = await configFile();
      if (!current) return;
      if (current.workspaceToken !== workspace.workspaceToken) throw failure(409, '后台发送账号绑定已失效，请重新启用。', 'WORKSPACE_CHANGED');
      const running = turn === epoch && keepRunning && current.enabled && config.settings.enabled === true && (allowedChatIds.length > 0 || config.settings.autoEnrollNewContacts !== false);
      const changed = previousSignature !== null && previousSignature !== nextSignature || current.running !== running || JSON.stringify([...current.allowedChatIds].sort()) !== JSON.stringify(allowedChatIds);
      if (changed) await save({ ...current, allowedChatIds, running, settingsGeneration: generation(current.settingsGeneration) });
      assertCurrent();
      if (turn === epoch) { active = !!running; authorizationConfig = config; }
    });
  }
  function start(config) {
    config = structuredClone(config);
    active = false;
    requestedRunning = false;
    let allowedChatIds;
    try { allowedChatIds = selection(config); }
    catch (error) { return Promise.reject(error); }
    authorizationSignature = signature(config, allowedChatIds);
    const turn = ++epoch;
    return serial(async () => {
      assertCurrent();
      if (!config.settings.enabled || !allowedChatIds.length && config.settings.autoEnrollNewContacts === false) throw failure(400, '请先启用接待规则并选择客户，或开启自动接待新私聊。', 'NATIVE_SELECTION_EMPTY');
      const current = await configFile();
      if (!current?.enabled || current.workspaceToken !== workspace.workspaceToken || platform !== 'win32') throw failure(409, '请先启用并核验后台发送组件。', 'NATIVE_NOT_ENABLED');
      const checked = await inspect(current, { fresh: true });
      if (!checked.ready || !checked.compatible || !checked.installed || turn !== epoch) throw failure(409, '后台发送组件尚未就绪。', 'NATIVE_NOT_READY');
      await save({ ...current, allowedChatIds, running: true, settingsGeneration: generation(current.settingsGeneration) });
      assertCurrent();
      if (turn !== epoch) throw failure(409, '后台发送启动已被暂停。', 'NATIVE_CONFIGURATION_CHANGED');
      active = true;
      requestedRunning = true;
      authorizationConfig = config;
    });
  }
  function enrollCustomers(config) {
    const candidate = structuredClone(config);
    const turn = epoch;
    return serial(async () => {
      assertCurrent();
      if (!active || !requestedRunning || turn !== epoch) throw failure(409, '本机接待已暂停，不能自动追加客户。', 'NATIVE_ENROLLMENT_PAUSED');
      // 等已经进入原生调用的任务安全回读结束，再修改授权版本。
      await sending.get(key)?.catch(() => {});
      assertCurrent();
      if (!active || !requestedRunning || turn !== epoch) throw failure(409, '客户接纳期间接待已暂停。', 'NATIVE_ENROLLMENT_PAUSED');
      try { assertAdditiveEnrollment(authorizationConfig, candidate); }
      catch { throw failure(409, '新客户只能追加到未变化的接待规则中。', 'NATIVE_ENROLLMENT_INVALID'); }
      const allowedChatIds = selection(candidate);
      const current = await configFile();
      if (!current?.enabled || !current.running || current.workspaceToken !== workspace.workspaceToken || turn !== epoch) throw failure(409, '后台发送的账号或运行状态已变化。', 'NATIVE_ENROLLMENT_PAUSED');
      if (JSON.stringify(current.allowedChatIds) !== JSON.stringify(allowedChatIds)) await save({ ...current, allowedChatIds, settingsGeneration: generation(current.settingsGeneration) });
      assertCurrent();
      if (!active || turn !== epoch) throw failure(409, '客户接纳期间接待已暂停。', 'NATIVE_ENROLLMENT_PAUSED');
      authorizationSignature = signature(candidate, allowedChatIds);
      authorizationConfig = candidate;
    });
  }
  function stop({ disable = false } = {}) {
    active = false;
    requestedRunning = false;
    ++epoch;
    return serial(async () => {
      const current = await configFile();
      // 旧服务只失效自己的版本，不覆盖换号后新服务已写入的配置。
      if (current?.workspaceToken === workspace.workspaceToken) await save({ ...current, running: false, ...(disable ? { enabled: false } : {}), settingsGeneration: generation(current.settingsGeneration) });
    });
  }
  const pause = () => stop();
  async function disable() {
    await stop({ disable: true });
    await onDisable?.();
    assertCurrent();
    return status();
  }
  async function send({ chatId, text, idempotencyKey } = {}) {
    let reservation;
    try {
      assertCurrent();
      if (!active) return rejected('本地接待已暂停。');
      if (!validChat(chatId) || typeof text !== 'string' || !text.isWellFormed() || !Buffer.byteLength(text, 'utf8') || Buffer.byteLength(text, 'utf8') > 1023 || text.includes('\0') || typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 200 || /[\u0000-\u001f\u007f]/.test(idempotencyKey)) return rejected('后台发送请求格式不正确。', 'NATIVE_PAYLOAD_INVALID');
      if (sending.has(key)) return rejected('另一条后台发送尚未结束，请先核对其结果。', 'NATIVE_SEND_BUSY');
      // 配置读取与登记发送保留在同一控制序列中，追加客户不会穿过预派发窗口。
      reservation = await serial(async () => {
        assertCurrent();
        const current = await configFile();
        assertCurrent();
        if (!active || !current?.enabled || !current.running || current.workspaceToken !== workspace.workspaceToken || !current.allowedChatIds.includes(chatId) || chatId === current.selfWxid) return rejected('该客户未启用接待或当前接待已暂停。');
        if (sending.has(key)) return rejected('另一条后台发送尚未结束，请先核对其结果。', 'NATIVE_SEND_BUSY');
        const digest = createHash('sha256').update(text, 'utf8').digest('hex');
        const generationAtStart = current.settingsGeneration;
        const task = Promise.resolve().then(async () => {
          // 已开始的只读预检先安全结束，之后的状态请求会被发送锁挡住。
          if (probePromise) await probePromise.promise.catch(() => {});
          assertCurrent();
          if (!active) return rejected('本地接待已暂停。');
          const result = await execute('send', args(), { workspaceToken: workspace.workspaceToken, chatId, text, idempotencyKey, generation: generationAtStart });
          assertCurrent();
          if (result?.status === 'failed') return rejected('后台发送组件拒绝了本次发送。', safeCode(result.code, 'NATIVE_SEND_REJECTED'));
          if (result?.status === 'sent' && result.chatId === chatId && result.workspaceToken === workspace.workspaceToken && result.readback === true && result.textSha256 === digest && typeof result.messageId === 'string' && /^[0-9]{1,40}$/.test(result.messageId) && /[1-9]/.test(result.messageId)) return { status: 'sent', messageId: result.messageId, chatId, textSha256: digest, readback: true, workspaceToken: workspace.workspaceToken };
          return unknown(safeCode(result?.code, 'NATIVE_RECEIPT_UNVERIFIED'));
        }).catch(error => unknown(safeCode(error.code, 'NATIVE_DISPATCH_UNKNOWN')));
        sending.set(key, task);
        inflight.add(task);
        void task.finally(() => { if (sending.get(key) === task) sending.delete(key); inflight.delete(task); });
        return { task };
      });
    } catch (error) { return rejected(error.status ? error.message : '后台发送尚未就绪。', safeCode(error.code, 'NATIVE_SEND_BLOCKED')); }
    if (!reservation.task) return reservation;
    let timer;
    const timed = new Promise(resolve => { timer = setTimeout(() => resolve(unknown('NATIVE_WAIT_TIMEOUT')), sendTimeoutMs); timer.unref?.(); });
    try { return await Promise.race([reservation.task, timed]); }
    finally { clearTimeout(timer); }
  }
  async function setupComponent() {
    assertCurrent();
    if (platform !== 'win32') throw failure(503, '后台发送目前仅支持 Windows。', 'WINDOWS_REQUIRED');
    if (setup.state === 'installing') return status();
    const current = await configFile();
    if (current?.enabled || sending.has(key)) throw failure(409, '请先关闭后台发送并等待当前发送结束，再安装组件。', 'NATIVE_COMPONENT_BUSY');
    setup.state = 'installing';
    const installing = await status();
    setup.promise = Promise.resolve().then(() => install(['--root', project])).then(result => {
      if (result?.installed !== true && result?.ready !== true) throw new Error('setup not verified');
      setup.installed = true; setup.state = 'ready'; lastProbe = null;
    }).catch(() => { setup.state = 'failed'; setup.installed = false; });
    return installing;
  }
  async function handle(request, response) {
    const pathname = String(request.url || '').split('?')[0];
    if (pathname !== PREFIX && !pathname.startsWith(PREFIX + '/')) return false;
    try {
      const write = request.method === 'POST';
      guardLocalRequest(request, '/native-sender', write);
      checkRequest(request);
      const route = pathname.slice(PREFIX.length);
      if (request.method === 'GET' && route === '/status') sendLocalJson(response, 200, await status({ probe: true }));
      else if (write && ['/setup', '/enable', '/disable'].includes(route)) {
        const input = await readLocalBody(request, 1024);
        checkRequest(request);
        if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length) throw failure(400, '此操作不接收额外参数。', 'NATIVE_BODY_INVALID');
        const result = route === '/setup' ? await setupComponent() : route === '/enable' ? await enable() : await disable();
        sendLocalJson(response, route === '/setup' && result.setupState === 'installing' ? 202 : 200, result);
      } else throw failure(405, '该后台发送接口不支持此操作。', 'NATIVE_ROUTE_INVALID');
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendLocalJson(response, Number.isInteger(error.status) ? error.status : 503, { error: error.status ? error.message : '后台发送组件暂不可用，请检查本机配置。', ...(error.code ? { code: safeCode(error.code, 'NATIVE_SERVICE_UNAVAILABLE') } : {}) });
    }
    return true;
  }
  async function close() {
    if (closed) { await Promise.allSettled([...inflight]); return; }
    closed = true;
    try { await stop(); }
    finally { await Promise.allSettled([...inflight]); }
  }
  return { status, start, syncConfig, enrollCustomers, pause, send, handle, close };
}
