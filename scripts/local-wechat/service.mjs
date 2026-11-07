import { spawn as nodeSpawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

export const LOCAL_WECHAT_VERSION = "1.0.0";
export const SUPPORTED_UPSTREAM_REVISION = "d82f241e88e9357dc3a553c958ef516605bb85be";
const EXPECTED_EXPORTER_SHA256 = "e98528025a274623702128d822909c01a79ceee5d864084edb1882f6e666554e";
const PREFIX = "/__local-wechat";
const DAY = 86_400_000;
const MAX_BYTES = 1_500_000;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

class LocalError extends Error {
  constructor(status, message, code) { super(message); this.status = status; if (code) this.code = code; }
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function json(value) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)); }
  catch { throw new LocalError(502, "本地提取工具返回了无法验证的数据，未导入聊天。"); }
}

function validDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_@.+-]{1,160}$/.test(value) && !value.startsWith("-") && !value.endsWith("@chatroom") && value !== "filehelper";
}

function strictKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new LocalError(400, "请求参数不正确，请重新选择会话与日期。");
}

function send(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(data));
}

async function body(request, maximumBytes = 8192) {
  if (Number(request.headers["content-length"]) > maximumBytes) { request.resume(); throw new LocalError(413, "请求内容过大。"); }
  const bytes = await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maximumBytes) { settled = true; reject(new LocalError(413, "请求内容过大。")); return; }
      chunks.push(chunk);
    });
    request.once("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    request.once("error", () => { if (!settled) { settled = true; reject(new LocalError(400, "请求读取失败。")); } });
    request.once("aborted", () => { if (!settled) { settled = true; reject(new LocalError(400, "请求已中断。")); } });
  });
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new LocalError(400, "请求必须是有效的 UTF-8 JSON。"); }
}

function guard(request, action, write) {
  if (!LOOPBACK.has(request.socket.remoteAddress)) throw new LocalError(403, "仅允许本机访问提取服务。");
  const host = request.headers.host;
  if (typeof host !== "string" || !/^(?:127\.0\.0\.1|localhost)(?::[1-9]\d{0,4})?$/i.test(host)) throw new LocalError(403, "本地访问地址不正确。");
  let authority;
  try { authority = new URL(`http://${host}`); } catch { throw new LocalError(403, "本地访问地址不正确。"); }
  if (authority.port && Number(authority.port) > 65535) throw new LocalError(403, "本地访问地址不正确。");
  const target = new URL(request.url, authority);
  if (target.origin !== authority.origin) throw new LocalError(403, "不允许代理访问其他地址。");
  const origin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  const custom = request.headers["x-kexu-local"] === "1";
  if ((origin && origin !== authority.origin) || (fetchSite && !["same-origin", "none"].includes(fetchSite))) throw new LocalError(403, "请从本机客序页面发起请求。");
  if (write && (origin !== authority.origin || !custom)) throw new LocalError(403, "本地操作需要同源页面确认。");
  if (!write && action !== "/status" && origin !== authority.origin && !(fetchSite === "same-origin" && custom)) throw new LocalError(403, "请从本机客序页面读取结果。");
  if (write && !String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) throw new LocalError(415, "本地操作需要使用 JSON 格式。");
  return target;
}

// 默认执行器仅启动固定的 Python 与脚本；完成、失败或取消都等待子进程退出。
export function createSpawnRunner(spawn = nodeSpawn) {
  return ({ command, args, cwd, signal, maxOutputBytes = 2_000_000 }) => new Promise((resolve, reject) => {
    if (signal.aborted) { resolve({ code: null, stdout: "", stderr: "", aborted: true }); return; }
    let child;
    try { child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } }); }
    catch { reject(new LocalError(503, "无法启动本地 Python，请重新检查本地环境配置。")); return; }
    const stdout = [];
    const stderr = [];
    let outputSize = 0;
    let tooLarge = false;
    let killTimer;
    const kill = () => {
      clearTimeout(killTimer);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1500);
      killTimer.unref?.();
    };
    signal.addEventListener("abort", kill, { once: true });
    const collect = (target) => (chunk) => {
      outputSize += chunk.length;
      if (outputSize > maxOutputBytes) { if (!tooLarge) { tooLarge = true; kill(); } return; }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", () => {
      signal.removeEventListener("abort", kill);
      clearTimeout(killTimer);
      reject(new LocalError(503, "本地提取进程无法启动，请检查 Python 与提取工具安装。"));
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", kill);
      clearTimeout(killTimer);
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), tooLarge });
    });
    if (signal.aborted) kill();
  });
}

