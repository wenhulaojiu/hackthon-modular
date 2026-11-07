import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createReplyEngine, DEFAULT_REPLY_SETTINGS, isBusinessOpen } from "../scripts/local-wechat/reply-engine.mjs";

const goodReply = { action: "reply", reply: "您好，咖啡礼盒的价格是100元。", reason: "根据门店已配置价格。", productIds: ["coffee"] };
const timestamp = Date.parse("2026-11-07T02:00:00.000Z");
function config(mode = "auto") {
  return {
    settings: { ...structuredClone(DEFAULT_REPLY_SETTINGS), enabled: true, mode, selectedCustomerIds: ["c1", "c2"], businessHours: { enabled: false, start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5, 6] }, cooldownSeconds: 0 },
    customers: [{ id: "c1", wechatId: "wxid_c1", name: "客户甲", autoReplyEnabled: true }, { id: "c2", wechatId: "wxid_c2", name: "客户乙", autoReplyEnabled: true }],
    products: [{ id: "coffee", name: "咖啡礼盒", type: "product", price: 100, description: "礼盒简洁包装。", faq: [], enabled: true }], storeName: "合成门店", industry: "零售",
  };
}
const event = (id, chatId = "wxid_c1", extra = {}) => ({ id, chatId, sender: "customer", text: "咖啡礼盒多少钱？", date: new Date(timestamp).toISOString(), source: "realtime", kind: "text", ...extra });

async function fixture(t, options = {}) {
  const temporary = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporary, "kexu-reply-test-"));
  const engines = [];
  const create = async (overrides = {}) => {
    const engine = await createReplyEngine({ directory, now: () => timestamp, tickMs: 10, ...options, ...overrides });
    engines.push(engine); return engine;
  };
  const engine = await create();
  t.after(async () => {
    for (const item of engines) await item.close();
    const actual = await realpath(directory);
    // 递归清理只允许本次合成测试的唯一目录。
    assert.equal(path.dirname(actual).toLowerCase(), temporary.toLowerCase());
    assert.ok(path.basename(actual).startsWith("kexu-reply-test-"));
    await rm(actual, { recursive: true, force: true });
  });
  return { engine, create, directory };
}

