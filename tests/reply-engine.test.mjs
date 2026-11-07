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
    settings: { ...structuredClone(DEFAULT_REPLY_SETTINGS), enabled: true, mode, selectedCustomerIds: ["c1", "c2"], businessHours: { enabled: false, start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5, 6] }, cooldownSeconds: 0, debounceSeconds: 0 },
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

test("多个会话可独立生成，发送仍全局串行", async (t) => {
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
  await engine.ingest(event("a1")); await engine.ingest(event("b1", "wxid_c2"));
  await until(engine, () => waiting.has("a1") && waiting.has("b1"));
  waiting.get("b1")(goodReply);
  await until(engine, (state) => state.counts.sent === 1);
  waiting.get("a1")(goodReply);
  await until(engine, (state) => state.counts.sent === 2);
  assert.equal(peak, 1);
  assert.deepEqual(started, ["a1", "b1"]);
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

test("旧规则缺省等待60秒，连续新消息重置时间且合并一次，重复原生消息不延后", async (t) => {
  let clock = timestamp;
  let sends = 0;
  const { engine } = await fixture(t, { now: () => clock, send: async () => ({ status: "sent", messageId: `native-${++sends}` }) });
  const legacy = config(); delete legacy.settings.debounceSeconds;
  await engine.syncConfig(legacy);
  assert.equal((await engine.getConfig()).settings.debounceSeconds, 60);
  await engine.start();
  await engine.ingest(event("part-one", "wxid_c1", { nativeMessageId: "101", text: "咖啡礼盒多少钱？" }));
  clock += 59_999;
  assert.equal((await engine.claimWork()).jobs.length, 0);
  await engine.ingest(event("part-two", "wxid_c1", { nativeMessageId: "102", text: "包装简单一点。" }));
  clock += 30_000;
  assert.equal((await engine.ingest(event("part-two-repolled", "wxid_c1", { nativeMessageId: "102", text: "包装简单一点。" }))).duplicate, true);
  clock += 29_999;
  assert.equal((await engine.claimWork()).jobs.length, 0);
  clock += 1;
  const { jobs } = await engine.claimWork();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].message.text, "咖啡礼盒多少钱？\n包装简单一点。");
  assert.deepEqual(jobs[0].messages.map((message) => [message.id, message.nativeMessageId]), [["part-one", "101"], ["part-two", "102"]]);
  await engine.completeWork({ jobId: jobs[0].id, leaseId: jobs[0].leaseId, result: goodReply });
  const state = await until(engine, (value) => value.counts.sent === 1);
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].messages.length, 2);
  assert.equal(sends, 1);
});

test("生成中新消息取消旧lease并重新等待，迟到旧AI结果不能发送或覆盖新批次", async (t) => {
  let clock = timestamp;
  const work = [];
  const signals = [];
  const resolves = [];
  let sends = 0;
  const { engine } = await fixture(t, { now: () => clock, generate: async (item, { signal }) => { work.push(item); signals.push(signal); return new Promise(resolve => resolves.push(resolve)); }, send: async () => ({ status: "sent", messageId: `native-${++sends}` }) });
  const settings = config(); settings.settings.debounceSeconds = 2;
  await engine.syncConfig(settings); await engine.start();
  await engine.ingest(event("first"));
  clock += 2000;
  await until(engine, () => work.length === 1);
  clock += 500;
  await engine.ingest(event("second", "wxid_c1", { text: "还有包装要求。" }));
  assert.equal(signals[0].aborted, true);
  resolves[0](goodReply);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(sends, 0);
  assert.equal((await engine.status()).jobs[0].status, "queued");
  clock += 1999;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(work.length, 1);
  clock += 1;
  await until(engine, () => work.length === 2);
  assert.equal(work[1].messages.length, 2);
  assert.notEqual(work[0].leaseId, work[1].leaseId);
  resolves[1](goodReply);
  await until(engine, (state) => state.counts.sent === 1);
  assert.equal(sends, 1);
});

test("敏感后续消息立即阻断生成中回复，合并证据保留且旧结果不发送", async (t) => {
  let resolveAI;
  let signal;
  let sends = 0;
  const { engine } = await fixture(t, { generate: async (_work, options) => { signal = options.signal; return new Promise(resolve => { resolveAI = resolve; }); }, send: async () => { sends++; return { status: "sent", messageId: "unexpected" }; } });
  await engine.syncConfig(config()); await engine.start();
  await engine.ingest(event("normal-before-refund"));
  await until(engine, () => !!resolveAI);
  const result = await engine.ingest(event("refund-later", "wxid_c1", { text: "先别处理，我想退款改价。" }));
  assert.equal(result.status, "handoff");
  assert.equal(signal.aborted, true);
  resolveAI(goodReply);
  await new Promise(resolve => setTimeout(resolve, 30));
  const state = await engine.status();
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].messages.length, 2);
  assert.equal(state.jobs[0].status, "handoff");
  assert.equal(sends, 0);
});