function upstreamError(result) {
  if (result.tooLarge) return new LocalError(413, "本地工具返回内容过多，请缩小搜索或日期范围。");
  let reason = "";
  for (const line of String(result.stderr || "").split(/\r?\n/).reverse()) {
    try { const item = JSON.parse(line); if (typeof item.reason === "string") { reason = item.reason; break; } } catch { /* 原始诊断仅在本机内存中用于归类。 */ }
  }
  if (result.code === 2) return new LocalError(502, "提取工具未能唯一确认会话，请刷新会话列表后重新选择。");
  if (/多个账号/.test(reason)) return new LocalError(502, "检测到多个微信账号，请在本地配置中明确数据库目录后重试。");
  if (/登录|Weixin\.exe|微信.*进程|没有找到.*进程/.test(reason)) return new LocalError(502, "请先打开并登录 Windows 微信，再重试。");
  if (/目录|定位/.test(reason)) return new LocalError(502, "无法定位本机微信数据，请检查本地配置与当前登录账号。");
  if (/材料|密钥|认证|HMAC|quick_check|分片/.test(reason)) return new LocalError(502, "当前微信数据无法通过完整性检查或版本尚不支持，未生成可导入记录。");
  return new LocalError(502, "本机提取失败，未生成可导入记录。请检查微信登录状态与本地提取环境。");
}