async function until(engine, condition) {
  for (let count = 0; count < 600; count += 1) {
    const state = await engine.status();
    if (condition(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("合成回复任务未完成预期状态");
}

test("默认关闭，配置不自动启动，启动前消息不补发", async (t) => {
  let sends = 0;
  const { engine } = await fixture(t, { generate: async () => goodReply, send: async () => { sends += 1; return { status: "sent", messageId: "sent-1" }; } });
  assert.equal((await engine.status()).running, false);
  await assert.rejects(() => engine.start(), /先保存并启用/);
  await engine.syncConfig(config());
  assert.equal((await engine.status()).running, false);
  assert.equal((await engine.ingest(event("old"))).status, "ignored");
  await engine.start();
  await engine.ingest(event("new"));
  const state = await until(engine, (value) => value.counts.sent === 1);
  assert.equal(state.counts.ignored, 1);
  assert.equal(sends, 1);
});

test("消息防重持久化，进程重启也不会重复回复或自动启动", async (t) => {
  let sends = 0;
  const send = async () => ({ status: "sent", messageId: `sent-${++sends}` });
  const f = await fixture(t, { generate: async () => goodReply, send });
  await f.engine.syncConfig(config()); await f.engine.start();
  await f.engine.ingest(event("native-message-1"));
  await until(f.engine, (state) => state.counts.sent === 1);
  assert.equal((await f.engine.ingest(event("native-message-1"))).duplicate, true);
  await f.engine.close();
  const reopened = await f.create();
  assert.equal((await reopened.status()).running, false);
  await reopened.start();
  assert.equal((await reopened.ingest(event("native-message-1"))).duplicate, true);
  assert.equal(sends, 1);
  assert.equal((await reopened.status()).jobs.length, 1);
});

test("同一会话按序生成和发送，多个会话可独立生成但发送全局串行", async (t) => {
  const waiting = new Map();
  const started = [];
  let activeSends = 0;
  let peak = 0;
  let native = 0;
  const { engine } = await fixture(t, {
    generate: async (work) => { started.push(work.message.id); return new Promise((resolve) => waiting.set(work.message.id, resolve)); },
    send: async () => { activeSends += 1; peak = Math.max(peak, activeSends); await new Promise((resolve) => setTimeout(resolve, 10)); activeSends -= 1; return { status: "sent", messageId: `native-${++native}` }; },
  });
  await engine.syncConfig(config()); await engine.start();
  await engine.ingest(event("a1")); await engine.ingest(event("a2")); await engine.ingest(event("b1", "wxid_c2"));
  await until(engine, () => waiting.has("a1") && waiting.has("b1"));
  assert.equal(started.includes("a2"), false);
  waiting.get("b1")(goodReply);
  await until(engine, (state) => state.counts.sent === 1);
  assert.equal(started.includes("a2"), false);
  waiting.get("a1")(goodReply);
  await until(engine, () => waiting.has("a2"));
  waiting.get("a2")(goodReply);
  await until(engine, (state) => state.counts.sent === 3);
  assert.equal(peak, 1);
  assert.deepEqual(started, ["a1", "b1", "a2"]);
});

test("审核模式不会自动发送，批准后只发送一次，拒绝不能撤销已发送记录", async (t) => {
  let count = 0;
  const { engine } = await fixture(t, { generate: async () => goodReply, send: async () => ({ status: "sent", messageId: `native-${++count}` }) });
  await engine.syncConfig(config("review")); await engine.start();
  await engine.ingest(event("review"));
  let state = await until(engine, (value) => value.counts.draft === 1);
  assert.equal(count, 0);
  await engine.approve(state.jobs[0].id);
  state = await until(engine, (value) => value.counts.sent === 1);
  await assert.rejects(() => engine.approve(state.jobs[0].id), /只有待审核/);
  await assert.rejects(() => engine.reject(state.jobs[0].id), /不能撤回或重试/);
  assert.equal(count, 1);
});

test("发送异常或缺少消息标识视为unknown，接管且重启后禁止重发", async (t) => {
  let sends = 0;
  const f = await fixture(t, { generate: async () => goodReply, send: async () => { sends += 1; throw new Error("连接中断，无法判断是否送达"); } });
  await f.engine.syncConfig(config()); await f.engine.start();
  await f.engine.ingest(event("uncertain"));
  const state = await until(f.engine, (value) => value.counts.unknown === 1);
  assert.ok(state.takeovers.includes("c1"));
  await assert.rejects(() => f.engine.approve(state.jobs[0].id), /只有待审核/);
  assert.equal(f.engine.retry, undefined);
  await f.engine.close();
  const reopened = await f.create(); await reopened.start();
  await reopened.ingest(event("next-after-unknown"));
  assert.equal((await reopened.status()).counts.handoff, 1);
  assert.equal(sends, 1);
});

test("重启前持久sending在恢复后变为unknown，不能被当作未发送重新排队", async (t) => {
  const f = await fixture(t, { generate: async () => goodReply, send: async () => new Promise(() => {}) });
  await f.engine.syncConfig(config()); await f.engine.start();
  await f.engine.ingest(event("crash-window"));
  await until(f.engine, (value) => value.counts.sending === 1);
  // 合成进程崩溃窗口：直接核对已落盘状态，再关闭并恢复。
  const saved = JSON.parse(await readFile(path.join(f.directory, "queue.json"), "utf8"));
  assert.equal(saved.jobs[0].status, "sending");
  await f.engine.close();
  const reopened = await f.create();
  assert.equal((await reopened.status()).counts.unknown, 1);
  assert.equal((await reopened.status()).running, false);
});

test("历史导入、营销、非白名单和非文字消息不会触发客服回复", async (t) => {
  let generated = 0;
  const { engine } = await fixture(t, { generate: async () => { generated += 1; return goodReply; }, send: async () => ({ status: "sent", messageId: "native" }) });
  await engine.syncConfig(config()); await engine.start();
  for (const input of [event("history", "wxid_c1", { source: "history" }), event("marketing", "wxid_c1", { source: "marketing" }), event("stranger", "wxid_unknown"), event("image", "wxid_c1", { kind: "image" }), event("system", "wxid_c1", { sender: "system" })]) assert.equal((await engine.ingest(input)).accepted, false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(generated, 0);
  assert.equal((await engine.status()).jobs.length, 0);
});

test("闭店、退款改价和人工接管强制门禁，恢复仅对新消息生效", async (t) => {
  let generated = 0;
  const { engine } = await fixture(t, { generate: async () => { generated += 1; return goodReply; }, send: async () => ({ status: "sent", messageId: "native" }) });
  const closed = config(); closed.settings.businessHours = { enabled: true, start: "00:00", end: "00:00", days: [0, 1, 2, 3, 4, 5, 6] };
  await engine.syncConfig(closed); await engine.start();
  assert.equal((await engine.ingest(event("after-hours"))).status, "ignored");
  await engine.syncConfig(config());
  assert.equal((await engine.ingest(event("refund", "wxid_c1", { text: "我想退款，能改价吗？" }))).status, "handoff");
  assert.equal(generated, 0);
  await engine.takeover({ customerId: "c1", enabled: false });
  await engine.ingest(event("normal-again"));
  await until(engine, (state) => state.counts.sent === 1);
  assert.equal(generated, 1);
  assert.equal((await engine.status()).counts.handoff, 1);
});

test("生成期间人工接管或更改规则不会让旧AI结果发送", async (t) => {
  let resolveAI;
  let calls = 0;
  const { engine } = await fixture(t, { generate: async () => new Promise((resolve) => { resolveAI = resolve; }), send: async () => { calls += 1; return { status: "sent", messageId: "native" }; } });
  await engine.syncConfig(config()); await engine.start();
  await engine.ingest(event("takeover-during-ai"));
  await until(engine, () => !!resolveAI);
  await engine.takeover({ customerId: "c1", enabled: true });
  resolveAI(goodReply);
  await until(engine, (state) => state.counts.handoff === 1);
  assert.equal(calls, 0);
});

test("后台生成失败、未知价格和越权承诺转人工，不模拟发送成功", async (t) => {
  for (const result of [null, { ...goodReply, reply: "这款礼盒1元。" }, { ...goodReply, reply: "已为您退款，100%有效。" }, { ...goodReply, action: "handoff", reply: "", reason: "现有资料无法回答。" }]) {
    let sends = 0;
    const { engine } = await fixture(t, { generate: async () => { if (!result) throw new Error("模型连接失败"); return result; }, send: async () => { sends += 1; return { status: "sent", messageId: "native" }; } });
    await engine.syncConfig(config()); await engine.start(); await engine.ingest(event("blocked"));
    await until(engine, (state) => state.counts.handoff + state.counts.failed === 1);
    assert.equal(sends, 0);
  }
});

test("浏览器备用生成使用单次租约，不能重复回写或绕过审核", async (t) => {
  const { engine } = await fixture(t, { send: async () => ({ status: "sent", messageId: "native" }) });
  await engine.syncConfig(config("review")); await engine.start(); await engine.ingest(event("browser-work"));
  const claimed = await engine.claimWork();
  assert.equal(claimed.jobs.length, 1);
  assert.equal((await engine.claimWork()).jobs.length, 0);
  const job = claimed.jobs[0];
  assert.equal(job.customerId, "c1");
  assert.ok(job.context.length > 0);
  await engine.completeWork({ jobId: job.id, leaseId: job.leaseId, result: goodReply });
  assert.equal((await engine.status()).counts.draft, 1);
  await assert.rejects(() => engine.completeWork({ jobId: job.id, leaseId: job.leaseId, result: goodReply }), /任务已失效/);
});

test("没有发送适配器不允许启动自动模式，商品密钥未知字段不能持久化", async (t) => {
  const { engine, directory } = await fixture(t);
  await engine.syncConfig(config());
  await assert.rejects(() => engine.start(), /发送适配器尚未配置/);
  await assert.rejects(() => engine.syncConfig({ ...config(), apiKey: "must-not-save" }), /配置格式不正确/);
  assert.ok(!(await readFile(path.join(directory, "queue.json"), "utf8")).includes("must-not-save"));
});

test("营业时间按上海日期，支持跨午夜且结束时刻不含", () => {
  const hours = { enabled: true, start: "22:00", end: "02:00", days: [5] };
  assert.equal(isBusinessOpen(hours, Date.parse("2026-11-06T22:30:00+08:00")), true);
  assert.equal(isBusinessOpen(hours, Date.parse("2026-11-07T01:30:00+08:00")), true);
  assert.equal(isBusinessOpen(hours, Date.parse("2026-11-07T02:00:00+08:00")), false);
  assert.equal(isBusinessOpen(hours, Date.parse("2026-11-07T22:30:00+08:00")), false);
});

test("运行中切换审核到自动或变更白名单会暂停，必须重新验证并启动", async (t) => {
  const { engine } = await fixture(t, { send: async () => ({ status: "sent", messageId: "native" }) });
  await engine.syncConfig(config("review")); await engine.start();
  await engine.syncConfig(config("auto"));
  assert.equal((await engine.status()).running, false);
  assert.match((await engine.status()).pausedReason, /重新启动/);
  await engine.start();
  const fewer = config("auto"); fewer.settings.selectedCustomerIds = ["c1"];
  await engine.syncConfig(fewer);
  assert.equal((await engine.status()).running, false);
  await engine.pause("本机读取失败，已停止。");
  assert.equal((await engine.status()).pausedReason, "本机读取失败，已停止。");
});

test("自动发送回声按native消息ID匹配，延迟轮询也不触发人工接管", async (t) => {
  let clock = timestamp;
  const { engine } = await fixture(t, { now: () => clock, generate: async () => goodReply, send: async () => ({ status: "sent", messageId: "native-server-123" }) });
  await engine.syncConfig(config()); await engine.start(); await engine.ingest(event("incoming"));
  await until(engine, (state) => state.counts.sent === 1);
  clock += 5 * 60_000;
  await engine.ingest(event("sent-echo", "wxid_c1", { sender: "merchant", nativeMessageId: "native-server-123", text: goodReply.reply }));
  assert.equal((await engine.status()).takeovers.includes("c1"), false);
  await engine.ingest(event("actual-human", "wxid_c1", { sender: "merchant", nativeMessageId: "native-human-456", text: "我来亲自给您介绍。" }));
  assert.equal((await engine.status()).takeovers.includes("c1"), true);
});