test("跨会话等待各自计算，连续输入不削弱发送冷却门禁", async (t) => {
  let clock = timestamp;
  let sends = 0;
  const { engine } = await fixture(t, { now: () => clock, send: async () => ({ status: "sent", messageId: `native-${++sends}` }) });
  const settings = config(); settings.settings.debounceSeconds = 2; settings.settings.cooldownSeconds = 10;
  await engine.syncConfig(settings); await engine.start();
  await engine.ingest(event("a1")); await engine.ingest(event("b1", "wxid_c2"));
  clock += 1000;
  await engine.ingest(event("a2"));
  clock += 1000;
  const first = (await engine.claimWork()).jobs;
  assert.deepEqual(first.map((job) => job.customerId), ["c2"]);
  await engine.completeWork({ jobId: first[0].id, leaseId: first[0].leaseId, result: goodReply });
  await until(engine, (state) => state.counts.sent === 1);
  await engine.ingest(event("b2", "wxid_c2"));
  clock += 1000;
  const second = (await engine.claimWork()).jobs;
  assert.deepEqual(second.map((job) => job.customerId), ["c1"]);
  await engine.completeWork({ jobId: second[0].id, leaseId: second[0].leaseId, result: goodReply });
  await until(engine, (state) => state.counts.sent === 2);
  clock += 8000;
  assert.equal((await engine.claimWork()).jobs.length, 0);
  clock += 1000;
  const third = (await engine.claimWork()).jobs;
  assert.equal(third.length, 1);
  assert.equal(third[0].customerId, "c2");
});

test("已sending批次不撤回，后来消息另起批次并且不会合并已发送证据", async (t) => {
  let finishSend;
  let calls = 0;
  const { engine } = await fixture(t, { generate: async () => goodReply, send: async () => { calls++; return new Promise(resolve => { finishSend = resolve; }); } });
  await engine.syncConfig(config()); await engine.start();
  await engine.ingest(event("in-flight"));
  await until(engine, (state) => state.counts.sending === 1);
  await engine.ingest(event("next-batch"));
  let state = await engine.status();
  assert.equal(state.jobs.length, 2);
  assert.equal(state.counts.sending, 1);
  assert.equal(state.counts.queued, 1);
  assert.deepEqual(state.jobs.find((job) => job.status === "queued").messages.map((message) => message.id), ["next-batch"]);
  finishSend({ status: "sent", messageId: "native-first" });
  await until(engine, (value) => value.counts.sent === 1 && value.counts.sending === 1);
  assert.equal(calls, 2);
  finishSend({ status: "sent", messageId: "native-second" });
  await until(engine, (value) => value.counts.sent === 2);
});

test("连续消息批次与等待截止持久化，重启不自动运行且旧原生消息仍去重", async (t) => {
  let clock = timestamp;
  const f = await fixture(t, { now: () => clock, send: async () => ({ status: "sent", messageId: "native" }) });
  const settings = config("review"); settings.settings.debounceSeconds = 60;
  await f.engine.syncConfig(settings); await f.engine.start();
  await f.engine.ingest(event("persistent-one")); await f.engine.ingest(event("persistent-two"));
  await f.engine.close();
  const reopened = await f.create();
  assert.equal((await reopened.status()).running, false);
  await reopened.start();
  assert.equal((await reopened.ingest(event("persistent-two"))).duplicate, true);
  clock += 59_999;
  assert.equal((await reopened.claimWork()).jobs.length, 0);
  clock += 1;
  const jobs = (await reopened.claimWork()).jobs;
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].messages.map((message) => message.id), ["persistent-one", "persistent-two"]);
});

test("等待时间仅允许0到120整数，明确0时无需等待", async (t) => {
  const { engine } = await fixture(t, { send: async () => ({ status: "sent", messageId: "native" }) });
  for (const debounceSeconds of [-1, 121, 0.5, null, "60"]) {
    const invalid = config(); invalid.settings.debounceSeconds = debounceSeconds;
    await assert.rejects(() => engine.syncConfig(invalid), /0–120整秒/);
  }
  await engine.syncConfig(config()); await engine.start(); await engine.ingest(event("immediate"));
  assert.equal((await engine.claimWork()).jobs.length, 1);
});

test("新消息废弃旧待审核草稿并合并重算，旧批准操作不能发送过时回复", async (t) => {
  let clock = timestamp;
  let sends = 0;
  const { engine } = await fixture(t, { now: () => clock, send: async () => ({ status: "sent", messageId: `native-${++sends}` }) });
  await engine.syncConfig(config("review")); await engine.start(); await engine.ingest(event("draft-first"));
  const old = (await engine.claimWork()).jobs[0];
  await engine.completeWork({ jobId: old.id, leaseId: old.leaseId, result: goodReply });
  assert.equal((await engine.status()).jobs[0].status, "draft");
  const settings = config("review"); settings.settings.debounceSeconds = 60;
  await engine.syncConfig(settings);
  await engine.ingest(event("draft-extra", "wxid_c1", { text: "还想了解服务内容。" }));
  await assert.rejects(() => engine.approve(old.id), /只有待审核/);
  assert.equal((await engine.claimWork()).jobs.length, 0);
  clock += 60_000;
  const renewed = (await engine.claimWork()).jobs[0];
  assert.equal(renewed.messages.length, 2);
  await assert.rejects(() => engine.completeWork({ jobId: old.id, leaseId: old.leaseId, result: goodReply }), /任务已失效/);
  assert.equal(sends, 0);
});

test("连续批次容量超限时保留全部原文证据并转人工，不截断后自动回复", async (t) => {
  const { engine } = await fixture(t, { send: async () => ({ status: "sent", messageId: "unexpected" }) });
  await engine.syncConfig(config()); await engine.start();
  await engine.ingest(event("long-one", "wxid_c1", { text: "咨询".repeat(2500) }));
  const result = await engine.ingest(event("long-two", "wxid_c1", { text: "补充".repeat(2500) }));
  assert.equal(result.status, "handoff");
  const job = (await engine.status()).jobs[0];
  assert.equal(job.messages.length, 2);
  assert.equal(job.message.text.length, 10_001);
  assert.equal((await engine.claimWork()).jobs.length, 0);
});