export function createLocalWechatService(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const configuration = path.join(root, ".local-wechat", "config.json");
  const jobsDirectory = path.join(root, ".local-wechat", "jobs");
  const runner = options.runner || createSpawnRunner(options.spawn);
  const platform = options.platform || process.platform;
  const timeoutMs = options.timeoutMs || 300_000;
  const cacheMs = options.cacheMs || 5 * 60_000;
  const retentionMs = options.retentionMs || 10 * 60_000;
  const now = options.now || Date.now;
  const jobs = new Map();
  const conversations = new Map();
  let cacheFingerprint = "";
  let active = null;
  let closed = false;
  const workspace = options.workspace;
  function assertCurrent() {
    if (workspace && options.currentWorkspace?.() !== workspace.workspaceToken) throw new LocalError(409, "微信工作区已切换，请刷新页面后重试。", "WORKSPACE_CHANGED");
  }
  function checkWorkspace(request) {
    assertCurrent();
    if (workspace && request.headers["x-kexu-workspace"] !== workspace.workspaceToken) throw new LocalError(409, "微信工作区已切换，请刷新页面后重试。", "WORKSPACE_CHANGED");
  }

  async function inspect() {
    let config;
    try {
      const info = await stat(configuration);
      if (!info.isFile() || info.size > 16384) throw new Error("invalid config");
      config = json(await readFile(configuration));
      strictKeys(config, ["exporterRoot", "pythonPath", "dbDir"]);
      if (![config.exporterRoot, config.pythonPath].every((value) => typeof value === "string" && path.isAbsolute(value) && !value.startsWith("\\\\"))) throw new Error("invalid paths");
      if (config.dbDir !== undefined && (typeof config.dbDir !== "string" || !path.isAbsolute(config.dbDir) || path.basename(config.dbDir).toLowerCase() !== "db_storage")) throw new Error("invalid database path");
    } catch { return { configured: false, exporterReady: false, pythonReady: false, message: "尚未完成本地提取配置，请先运行本地设置程序。" }; }
    const exporter = path.join(config.exporterRoot, "scripts", "export_wechat.py");
    const isFile = async (filename) => { try { return (await stat(filename)).isFile(); } catch { return false; } };
    const [exporterReady, pythonReady] = await Promise.all([isFile(exporter), isFile(config.pythonPath)]);
    let databaseReady = true;
    if (config.dbDir) { try { databaseReady = (await stat(config.dbDir)).isDirectory(); } catch { databaseReady = false; } }
    let bindingMatches = true;
    const expectedDbDir = options.expectedDbDir?.();
    if (expectedDbDir) {
      try {
        const actual = await realpath(config.dbDir);
        bindingMatches = process.platform === 'win32' ? actual.toLowerCase() === expectedDbDir.toLowerCase() : actual === expectedDbDir;
      } catch { bindingMatches = false; }
    }
    const message = platform !== "win32" ? "当前本机读取只支持 Windows 微信 4.x。" : !bindingMatches ? "微信读取目录已在其他程序更改，请在账号列表中重新选择并核对绑定。" : !exporterReady ? "本地提取工具尚未安装完整。" : !pythonReady ? "本地 Python 环境尚未准备好。" : !databaseReady ? "配置的微信数据库目录不可用，请在本地重新选择。" : undefined;
    return { configured: true, exporterReady, pythonReady, message, config, exporter, databaseReady };
  }

  async function ready() {
    assertCurrent();
    if (closed) throw new LocalError(503, "本地提取服务已停止。");
    const state = await inspect();
    if (!state.configured || !state.exporterReady || !state.pythonReady || !state.databaseReady || state.message || platform !== "win32") throw new LocalError(503, state.message || "本地环境尚未准备好。");
    // 状态轮询不读脚本；只有明确读取操作才核对关键脚本指纹。
    const scriptInfo = await stat(state.exporter);
    if (scriptInfo.size > 2_000_000) throw new LocalError(503, "本地导出脚本大小异常，请重新核对安装来源。");
    const script = (await readFile(state.exporter, "utf8")).replace(/\r\n/g, "\n");
    const scriptHash = createHash("sha256").update(script, "utf8").digest("hex");
    return { ...state, scriptVerified: scriptHash === (options.expectedExporterSha256 || EXPECTED_EXPORTER_SHA256), fingerprint: JSON.stringify({ ...state.config, scriptHash }) };
  }

  function claim(job = null) {
    if (active) throw new LocalError(409, "已有本地读取任务正在运行，请等待完成或先取消。");
    const context = { controller: new AbortController(), reason: "", job, done: null };
    active = context;
    return context;
  }

  async function invoke(context, state, args, script = state.exporter) {
    assertCurrent();
    const timer = setTimeout(() => { context.reason = "timeout"; context.controller.abort(); }, timeoutMs);
    timer.unref?.();
    try {
      const result = await runner({ command: state.config.pythonPath, args: ["-B", script, ...args, ...(state.config.dbDir ? ["--db-dir", state.config.dbDir] : [])], cwd: state.config.exporterRoot, signal: context.controller.signal, maxOutputBytes: 2_000_000 });
      assertCurrent();
      if (context.controller.signal.aborted) throw new LocalError(context.reason === "timeout" ? 504 : 499, context.reason === "timeout" ? "本地读取超时，进程已停止，请缩小范围后重试。" : "本地读取已取消。");
      if (result.code !== 0 || result.tooLarge) throw upstreamError(result);
      return json(Buffer.from(String(result.stdout), "utf8"));
    } finally { clearTimeout(timer); }
  }

  async function secureFolder(jobId) {
    await mkdir(jobsDirectory, { recursive: true, mode: 0o700 });
    const rootReal = await realpath(root);
    const baseReal = await realpath(jobsDirectory);
    if (!inside(rootReal, baseReal)) throw new LocalError(503, "临时目录安全检查未通过，未读取微信。");
    const folder = path.join(baseReal, jobId);
    await mkdir(folder, { mode: 0o700 });
    const actual = await realpath(folder);
    if (!inside(baseReal, actual)) throw new LocalError(503, "临时目录安全检查未通过。");
    return actual;
  }

  async function cleanup(job) {
    if (!job.folder) return;
    try {
      const rootReal = await realpath(root);
      const baseReal = await realpath(jobsDirectory);
      const targetReal = await realpath(job.folder);
      if (!inside(rootReal, baseReal) || !inside(baseReal, targetReal) || path.basename(targetReal) !== job.id || (await lstat(job.folder)).isSymbolicLink()) return;
      await rm(targetReal, { recursive: true, force: true });
      job.folder = null;
    } catch { /* 清理失败不会删除任何未经校验的目录。 */ }
  }

  async function safeFile(folder, filename, limit) {
    if (typeof filename !== "string" || !path.isAbsolute(filename)) throw new LocalError(502, "导出文件位置无法验证，未导入聊天。");
    const actual = await realpath(filename);
    if (!inside(folder, actual)) throw new LocalError(502, "导出文件越过本次任务目录，已拒绝读取。");
    const info = await stat(actual);
    if (!info.isFile() || info.size > limit) throw new LocalError(413, "导出内容超过当前容量，请缩小日期范围或减少会话。");
    return readFile(actual);
  }

  async function validateExports(job, result) {
    if (result.status !== "complete") throw new LocalError(502, "本地工具没有报告完整导出，未导入聊天。");
    const summaries = Array.isArray(result.exports) ? result.exports : [result];
    if (summaries.length !== job.ids.length || new Set(summaries.map((item) => item.chat_username)).size !== job.ids.length) throw new LocalError(502, "导出会话数量与所选范围不一致。");
    const output = [];
    let totalBytes = 0;
    let totalMessages = 0;
    for (const item of summaries) {
      if (item.status !== "complete" || !job.ids.includes(item.chat_username)) throw new LocalError(502, "导出包含未选择的会话，已拒绝导入。");
      const [bytes, validationBytes, textBytes] = await Promise.all([safeFile(job.folder, item.json_file, MAX_BYTES), safeFile(job.folder, item.validation_file, 65536), safeFile(job.folder, item.text_file, MAX_BYTES)]);
      totalBytes += bytes.length;
      if (totalBytes > MAX_BYTES) throw new LocalError(413, "聊天总量超过当前容量，请缩小日期范围或减少会话。");
      const validation = json(validationBytes);
      const data = json(bytes);
      const metadata = data?.metadata;
      if (validation.status !== "passed" || validation.json_sha256 !== createHash("sha256").update(bytes).digest("hex") || validation.text_sha256 !== createHash("sha256").update(textBytes).digest("hex") || validation.json_bytes !== bytes.length || validation.text_bytes !== textBytes.length) throw new LocalError(502, "导出文件的完整性验证失败，未导入聊天。");
      if (!metadata || metadata.chat_type !== "private" || metadata.chat_username !== item.chat_username || !Array.isArray(data.messages) || metadata.message_count !== data.messages.length || validation.message_count !== data.messages.length || item.messages !== data.messages.length) throw new LocalError(502, "导出内容与所选好友私聊不一致，未导入聊天。");
      if (Date.parse(metadata.range_start_inclusive) !== job.since || Date.parse(metadata.range_end_exclusive) !== job.until || metadata.source_modified !== false || metadata.keys_saved !== false || metadata.plaintext_database_saved !== false) throw new LocalError(502, "导出时间范围或数据保护标记无法验证。");
      if (data.messages.length > 1500) throw new LocalError(413, "单个好友聊天条数超过当前容量，请缩小日期范围重试。");
      if (data.messages.some((message) => !message || message.chat_username !== item.chat_username || !Number.isInteger(message.timestamp) || message.timestamp * 1000 < job.since || message.timestamp * 1000 >= job.until)) throw new LocalError(502, "聊天包含所选时间范围之外的内容，未导入记录。");
      totalMessages += data.messages.length;
      if (totalMessages > 12000) throw new LocalError(413, "聊天条数超过当前容量，请分批读取。");
      output.push(data);
    }
    return output;
  }

  function publicJob(job) {
    assertCurrent();
    return { status: job.status, progress: job.progress, ...(workspace ? { workspaceToken: workspace.workspaceToken } : {}), ...(job.error ? { error: job.error } : {}), ...(job.status === "complete" ? { exports: job.exports } : {}) };
  }

  async function runJob(job, context, state) {
    try {
      if (context.controller.signal.aborted) throw new LocalError(499, "本地读取已取消。");
      job.status = "running";
      job.progress = "正在读取所选好友私聊，请保持微信已登录…";
      job.folder = await secureFolder(job.id);
      const args = [...job.ids.flatMap((id) => ["--chat", id]), "--start", job.startIso, "--end", job.endIso, "--output-root", job.folder];
      const result = await invoke(context, state, args);
      job.progress = "正在验证所选范围与文件完整性…";
      const exports = await validateExports(job, result);
      if (context.controller.signal.aborted) throw new LocalError(499, "本地读取已取消。");
      job.exports = exports;
      job.status = "complete";
      job.progress = "已完成本机所选范围读取，等待导入。";
    } catch (error) {
      job.status = context.reason && context.reason !== "timeout" ? "cancelled" : "failed";
      job.error = error instanceof LocalError ? error.message : "本地导出或验证失败，未生成可导入记录。";
      job.progress = job.status === "cancelled" ? "任务已取消，未导入任何聊天。" : "读取未完成，请检查提示后重试。";
      delete job.exports;
    } finally {
      await cleanup(job);
      if (active === context) active = null;
      job.finishedAt = now();
      job.expiry = setTimeout(() => { delete job.exports; jobs.delete(job.id); }, retentionMs);
      job.expiry.unref?.();
    }
  }

  async function list(query) {
    const state = await ready();
    const context = claim();
    context.done = (async () => {
      try {
        const result = await invoke(context, state, [`--list-chats=${query}`]);
        if (result.status !== "listed" || !Array.isArray(result.chats) || result.message_bodies_read !== false || result.files_written !== false) throw new LocalError(502, "会话目录返回格式不兼容，未读取聊天正文。");
        if (result.chats.length > 2000) throw new LocalError(413, "会话过多，请输入好友名称关键词后再读取。");
        const fingerprint = state.fingerprint;
        if (cacheFingerprint !== fingerprint) { conversations.clear(); cacheFingerprint = fingerprint; }
        const chats = [];
        const seen = new Set();
        for (const chat of result.chats) {
          if (chat?.type !== "private" || !validId(chat.username) || seen.has(chat.username)) continue;
          seen.add(chat.username);
          const selected = { id: chat.username, name: typeof chat.name === "string" ? chat.name.slice(0, 200) : chat.username, type: "private" };
          chats.push(selected);
          conversations.set(selected.id, now() + cacheMs);
        }
        const warnings = [];
        if (!state.scriptVerified) warnings.push("当前使用本地指定的提取工具，关键脚本未匹配已核验版本；仍会逐项验证导出范围与文件，其他版本的兼容性由实际结果确定。");
        if (result.contacts_available === false) warnings.push("联系人名称信息不完整，部分会话显示为原始会话 ID。");
        if (Number(result.unmapped_table_count) > 0) warnings.push("部分本机会话尚无法识别，未列入可选范围。");
        if (chats.length !== result.chats.length) warnings.push("仅展示可核验的好友私聊，群聊与文件传输助手未列出。");
        assertCurrent();
        return { chats, warnings, ...(workspace ? { workspaceToken: workspace.workspaceToken } : {}) };
      } finally { if (active === context) active = null; }
    })();
    return context.done;
  }

  async function startExport(input) {
    strictKeys(input, ["chatIds", "start", "end"]);
    if (!Array.isArray(input.chatIds) || input.chatIds.length < 1 || input.chatIds.length > 20 || input.chatIds.some((id) => !validId(id)) || new Set(input.chatIds).size !== input.chatIds.length) throw new LocalError(400, "每次请选择 1–20 位不同好友私聊。");
    if (!validDay(input.start) || !validDay(input.end)) throw new LocalError(400, "请选择有效的开始与结束日期。");
    const start = Date.parse(`${input.start}T00:00:00.000Z`);
    const end = Date.parse(`${input.end}T00:00:00.000Z`);
    if (end < start || end - start >= 31 * DAY) throw new LocalError(400, "一次最多读取连续 31 天，结束日期不能早于开始日期。");
    const state = await ready();
    if (cacheFingerprint !== state.fingerprint || input.chatIds.some((id) => (conversations.get(id) || 0) <= now())) throw new LocalError(400, "会话选择已失效，请先重新读取好友列表，再选择准确会话。");
    const job = {
      id: randomUUID(), ids: [...input.chatIds], status: "queued", progress: "已创建本地读取任务…", folder: null,
      startIso: `${input.start}T00:00:00+08:00`, endIso: `${new Date(end + DAY).toISOString().slice(0, 10)}T00:00:00+08:00`,
    };
    job.since = Date.parse(job.startIso);
    job.until = Date.parse(job.endIso);
    const context = claim(job);
    jobs.set(job.id, job);
    context.done = new Promise((resolve) => setImmediate(resolve)).then(() => runJob(job, context, state));
    return { jobId: job.id, ...(workspace ? { workspaceToken: workspace.workspaceToken } : {}) };
  }

  async function handle(request, response) {
    const pathname = String(request.url || "").split("?")[0];
    if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;
    try {
      const action = pathname.slice(PREFIX.length);
      const write = request.method === "POST";
      guard(request, action, write);
      if (action !== "/status") checkWorkspace(request);
      if (closed) throw new LocalError(503, "本地服务已停止。");
      if (request.method === "GET" && action === "/status") {
        const state = await inspect();
        const providerNetwork = options.providerNetwork ? await options.providerNetwork() : undefined;
        assertCurrent();
        send(response, 200, { available: true, app: "kexu-local", launchId: process.env.KEXU_LOCAL_LAUNCH_ID || null, configured: state.configured, exporterReady: state.exporterReady, pythonReady: state.pythonReady, version: LOCAL_WECHAT_VERSION, ...(workspace ? { active: workspace, workspaceToken: workspace.workspaceToken } : {}), ...(providerNetwork ? { providerNetwork } : {}), ...(state.message ? { message: state.message } : {}) });
      } else if (write && action === "/chats") {
        const input = await body(request);
        strictKeys(input, ["query"]);
        if (typeof input.query !== "string" || input.query.length > 100 || /[\u0000-\u001f]/.test(input.query)) throw new LocalError(400, "请输入 100 字以内的好友搜索关键词。");
        send(response, 200, await list(input.query.trim()));
      } else if (write && action === "/exports") {
        send(response, 202, await startExport(await body(request)));
      } else {
        const match = action.match(/^\/jobs\/([0-9a-f-]{36})(\/cancel)?$/);
        const job = match && jobs.get(match[1]);
        if (!job) throw new LocalError(404, "未找到本地任务，可能已过期，请重新读取。");
        if (request.method === "GET" && !match[2]) send(response, 200, publicJob(job));
        else if (write && match[2]) {
          strictKeys(await body(request), []);
          if (active?.job === job && !["complete", "failed", "cancelled"].includes(job.status)) {
            active.reason = "user";
            job.progress = "正在取消任务，等待本地进程退出…";
            active.controller.abort();
          }
          send(response, 200, publicJob(job));
        } else throw new LocalError(405, "该本地接口不支持此操作。");
      }
    } catch (error) {
      if (!response.headersSent && !response.destroyed) send(response, error instanceof LocalError ? error.status : 503, { error: error instanceof LocalError ? error.message : "本地服务暂不可用，请检查配置后重试。", ...(error.code === 'WORKSPACE_CHANGED' ? { code: error.code } : {}) });
    }
    return true;
  }

  async function close() {
    closed = true;
    conversations.clear();
    if (active) { active.reason = "shutdown"; active.controller.abort(); await active.done?.catch(() => {}); }
    for (const job of jobs.values()) { clearTimeout(job.expiry); delete job.exports; await cleanup(job); }
    jobs.clear();
  }

  async function readForReplies(chatIds) {
    // 接待轮询复用会话白名单、范围与完整性校验，不能绕过历史提取保护。
    for (const id of chatIds) {
      if ((conversations.get(id) || 0) <= now()) {
        const result = await list(id);
        if (!result.chats.some(chat => chat.id === id)) throw new LocalError(400, "接待白名单包含无法确认的好友会话。");
      }
    }
    const day = new Date(now() + 8 * 3600_000).toISOString().slice(0, 10);
    const { jobId } = await startExport({ chatIds, start: day, end: day });
    const job = jobs.get(jobId);
    await active?.done;
    try {
      if (job?.status !== "complete" || !job.exports) throw new LocalError(503, job?.error || "新消息读取未完成，接待已暂停。");
      return structuredClone(job.exports);
    } finally {
      clearTimeout(job?.expiry);
      if (job) delete job.exports;
      jobs.delete(jobId);
    }
  }

  // 后台发现复用同一目录验证及串行读取锁，不导出消息正文。
  async function listPrivateChats() { return (await list("")).chats; }

  async function probePrivateChats(startedAt) {
    const state = await ready();
    if (!state.scriptVerified || !state.config.dbDir || !workspace || workspace.id === 'legacy' || !Number.isSafeInteger(startedAt) || startedAt < 0) throw new LocalError(503, "新私聊水位检查需要已核验的固定提取组件与明确绑定的账号。");
    const context = claim();
    context.done = (async () => {
      try {
        const result = await invoke(context, state, ["--exporter-root", state.config.exporterRoot, "--workspace-token", workspace.workspaceToken, "--started-at", String(startedAt), "--until", String(now() + 5000)], path.join(root, 'scripts', 'local-wechat', 'recent-private-probe.py'));
        const current = await ready();
        if (current.fingerprint !== state.fingerprint) throw new LocalError(409, "水位检查期间账号或提取配置已变化，未处理消息。");
        strictKeys(result, ['status', 'workspaceToken', 'chats', 'message_bodies_read', 'files_written']);
        if (result.status !== 'watermarked' || result.workspaceToken !== workspace.workspaceToken || result.message_bodies_read !== false || result.files_written !== false || !Array.isArray(result.chats) || result.chats.length > 2000) throw new LocalError(502, "新私聊水位回执无法核验。");
        const seen = new Set();
        for (const chat of result.chats) {
          strictKeys(chat, ['id', 'name', 'type', 'timestamp', 'watermark', 'inbound', 'lastIncomingAt', 'systemChanged', 'lastSystemAt']);
          if (!validId(chat.id) || seen.has(chat.id) || chat.type !== 'private' || typeof chat.name !== 'string' || !chat.name || chat.name.length > 120 || !Number.isSafeInteger(chat.timestamp) || chat.timestamp < startedAt || chat.timestamp > now() + 5000 || !/^[a-f0-9]{64}$/.test(chat.watermark) || typeof chat.inbound !== 'boolean' || (chat.inbound ? !Number.isSafeInteger(chat.lastIncomingAt) || chat.lastIncomingAt < startedAt || chat.lastIncomingAt > chat.timestamp : chat.lastIncomingAt !== null)) throw new LocalError(502, "新私聊水位范围或方向无法核验。");
          if (typeof chat.systemChanged !== 'boolean' || (chat.systemChanged ? !Number.isSafeInteger(chat.lastSystemAt) || chat.lastSystemAt < startedAt || chat.lastSystemAt > chat.timestamp : chat.lastSystemAt !== null)) throw new LocalError(502, "新私聊系统事件水位无法核验。");
          seen.add(chat.id);
        }
        if (cacheFingerprint !== state.fingerprint) { conversations.clear(); cacheFingerprint = state.fingerprint; }
        for (const chat of result.chats) conversations.set(chat.id, now() + cacheMs);
        return result.chats;
      } finally { if (active === context) active = null; }
    })();
    return context.done;
  }

  return { handle, close, inspect, readForReplies, listPrivateChats, probePrivateChats };
}

// 自动回复接口复用同一回环、同源和请求体保护，不另开公网监听。
export { LocalError, body as readLocalBody, guard as guardLocalRequest, send as sendLocalJson };
