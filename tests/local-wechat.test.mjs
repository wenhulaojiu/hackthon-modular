import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLocalWechatService, createSpawnRunner } from "../scripts/local-wechat/service.mjs";
import localWechatPlugin from "../scripts/local-wechat/vite-plugin.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const listed = () => ({ code: 0, stdout: JSON.stringify({ status: "listed", chats: [{ username: "wxid_friend", name: "好友甲", type: "private" }, { username: "wxid_other", name: "好友乙", type: "private" }, { username: "group@chatroom", name: "群聊", type: "group" }, { username: "filehelper", name: "文件传输助手", type: "private" }], contacts_available: true, unmapped_table_count: 0, message_bodies_read: false, files_written: false }), stderr: "" });

async function fixture(t, runner, options = {}) {
  const temporary = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporary, "kexu-local-test-"));
  const exporterRoot = path.join(root, "installed-exporter");
  const pythonPath = path.join(root, "python.exe");
  await mkdir(path.join(exporterRoot, "scripts"), { recursive: true });
  await writeFile(path.join(exporterRoot, "scripts", "export_wechat.py"), "# 合成测试占位文件，绝不执行。\n", "utf8");
  await writeFile(pythonPath, "合成解释器占位文件，绝不执行。", "utf8");
  await mkdir(path.join(root, ".local-wechat"));
  await writeFile(path.join(root, ".local-wechat", "config.json"), JSON.stringify({ exporterRoot, pythonPath }), "utf8");
  const calls = [];
  const service = createLocalWechatService({ root, platform: "win32", ...options, runner: async (input) => { calls.push(input); return (runner || (async () => listed()))(input); } });
  const server = http.createServer((request, response) => { void service.handle(request, response).then((handled) => { if (!handled) { response.statusCode = 404; response.end(); } }); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (method, route, value, headers = {}) => new Promise((resolve, reject) => {
    const bytes = value === undefined ? undefined : Buffer.from(JSON.stringify(value), "utf8");
    const outgoing = http.request(`${origin}/__local-wechat${route}`, {
      method,
      headers: { "X-Kexu-Local": "1", "Sec-Fetch-Site": "same-origin", ...(method === "POST" ? { Origin: origin, "Content-Type": "application/json" } : {}), ...(bytes ? { "Content-Length": bytes.length } : {}), ...headers },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: response.statusCode, data, headers: response.headers });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(bytes);
  });
  t.after(async () => {
    await service.close();
    await new Promise((resolve) => server.close(resolve));
    const actual = await realpath(root);
    // 递归清理前核对绝对路径，限定在本次合成测试专用目录内。
    assert.equal(path.dirname(actual).toLowerCase(), temporary.toLowerCase());
    assert.ok(path.basename(actual).startsWith("kexu-local-test-"));
    await rm(actual, { recursive: true, force: true });
  });
  return { root, service, calls, request, origin, exporterRoot, pythonPath };
}

async function syntheticExport(input, mutate = () => {}) {
  if (input.args.some((argument) => argument.startsWith("--list-chats="))) return listed();
  const ids = input.args.flatMap((argument, index) => argument === "--chat" ? [input.args[index + 1]] : []);
  const argument = (name) => input.args[input.args.indexOf(name) + 1];
  const outputRoot = argument("--output-root");
  const start = argument("--start");
  const end = argument("--end");
  const exports = [];
  for (const id of ids) {
    const folder = path.join(outputRoot, id);
    await mkdir(folder);
    const data = {
      metadata: { chat: "合成好友", chat_username: id, chat_type: "private", timezone: "Asia/Shanghai", range_start_inclusive: start, range_end_exclusive: end, message_count: 1, source_modified: false, keys_saved: false, plaintext_database_saved: false },
      messages: [{ timestamp: Date.parse(start) / 1000 + 60, time: start, sender: "合成好友", sender_username: id, chat_username: id, content: "只用于自动测试的聊天内容。", type: "文本" }],
    };
    mutate(data, id);
    const bytes = Buffer.from(JSON.stringify(data), "utf8");
    const text = Buffer.from("只用于自动测试的聊天内容。", "utf8");
    const report = { status: "passed", message_count: data.messages.length, json_sha256: digest(bytes), text_sha256: digest(text), json_bytes: bytes.length, text_bytes: text.length };
    const item = { status: "complete", chat_username: id, messages: data.messages.length, range_start: start, range_end_exclusive: end, json_file: path.join(folder, "聊天记录.json"), text_file: path.join(folder, "聊天记录.txt"), validation_file: path.join(folder, "验证报告.json") };
    await writeFile(item.json_file, bytes);
    await writeFile(item.text_file, text);
    await writeFile(item.validation_file, JSON.stringify(report), "utf8");
    exports.push(item);
  }
  return { code: 0, stdout: JSON.stringify(exports.length === 1 ? exports[0] : { status: "complete", exports }), stderr: "" };
}

const selection = { chatIds: ["wxid_friend"], start: "2026-11-01", end: "2026-11-07" };

async function finish(f, id) {
  for (let count = 0; count < 200; count += 1) {
    const response = await f.request("GET", `/jobs/${id}`);
    assert.equal(response.status, 200);
    if (["complete", "failed", "cancelled"].includes(response.data.status)) return response.data;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("合成任务未在预期时间完成");
}

test("status只检查本地配置和路径，不运行上游，也不暴露路径", async (t) => {
  const f = await fixture(t);
  const result = await f.request("GET", "/status", undefined, { "X-Kexu-Local": "", "Sec-Fetch-Site": "" });
  assert.equal(result.status, 200);
  assert.equal(result.data.app, "kexu-local");
  assert.equal(result.data.launchId, process.env.KEXU_LOCAL_LAUNCH_ID || null);
  assert.equal(result.data.available, true);
  assert.equal(result.data.configured, true);
  assert.equal(result.data.exporterReady, true);
  assert.equal(result.data.pythonReady, true);
  assert.equal(f.calls.length, 0);
  assert.ok(!JSON.stringify(result.data).includes(f.root));
  await rm(path.join(f.root, ".local-wechat", "config.json"));
  assert.equal((await f.request("GET", "/status")).data.configured, false);
  assert.equal((await f.request("POST", "/chats", { query: "" })).status, 503);
  assert.equal(f.calls.length, 0);
});

test("同源保护拒绝跨站、伪Host、无确认头及非JSON，GET结果也需同源", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("POST", "/chats", { query: "" }, { Origin: "https://other.example" })).status, 403);
  assert.equal((await f.request("POST", "/chats", { query: "" }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await f.request("POST", "/chats", { query: "" }, { Host: "rebind.example" })).status, 403);
  assert.equal((await f.request("POST", "/chats", { query: "" }, { "X-Kexu-Local": "" })).status, 403);
  assert.equal((await f.request("POST", "/chats", { query: "" }, { Origin: "" })).status, 403);
  assert.equal((await f.request("POST", "/chats", { query: "" }, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await f.request("GET", "/jobs/00000000-0000-0000-0000-000000000000", undefined, { "Sec-Fetch-Site": "", "X-Kexu-Local": "" })).status, 403);
  assert.equal((await f.request("GET", "/status", undefined, { Origin: "null" })).status, 403);
  assert.equal(f.calls.length, 0);
});

test("会话列表仅保留私聊，并把搜索词作为单个固定参数", async (t) => {
  const f = await fixture(t);
  const result = await f.request("POST", "/chats", { query: "--chat=不执行;calc" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.chats.map((chat) => chat.id), ["wxid_friend", "wxid_other"]);
  assert.ok(result.data.chats.every((chat) => chat.type === "private"));
  assert.ok(result.data.warnings.length > 0);
  assert.deepEqual(f.calls[0].args, ["-B", path.join(f.exporterRoot, "scripts", "export_wechat.py"), "--list-chats=--chat=不执行;calc"]);
  assert.equal(f.calls[0].command, f.pythonPath);
  assert.ok(result.data.warnings.some((warning) => warning.includes("未匹配已核验版本")));
});

test("已配置venv解释器优先于基础Python环境变量，未知版本只提示不虚称已验证", async (t) => {
  const original = process.env.KEXU_PYTHON;
  process.env.KEXU_PYTHON = "C:/not-used/base-python.exe";
  t.after(() => { if (original === undefined) delete process.env.KEXU_PYTHON; else process.env.KEXU_PYTHON = original; });
  const f = await fixture(t);
  const response = await f.request("POST", "/chats", { query: "" });
  assert.equal(response.status, 200);
  assert.equal(f.calls[0].command, f.pythonPath);
  assert.ok(response.data.warnings.some((warning) => warning.includes("未匹配已核验版本")));
});

test("导出只允许短期缓存内准确私聊、20人及连续31天，网页不能传路径", async (t) => {
  const f = await fixture(t, syntheticExport);
  assert.equal((await f.request("POST", "/exports", selection)).status, 400);
  await f.request("POST", "/chats", { query: "" });
  for (const input of [
    { ...selection, chatIds: ["unknown"] },
    { ...selection, chatIds: ["group@chatroom"] },
    { ...selection, chatIds: ["filehelper"] },
    { ...selection, chatIds: ["wxid_friend", "wxid_friend"] },
    { ...selection, start: "2026-02-31" },
    { ...selection, start: "2026-10-01", end: "2026-11-01" },
    { ...selection, start: "2026-11-08" },
    { ...selection, outputRoot: "C:/arbitrary" },
    { ...selection, pythonPath: "C:/arbitrary.exe" },
  ]) assert.equal((await f.request("POST", "/exports", input)).status, 400);
  assert.equal((await f.request("POST", "/chats", { query: "", exporterRoot: "C:/arbitrary" })).status, 400);
  assert.equal(f.calls.length, 1);
});

test("完整合成导出校验SHA256与私聊范围，结束日转换为次日零点", async (t) => {
  const f = await fixture(t, syntheticExport);
  await f.request("POST", "/chats", { query: "" });
  const created = await f.request("POST", "/exports", { ...selection, chatIds: ["wxid_friend", "wxid_other"] });
  assert.equal(created.status, 202);
  const completed = await finish(f, created.data.jobId);
  assert.equal(completed.status, "complete");
  assert.equal(typeof completed.progress, "string");
  assert.equal(completed.exports.length, 2);
  assert.ok(completed.exports.every((item) => item.metadata.chat_type === "private"));
  const args = f.calls[1].args;
  assert.equal(args[args.indexOf("--start") + 1], "2026-11-01T00:00:00+08:00");
  assert.equal(args[args.indexOf("--end") + 1], "2026-11-08T00:00:00+08:00");
  assert.ok(!JSON.stringify(completed).includes(f.root));
});

test("群聊、错误会话ID或越界消息时间均导致失败，没有部分成功", async (t) => {
  for (const mutate of [
    (data) => { data.metadata.chat_type = "group"; },
    (data) => { data.metadata.chat_username = "someone_else"; },
    (data) => { data.messages[0].timestamp = Date.parse(data.metadata.range_end_exclusive) / 1000; },
    (data) => { data.messages[0].chat_username = "someone_else"; },
  ]) {
    const f = await fixture(t, (input) => syntheticExport(input, mutate));
    await f.request("POST", "/chats", { query: "" });
    const created = await f.request("POST", "/exports", selection);
    const failed = await finish(f, created.data.jobId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.exports, undefined);
  }
});

test("文件摘要被篡改或输出文件越过独占目录时拒绝读取", async (t) => {
  for (const failure of ["hash", "path"]) {
    const f = await fixture(t, async (input) => {
      const result = await syntheticExport(input);
      if (input.args.some((argument) => argument.startsWith("--list-chats="))) return result;
      const summary = JSON.parse(result.stdout);
      if (failure === "hash") {
        const validation = JSON.parse(await readFile(summary.validation_file, "utf8"));
        validation.json_sha256 = "0".repeat(64);
        await writeFile(summary.validation_file, JSON.stringify(validation), "utf8");
      } else summary.json_file = path.join(f.root, ".local-wechat", "config.json");
      return { ...result, stdout: JSON.stringify(summary) };
    });
    await f.request("POST", "/chats", { query: "" });
    const created = await f.request("POST", "/exports", selection);
    const failed = await finish(f, created.data.jobId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.exports, undefined);
    assert.ok(!failed.error.includes(f.root));
  }
});

test("上游失败或输出不兼容时明确报错，不模拟成功或泄露原始诊断", async (t) => {
  for (const result of [
    { code: 1, stdout: "", stderr: JSON.stringify({ status: "failed", reason: "C:/private/keys 未能定位本机微信数据目录" }) },
    { code: 0, stdout: JSON.stringify({ status: "failed" }), stderr: "" },
    { code: 0, stdout: "not json", stderr: "" },
  ]) {
    const f = await fixture(t, async () => result);
    const response = await f.request("POST", "/chats", { query: "" });
    assert.equal(response.status, 502);
    assert.ok(response.data.error);
    assert.ok(!response.data.error.includes("C:/private"));
    assert.equal(response.data.chats, undefined);
  }
});

test("运行中只能有一个任务，取消等待模拟进程退出后才显示cancelled", async (t) => {
  let exited = false;
  let running;
  const started = new Promise((resolve) => { running = resolve; });
  const f = await fixture(t, async (input) => {
    if (input.args.some((argument) => argument.startsWith("--list-chats="))) return listed();
    running();
    return new Promise((resolve) => input.signal.addEventListener("abort", () => setTimeout(() => { exited = true; resolve({ code: null, stdout: "", stderr: "" }); }, 35), { once: true }));
  });
  await f.request("POST", "/chats", { query: "" });
  const created = await f.request("POST", "/exports", selection);
  await started;
  assert.equal((await f.request("POST", "/exports", selection)).status, 409);
  assert.equal((await f.request("POST", "/chats", { query: "" })).status, 409);
  const cancelled = await f.request("POST", `/jobs/${created.data.jobId}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.status, "running");
  assert.equal(exited, false);
  const result = await finish(f, created.data.jobId);
  assert.equal(exited, true);
  assert.equal(result.status, "cancelled");
  assert.equal(result.exports, undefined);
});

test("超时任务在执行器退出后标记失败，缓存过期必须重新列会话", async (t) => {
  let clock = 1000;
  const f = await fixture(t, async (input) => {
    if (input.args.some((argument) => argument.startsWith("--list-chats="))) return listed();
    return new Promise((resolve) => input.signal.addEventListener("abort", () => setTimeout(() => resolve({ code: null, stdout: "", stderr: "" }), 5), { once: true }));
  }, { timeoutMs: 25, cacheMs: 100, now: () => clock });
  await f.request("POST", "/chats", { query: "" });
  clock += 101;
  assert.equal((await f.request("POST", "/exports", selection)).status, 400);
  await f.request("POST", "/chats", { query: "" });
  const created = await f.request("POST", "/exports", selection);
  const result = await finish(f, created.data.jobId);
  assert.equal(result.status, "failed");
  assert.match(result.error, /超时/);
});

test("Vite插件只在本地标志和serve模式启用，并保护私有目录", () => {
  const original = process.env.KEXU_LOCAL_WECHAT;
  try {
    delete process.env.KEXU_LOCAL_WECHAT;
    const disabled = localWechatPlugin();
    assert.equal(disabled.apply, "serve");
    assert.equal(disabled.config({}), undefined);
    let mounted = false;
    disabled.configureServer({ middlewares: { use() { mounted = true; } } });
    assert.equal(mounted, false);
    process.env.KEXU_LOCAL_WECHAT = "1";
    const enabled = localWechatPlugin();
    const configured = enabled.config({});
    assert.equal(configured.server.host, "127.0.0.1");
    assert.ok(configured.server.fs.deny.includes("**/.local-wechat/**"));
    for (const pattern of [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.dev.vars*", "**/.env*", "**/.wrangler/**"]) assert.ok(configured.server.fs.deny.includes(pattern));
    assert.throws(() => enabled.configResolved({ server: { host: "0.0.0.0" } }), /回环/);
  } finally {
    if (original === undefined) delete process.env.KEXU_LOCAL_WECHAT;
    else process.env.KEXU_LOCAL_WECHAT = original;
  }
});

test("开发中间件阻止普通、编码和@fs形式的密钥、D1及本地聊天路径", async () => {
  const original = process.env.KEXU_LOCAL_WECHAT;
  process.env.KEXU_LOCAL_WECHAT = "1";
  const plugin = localWechatPlugin();
  let middleware;
  try {
    plugin.configureServer({ config: { root: os.tmpdir() }, middlewares: { use(value) { middleware = value; } } });
    for (const url of ["/.local-wechat/config.json", "/.dev.vars", "/.dev.vars.local", "/.env", "/.env.production", "/.wrangler/state/v3/d1/db.sqlite", "/.git/config", "/@fs/C:/project/.local-wechat/jobs/test/chat.json", "/@fs/C:/project/.wrangler/state/db.sqlite", "/%2elocal-wechat/config.json", "/%252edev.vars", "/@fs/C:/project/%2eenv.local"]) {
      let next = false;
      const response = { statusCode: 200, end() {} };
      middleware({ url }, response, () => { next = true; });
      assert.equal(response.statusCode, 403, url);
      assert.equal(next, false, url);
    }
  } finally {
    await plugin.closeBundle();
    if (original === undefined) delete process.env.KEXU_LOCAL_WECHAT;
    else process.env.KEXU_LOCAL_WECHAT = original;
  }
});

test("默认执行器固定参数数组且禁shell，取消必须等待子进程close事件", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const killed = [];
  child.kill = (signal) => { killed.push(signal); return true; };
  let actual;
  const runner = createSpawnRunner((command, args, options) => { actual = { command, args, options }; return child; });
  const controller = new AbortController();
  let finished = false;
  const result = runner({ command: "合成python.exe", args: ["-B", "固定脚本.py", "--chat", "wxid_friend"], cwd: "合成目录", signal: controller.signal }).then((value) => { finished = true; return value; });
  assert.equal(actual.options.shell, false);
  assert.equal(actual.options.windowsHide, true);
  assert.equal(actual.options.env.PYTHONIOENCODING, "utf-8");
  assert.deepEqual(actual.args, ["-B", "固定脚本.py", "--chat", "wxid_friend"]);
  controller.abort();
  await Promise.resolve();
  assert.equal(finished, false);
  assert.deepEqual(killed, ["SIGTERM"]);
  child.emit("close", null);
  await result;
  assert.equal(finished, true);
});
