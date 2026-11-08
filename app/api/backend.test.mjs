import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createReplyEngine } from "../../scripts/local-wechat/reply-engine.mjs";

const project = fileURLToPath(new URL("../../", import.meta.url));
const nativeRequire = createRequire(import.meta.url);
const { drizzle } = nativeRequire("drizzle-orm/d1");
const origin = "http://127.0.0.1:3000";

// 用真实 SQLite 与 Drizzle 执行生产 SQL，只替换 Cloudflare 绑定及已认证身份。
function fixture(bindings = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const filename of readdirSync(path.join(project, "drizzle")).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(path.join(project, "drizzle", filename), "utf8"));
  }
  const d1 = {
    prepare(sql) {
      let params = [];
      const query = {
        bind(...values) { params = values; return query; },
        async raw() { return sqlite.prepare(sql).all(...params).map((row) => Object.values(row)); },
        async all() { return { results: sqlite.prepare(sql).all(...params), success: true }; },
        async run() { return { meta: sqlite.prepare(sql).run(...params), success: true }; },
      };
      return query;
    },
  };
  const identity = new AsyncLocalStorage();
  const environment = { DB: d1, APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"), ...bindings };
  const loaded = new Map();
  let schema;
  const load = (filename) => {
    const absolute = path.resolve(project, filename);
    if (loaded.has(absolute)) return loaded.get(absolute).exports;
    const output = ts.transpileModule(readFileSync(absolute, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      // 测试加载器统一编译为CommonJS；.mjs扩展名会让TypeScript保留ESM输出。
      fileName: absolute.endsWith('.mjs') ? `${absolute.slice(0, -4)}.ts` : absolute,
    }).outputText;
    const module = { exports: {} };
    loaded.set(absolute, module);
    const localRequire = (specifier) => {
      if (specifier === "cloudflare:workers") return { env: environment };
      if (specifier === "@/app/chatgpt-auth") return { getChatGPTUser: async () => identity.getStore() ? { userId: identity.getStore(), email: `${identity.getStore()}@test.invalid` } : null };
      if (specifier === "@/db") return { getDb: () => drizzle(d1, { schema }) };
      if (specifier.startsWith("@/")) return load(/\.(?:ts|mjs)$/.test(specifier) ? specifier.slice(2) : `${specifier.slice(2)}.ts`);
      if (specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(absolute), specifier);
        return load(/\.(?:ts|mjs)$/.test(target) ? target : `${target}.ts`);
      }
      return nativeRequire(specifier);
    };
    new Function("require", "module", "exports", output)(localRequire, module, module.exports);
    return module.exports;
  };
  schema = load("db/schema.ts");
  const server = load("lib/server.ts");
  return {
    sqlite, environment, server, catalog: load("lib/competition-demo.ts"),
    stateRoute: load("app/api/state/route.ts"),
    secretRoute: load("app/api/secret/route.ts"),
    aiRoute: load("app/api/ai/route.ts"),
    replyRoute: load("app/api/reply/route.ts"),
    enrollRoute: load("app/api/reply/enroll/route.ts"),
    manualResumeRoute: load("app/api/reply/manual-resume/route.ts"),
    asUser: (user, work) => identity.run(user, work),
    close: () => sqlite.close(),
  };
}

function post(endpoint, body, headers = {}) {
  return new Request(`${origin}/api/${endpoint}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
    body: JSON.stringify(body),
  });
}

test("默认演示数据通过生产 schema，首次并发加载不会重复初始化", async () => {
  const f = fixture();
  try {
    const [a, b] = await Promise.all([f.server.loadState("alice"), f.server.loadState("alice")]);
    assert.equal(a.revision, 0);
    assert.deepEqual(a, b);
    assert.ok(f.server.appStateSchema.safeParse(a.state).success);
    assert.ok(a.state.customers.length > 0);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM user_states").get().count, 1);
  } finally { f.close(); }
});

test("未登录请求返回401，浏览器同源POST可用，跨源或缺少Origin被拒绝", async () => {
  const f = fixture();
  try {
    assert.equal((await f.stateRoute.GET()).status, 401);
    assert.equal((await f.secretRoute.POST(post("secret", { remove: true }))).status, 401);
    const loaded = await f.asUser("alice", async () => (await f.stateRoute.GET()).json());
    const good = await f.asUser("alice", () => f.stateRoute.POST(post("state", { state: loaded.state, revision: 0 })));
    assert.equal(good.status, 200);
    const cross = await f.asUser("alice", () => f.secretRoute.POST(post("secret", { remove: true }, { origin: "https://other.example" })));
    assert.equal(cross.status, 403);
    const missingOrigin = post("secret", { remove: true });
    missingOrigin.headers.delete("origin");
    assert.equal((await f.asUser("alice", () => f.secretRoute.POST(missingOrigin))).status, 403);
    assert.equal((await f.asUser("alice", () => f.secretRoute.POST(post("secret", { remove: true }, { "content-type": "text/plain" })))).status, 415);
  } finally { f.close(); }
});

test("同revision并发写入仅一次成功，冲突返回409且不静默覆写", async () => {
  const f = fixture();
  try {
    const { state } = await f.server.loadState("alice");
    const first = structuredClone(state);
    const second = structuredClone(state);
    first.settings.storeName = "甲门店";
    second.settings.storeName = "乙门店";
    const responses = await Promise.all([first, second].map((next) => f.asUser("alice", () => f.stateRoute.POST(post("state", { state: next, revision: 0 })))));
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const stored = await f.server.loadState("alice");
    assert.equal(stored.revision, 1);
    const winner = responses[0].status === 200 ? first : second;
    assert.equal(stored.state.settings.storeName, winner.settings.storeName);
    const conflict = await responses.find((response) => response.status === 409).json();
    assert.equal(conflict.revision, 1);
  } finally { f.close(); }
});

test("不同用户的状态、密钥和删除操作互不影响", async () => {
  const f = fixture();
  try {
    const a = await f.server.loadState("alice");
    a.state.settings.storeName = "甲的私有门店";
    await f.server.saveState("alice", a.state, 0);
    const b = await f.server.loadState("bob");
    assert.notEqual(b.state.settings.storeName, a.state.settings.storeName);
    assert.equal(b.revision, 0);
    await f.server.storeKey("alice", "sk-test-private-alice");
    await f.server.storeKey("bob", "sk-test-private-bob");
    await f.asUser("bob", () => f.secretRoute.POST(post("secret", { remove: true })));
    assert.equal(await f.server.hasSavedKey("bob"), false);
    assert.equal(await f.server.hasSavedKey("alice"), true);
    const loaded = await f.asUser("alice", async () => (await f.stateRoute.GET()).json());
    assert.equal(loaded.hasApiKey, true);
    assert.ok(!JSON.stringify(loaded).includes("sk-test-private"));
  } finally { f.close(); }
});

test("密钥为随机AES-GCM密文，空输入不会覆盖，密文不可跨用户解密", async () => {
  const f = fixture();
  try {
    const saved = await f.asUser("alice", () => f.secretRoute.POST(post("secret", { apiKey: "sk-test-private-alice" })));
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { hasApiKey: true });
    const original = f.sqlite.prepare("SELECT * FROM user_secrets WHERE user_id = ?").get("alice");
    assert.ok(!JSON.stringify(original).includes("sk-test-private-alice"));
    assert.equal(Buffer.from(original.nonce, "base64").length, 12);
    const blank = await f.asUser("alice", () => f.secretRoute.POST(post("secret", { apiKey: "   " })));
    assert.equal(blank.status, 400);
    assert.equal(f.sqlite.prepare("SELECT ciphertext FROM user_secrets WHERE user_id = ?").get("alice").ciphertext, original.ciphertext);
    await f.server.storeKey("alice", "sk-test-private-alice");
    const updated = f.sqlite.prepare("SELECT * FROM user_secrets WHERE user_id = ?").get("alice");
    assert.notEqual(updated.nonce, original.nonce);
    f.sqlite.prepare("INSERT INTO user_secrets (user_id,ciphertext,nonce,updated_at) VALUES (?,?,?,?)").run("bob", updated.ciphertext, updated.nonce, updated.updated_at);
    await assert.rejects(() => f.server.runAI("bob", { action: "test" }), (error) => error.status === 503 && error.message.includes("无法解密"));
    await f.server.removeKey("alice");
    assert.equal(await f.server.hasSavedKey("alice"), false);
  } finally { f.close(); }
});

test("未配置加密密钥时拒绝保存；未保存模型密钥时测试真实报错", async () => {
  const f = fixture();
  try {
    delete f.environment.APP_ENCRYPTION_KEY;
    const response = await f.asUser("alice", () => f.secretRoute.POST(post("secret", { apiKey: "sk-test-private-alice" })));
    assert.equal(response.status, 503);
    assert.equal(await f.server.hasSavedKey("alice"), false);
    const ai = await f.asUser("alice", () => f.aiRoute.POST(post("ai", { action: "test" })));
    assert.equal(ai.status, 400);
    assert.match((await ai.json()).error, /API Key/);
  } finally { f.close(); }
});

test("无效日期、退款金额、重复ID和跨客户引用不能进入持久化", async () => {
  const f = fixture();
  try {
    const { state } = await f.server.loadState("alice");
    const invalidStates = [
      (next) => { next.orders[0].date = "2026-02-31"; },
      (next) => { next.orders[0].amount = -10; },
      (next) => { next.orders[0].customerId = "not-a-customer"; },
      (next) => { next.customers.push(structuredClone(next.customers[0])); },
      (next) => { next.customers[0].messages.push(structuredClone(next.customers[0].messages[0])); },
    ];
    for (const invalidate of invalidStates) {
      const next = structuredClone(state);
      invalidate(next);
      const response = await f.asUser("alice", () => f.stateRoute.POST(post("state", { state: next, revision: 0 })));
      assert.equal(response.status, 400);
    }
    assert.equal((await f.server.loadState("alice")).revision, 0);
  } finally { f.close(); }
});

test("自定义模型URL拒绝明显SSRF目标与重定向入口参数", () => {
  const f = fixture();
  try {
    for (const url of ["http://api.example.com", "https://127.0.0.1", "https://10.0.0.1", "https://2130706433", "https://[::1]", "https://localhost.localdomain", "https://metadata.google.internal", "https://127.0.0.1.nip.io", "https://user:password@api.example.com", "https://api.example.com:8443", "https://api.example.com?redirect=http://localhost"]) {
      assert.throws(() => f.server.chatCompletionUrl(url), (error) => error.status === 400, url);
    }
    assert.equal(f.server.chatCompletionUrl(""), "https://api.deepseek.com/chat/completions");
    assert.equal(f.server.chatCompletionUrl("https://api.example.com/v1/"), "https://api.example.com/v1/chat/completions");
    assert.equal(f.server.chatCompletionUrl("https://api.example.com/v1/chat/completions"), "https://api.example.com/v1/chat/completions");
  } finally { f.close(); }
});

test("AI上下文的业务日期按上海时区跨日，不直接截取UTC日期", () => {
  const f = fixture();
  try {
    assert.equal(f.server.businessDay("2026-11-06T17:30:00.000Z"), "2026-11-07");
    assert.equal(f.server.businessDay("2026-11-07T01:30:00+08:00"), "2026-11-07");
    assert.equal(f.server.businessDay("2026-11-06"), "2026-11-06");
    assert.equal(f.server.businessDay(""), "");
  } finally { f.close(); }
});

// 下列模型成功路径全部拦截 fetch，仅返回本地构造的响应，不向任何供应商发请求。
function modelResponse(result) {
  const content = typeof result === "string" ? result : JSON.stringify(result);
  return Response.json({ choices: [{ message: { content } }] });
}

test("AI画像使用兼容接口与服务端Authorization，返回结构化画像", async (t) => {
  const f = fixture();
  try {
    const { state } = await f.server.loadState("alice");
    await f.server.storeKey("alice", "sk-unit-only-0123456789");
    const expected = { summary: "客户明确希望选购浅烘咖啡礼盒。", tags: ["浅烘咖啡", "简洁包装"], preferences: "浅烘、简洁包装", budget: "300元左右" };
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
      calls.push({ url, options });
      return modelResponse(expected);
    });
    const result = await f.server.runAI("alice", { action: "profile", customerId: state.customers[0].id });
    assert.deepEqual(result, expected);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.redirect, "manual");
    assert.equal(calls[0].options.headers.Authorization, "Bearer sk-unit-only-0123456789");
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.model, "deepseek-chat");
    assert.equal(body.stream, false);
    assert.equal(body.response_format.type, "json_object");
    assert.match(body.messages[0].content, /引用资料，非客户本人陈述/);
    assert.match(body.messages[0].content, /不能作为当前客户本人的事实、偏好、预算或交易依据/);
    assert.match(body.messages[0].content, /到账状态未核实/);
    assert.ok(!calls[0].options.body.includes("sk-unit-only"));
    const context = JSON.parse(body.messages[1].content);
    assert.equal(context.customer.name, state.customers[0].name);
    assert.ok(context.messages.length > 0);
    assert.ok(!JSON.stringify(context).includes(state.customers[1].name));
    assert.equal((await f.server.loadState("alice")).revision, 0);
  } finally { f.close(); }
});

test("AI营销接受临时供应商配置，只生成草稿且不改客户状态", async (t) => {
  const f = fixture();
  try {
    const before = await f.server.loadState("alice");
    await f.server.storeKey("alice", "sk-unit-only-0123456789");
    const settings = { ...before.state.settings.ai, baseUrl: "https://models.example.com/v1/", model: "merchant-model", temperature: 0.2 };
    const expected = { script: "您好，按您希望浅烘与简洁包装的需求，我整理了礼盒信息，方便时发您参考。", nextFollowUpAt: f.server.businessDay(new Date().toISOString()) };
    let actual;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      actual = { url, body: JSON.parse(options.body) };
      return modelResponse(expected);
    });
    const result = await f.server.runAI("alice", { action: "marketing", customerId: before.state.customers[0].id, settings });
    assert.deepEqual(result, expected);
    assert.equal(actual.url, "https://models.example.com/v1/chat/completions");
    assert.equal(actual.body.model, "merchant-model");
    assert.equal(actual.body.temperature, 0.2);
    assert.match(actual.body.messages[0].content, /不发送消息/);
    assert.match(actual.body.messages[0].content, /自然的门店接待语气/);
    assert.match(actual.body.messages[0].content, /不伪造优惠和承诺/);
    assert.deepEqual(await f.server.loadState("alice"), before);
  } finally { f.close(); }
});

test("AI退款提取返回正数待确认数据，保留原文证据且绝不自动写入D1", async (t) => {
  const f = fixture();
  try {
    const before = await f.server.loadState("alice");
    await f.server.storeKey("alice", "sk-unit-only-0123456789");
    const customer = before.state.customers[4];
    const evidence = customer.messages.find((message) => message.text.includes("已退款128元"));
    const candidate = { description: "藤编收纳篮退款", amount: 128, date: f.server.businessDay(evidence.date), type: "refund", evidence: evidence.text };
    t.mock.method(globalThis, "fetch", async () => modelResponse({ orders: [candidate] }));
    const result = await f.server.runAI("alice", { action: "extract", customerId: customer.id });
    assert.deepEqual(result, { orders: [candidate] });
    assert.ok(result.orders[0].amount > 0);
    assert.equal(result.orders[0].type, "refund");
    assert.equal(Object.hasOwn(result.orders[0], "status"), false);
    assert.deepEqual(await f.server.loadState("alice"), before);
  } finally { f.close(); }
});

test("AI消费候选拒绝负数、无效日期、虚构金额、错误退款类型及不存在的原文", async (t) => {
  const f = fixture();
  try {
    const before = await f.server.loadState("alice");
    await f.server.storeKey("alice", "sk-unit-only-0123456789");
    const customer = before.state.customers[4];
    const evidence = customer.messages.find((message) => message.text.includes("已退款128元"));
    const valid = { description: "藤编收纳篮退款", amount: 128, date: f.server.businessDay(evidence.date), type: "refund", evidence: evidence.text };
    let mocked;
    t.mock.method(globalThis, "fetch", async () => modelResponse({ orders: [mocked] }));
    const invalid = [
      { ...valid, amount: -128 },
      { ...valid, amount: 129 },
      { ...valid, date: "2026-02-31" },
      { ...valid, date: "2099-01-01" },
      { ...valid, date: "2020-01-01" },
      { ...valid, type: "sale" },
      { ...valid, evidence: "不存在的聊天：已退款128元。" },
      { ...valid, status: "confirmed" },
    ];
    for (const candidate of invalid) {
      mocked = candidate;
      await assert.rejects(() => f.server.runAI("alice", { action: "extract", customerId: customer.id }), (error) => error.status === 502);
    }
    assert.deepEqual(await f.server.loadState("alice"), before);
  } finally { f.close(); }
});

test("AI提取允许空候选、去重相同消费，不会重复生成或确认订单", async (t) => {
  const f = fixture();
  try {
    const before = await f.server.loadState("alice");
    await f.server.storeKey("alice", "sk-unit-only-0123456789");
    const customer = before.state.customers[0];
    const evidence = customer.messages.find((message) => message.text.includes("已经支付268元"));
    const candidate = { description: "浅烘咖啡双拼礼盒", amount: 268, date: f.server.businessDay(evidence.date), type: "sale", evidence: evidence.text };
    let mocked = { orders: [] };
    t.mock.method(globalThis, "fetch", async () => modelResponse(mocked));
    assert.deepEqual(await f.server.runAI("alice", { action: "extract", customerId: customer.id }), { orders: [] });
    mocked = { orders: [candidate, { ...candidate }] };
    assert.deepEqual(await f.server.runAI("alice", { action: "extract", customerId: customer.id }), { orders: [candidate] });
    assert.deepEqual(await f.server.loadState("alice"), before);
  } finally { f.close(); }
});

test("模型畸形JSON或不兼容响应给出清晰错误，供应商原始错误不会泄露密钥", async (t) => {
  const f = fixture();
  try {
    const { state } = await f.server.loadState("alice");
    await f.server.storeKey("alice", "sk-unit-only-0123456789");
    let response = () => modelResponse("这不是 JSON");
    t.mock.method(globalThis, "fetch", async () => response());
    await assert.rejects(() => f.server.runAI("alice", { action: "profile", customerId: state.customers[0].id }), (error) => error.status === 502 && /有效 JSON/.test(error.message));
    response = () => Response.json({ unexpected: "not-chat-completions" });
    await assert.rejects(() => f.server.runAI("alice", { action: "profile", customerId: state.customers[0].id }), (error) => error.status === 502 && /不兼容/.test(error.message));
    response = () => new Response("<html>供应商临时错误</html>", { status: 200 });
    await assert.rejects(() => f.server.runAI("alice", { action: "profile", customerId: state.customers[0].id }), (error) => error.status === 502 && /无效或过大/.test(error.message));
    response = () => Response.json({ error: { message: "private-provider-error sk-unit-only-0123456789" } }, { status: 401 });
    await assert.rejects(() => f.server.runAI("alice", { action: "profile", customerId: state.customers[0].id }), (error) => error.status === 502 && /API Key/.test(error.message) && !/private-provider-error|sk-unit-only/.test(error.message));
  } finally { f.close(); }
});

test("支付卡片、红包、引用与转发不能成为AI交易证据，截去前缀也无法绕过", async (t) => {
  const f = fixture();
  try {
    let stored = await f.server.loadState("alice");
    await f.server.storeKey("alice", "sk-unit-only-0123456789");
    const date = f.server.businessDay(new Date().toISOString());
    const body = "已经支付128元，咖啡礼盒帮我留好，谢谢。";
    const prefixes = [
      "【转账/收款卡片，到账状态未核实】",
      "【红包卡片，不作为营业收入凭据】",
      "【引用资料，非客户本人陈述】",
      "【转发内容】",
      "【引用资料，非客户本人陈述】【转账/收款卡片，到账状态未核实】",
    ];
    let candidate;
    t.mock.method(globalThis, "fetch", async () => modelResponse({ orders: [candidate] }));
    for (const prefix of prefixes) {
      const next = structuredClone(stored.state);
      const customer = next.customers[0];
      customer.messages = [{ id: "marked-source", sender: "customer", text: `${prefix}${body}`, date }];
      await f.server.saveState("alice", next, stored.revision);
      const beforeAI = await f.server.loadState("alice");
      for (const evidence of [body, `${prefix}${body}`]) {
        candidate = { description: "咖啡礼盒", amount: 128, date, type: "sale", evidence };
        await assert.rejects(() => f.server.runAI("alice", { action: "extract", customerId: customer.id }), (error) => error.status === 502, prefix);
      }
      assert.deepEqual(await f.server.loadState("alice"), beforeAI);
      stored = beforeAI;
    }
  } finally { f.close(); }
});

async function replyFixture(f) {
  const loaded = await f.server.loadState("alice");
  const customer = loaded.state.customers[0];
  customer.autoReplyEnabled = true;
  loaded.state.products = [{ id: "p-coffee", name: "浅烘咖啡礼盒", type: "product", price: 268, description: "双拼浅烘咖啡，简洁包装。", faq: [], enabled: true }];
  loaded.state.replySettings = { enabled: true, mode: "auto", selectedCustomerIds: [customer.id], businessHours: { enabled: false, start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5, 6] }, faq: [], handoffKeywords: ["退款", "改价"], maxReplyChars: 300, cooldownSeconds: 30, prompt: "自然简短回复。" };
  await f.server.saveState("alice", loaded.state, loaded.revision);
  await f.server.storeKey("alice", "sk-unit-only-0123456789");
  return { customerId: customer.id, message: { id: "live-message-1", text: "浅烘咖啡礼盒多少钱？", date: new Date().toISOString() }, context: [] };
}

test("旧schemaVersion1仍兼容，新增商品与回复规则可持久化", async () => {
  const f = fixture();
  try {
    const initial = await f.server.loadState("alice");
    assert.equal(initial.state.products, undefined);
    assert.equal(initial.state.replySettings, undefined);
    await replyFixture(f);
    const updated = await f.server.loadState("alice");
    assert.equal(updated.state.schemaVersion, 1);
    assert.equal(updated.state.products[0].price, 268);
    assert.equal(updated.state.replySettings.enabled, true);
  } finally { f.close(); }
});

test("读取旧比赛模板只迁移商品和店铺视图，不改历史或数据库revision，CAS保存后才持久化", async () => {
  const f = fixture();
  try {
    await replyFixture(f);
    const current = await f.server.loadState('alice');
    const old = current.state;
    old.settings.storeName = '青禾生活馆';
    const base = { id: 'legacy-demo-product', name: '美式咖啡', type: 'product', price: 18, description: '【比赛演示资料】现磨咖啡，可选热饮或冰饮。', faq: [], enabled: true };
    old.products = [
      { ...base, source: 'demo' },
      { ...base, id: 'manual-product', source: 'manual' },
      { ...base, id: 'explicit-unknown', source: 'demo', stock: null, restockThreshold: 0 },
      { ...base, id: 'manual-stock', source: 'demo', stock: 17, restockThreshold: 3 },
    ];
    old.replySettings.storeInfo = { phone: '演示电话（未开放）', address: '青禾市拾光路18号（虚构地址）', serviceContent: '比赛演示店铺：现磨咖啡、每日烘焙、鲜花与生活礼品；提供咖啡体验、花艺体验和礼品包装。' };
    old.replySettings.welcomeMessage = '你好，欢迎来到青禾生活馆！这是比赛演示店铺，提供现磨咖啡、每日烘焙、鲜花与生活礼品，也有咖啡体验、花艺体验和礼品包装服务。演示营业时间为每天09:00–21:00，欢迎直接留言咨询商品或服务。';
    old.customers[0].source = 'wechat';
    old.customers[0].messages.push({ id: 'historical-prefix', sender: 'merchant', text: '【比赛演示资料】已经发送的原消息不能改写。', date: '2026-11-07T01:00:00Z' });
    const raw = JSON.stringify(f.server.appStateSchema.parse(old));
    f.sqlite.prepare('UPDATE user_states SET state_json = ?, revision = ? WHERE user_id = ?').run(raw, 7, 'alice');

    const view = await f.server.loadState('alice');
    assert.equal(view.revision, 7);
    assert.match(view.state.products[0].description, /18元\/杯.*300ml/);
    assert.match(view.state.products[0].description, /当天饮用/);
    assert.equal(view.state.products[0].stock, 80);
    assert.equal(view.state.products[0].restockThreshold, 5);
    assert.deepEqual(view.state.products[1], old.products[1]);
    assert.equal(Object.hasOwn(view.state.products[1], 'stock'), false);
    assert.equal(view.state.products[2].stock, null);
    assert.equal(view.state.products[2].restockThreshold, 0);
    assert.equal(view.state.products[3].stock, 17);
    assert.equal(view.state.products[3].restockThreshold, 3);
    assert.equal(view.state.replySettings.storeInfo.contactName, '林青禾');
    assert.equal(view.state.replySettings.storeInfo.phone, '');
    assert.equal(view.state.replySettings.storeInfo.address, '青禾市拾光路18号');
    assert.ok(!view.state.replySettings.storeInfo.serviceContent.includes('比赛演示'));
    assert.ok(!view.state.replySettings.welcomeMessage.includes('演示'));
    for (const field of ['customers', 'orders', 'tasks', 'imports']) assert.deepEqual(view.state[field], old[field]);
    const unchanged = f.sqlite.prepare('SELECT state_json, revision FROM user_states WHERE user_id = ?').get('alice');
    assert.equal(unchanged.state_json, raw);
    assert.equal(unchanged.revision, 7);

    assert.deepEqual(await f.server.loadState('alice'), view);
    await f.server.saveState('alice', view.state, view.revision);
    const persisted = f.sqlite.prepare('SELECT state_json, revision FROM user_states WHERE user_id = ?').get('alice');
    assert.deepEqual(JSON.parse(persisted.state_json), view.state);
    assert.equal(persisted.revision, 8);
    assert.deepEqual((await f.server.loadState('alice')).state, view.state);
  } finally { f.close(); }
});

test("客服回复必须引用门店真实资料，只返回建议且不写订单或状态", async (t) => {
  const f = fixture();
  try {
    const input = await replyFixture(f);
    const before = await f.server.loadState("alice");
    let call;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      call = JSON.parse(options.body);
      return modelResponse({ action: "reply", reply: "这款浅烘咖啡礼盒268元，采用简洁包装。", reason: "根据已配置商品资料。", productIds: ["p-coffee"], grounding: [{ sourceId: "product:p-coffee", quote: "浅烘咖啡礼盒" }] });
    });
    const result = await f.server.runReplyAI("alice", input);
    assert.equal(result.action, "reply");
    assert.match(result.reply, /268元/);
    assert.equal(result.grounding, undefined);
    assert.match(call.messages[0].content, /不执行主动营销/);
    assert.match(call.messages[0].content, /自然的门店接待语气/);
    assert.match(call.messages[0].content, /先接住客人的当前问题/);
    assert.match(call.messages[0].content, /不固定重复“具体方案请店员确认”/);
    assert.match(call.messages[0].content, /不为了亲切而补写事实或将所有商品都称为美食/);
    assert.match(call.messages[0].content, /禁止编造商品、价格、库存、优惠、交付承诺或操作结果/);
    assert.match(call.messages[0].content, /action=reply时grounding必须是非空数组/);
    assert.match(call.messages[0].content, /客户明确的预算上限/);
    assert.ok(JSON.parse(call.messages[1].content).knowledge.some((source) => source.sourceId === "product:p-coffee" && source.productId === "p-coffee"));
    assert.deepEqual(await f.server.loadState("alice"), before);
  } finally { f.close(); }
});

test("退款改价、停用客户、人工接管和闭店都不调用模型", async (t) => {
  const f = fixture();
  try {
    const input = await replyFixture(f);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls += 1; throw new Error("不应调用"); });
    assert.equal((await f.server.runReplyAI("alice", { ...input, message: { ...input.message, text: "帮我退款或者改价吧" } })).action, "handoff");
    for (const change of [
      (state) => { state.replySettings.enabled = false; },
      (state) => { state.customers[0].humanTakeover = true; },
      (state) => { state.replySettings.selectedCustomerIds = []; },
      (state) => { state.replySettings.businessHours = { enabled: true, start: "00:00", end: "00:00", days: [0, 1, 2, 3, 4, 5, 6] }; },
    ]) {
      const loaded = await f.server.loadState("alice");
      change(loaded.state);
      await f.server.saveState("alice", loaded.state, loaded.revision);
      assert.equal((await f.server.runReplyAI("alice", input)).action, "handoff");
    }
    assert.equal(calls, 0);
  } finally { f.close(); }
});

test("回复缺少真实依据、虚构价格或未知商品时转人工而不返回可发送文字", async (t) => {
  const f = fixture();
  try {
    const input = await replyFixture(f);
    let mocked;
    t.mock.method(globalThis, "fetch", async () => modelResponse(mocked));
    const valid = { action: "reply", reply: "浅烘咖啡礼盒268元。", reason: "商品资料。", productIds: ["p-coffee"], grounding: [{ sourceId: "product:p-coffee", quote: "浅烘咖啡礼盒" }] };
    for (const result of [
      { ...valid, grounding: [] },
      { ...valid, grounding: [{ sourceId: "product:p-coffee", quote: "商家没有提供过的资料" }] },
      { ...valid, reply: "浅烘咖啡礼盒1元。" },
      { ...valid, productIds: ["unknown-product"] },
      { ...valid, reply: "已经退款，100%有效。" },
    ]) {
      mocked = result;
      const reply = await f.server.runReplyAI("alice", input);
      assert.equal(reply.action, "handoff");
      assert.equal(reply.reply, "");
    }
  } finally { f.close(); }
});

async function serviceReplyFixture(f) {
  const input = await replyFixture(f);
  const loaded = await f.server.loadState("alice");
  const serviceId = "verify-ai-p-2026-11-07T04-46-47-580Z-synthetic";
  loaded.state.products = [{ id: serviceId, name: "基础清洁服务_合成验证", type: "service", price: 129, description: "包含表面清洁与整理。此条资料仅用于合成验证。", faq: [{ question: "服务价格是多少？", answer: "服务价格为129元。" }], enabled: true }];
  loaded.state.replySettings.faq = [{ question: "基础清洁服务的价格是多少？", answer: "基础清洁服务价格129元，包含表面清洁与整理。" }];
  await f.server.saveState("alice", loaded.state, loaded.revision);
  return { input: { ...input, message: { ...input.message, text: "请问基础清洁服务包含什么，价格多少？" } }, serviceId };
}

test("服务与FAQ129元资料能生成有依据回复，模型明确收到资料标识、商品标识和可逐字复制的引用", async (t) => {
  const f = fixture();
  try {
    const { input, serviceId } = await serviceReplyFixture(f);
    const before = await f.server.loadState("alice");
    let selected = "faq:0";
    let selectedQuote = "基础清洁服务价格129元，包含表面清洁与整理。";
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      const messages = JSON.parse(options.body).messages;
      assert.match(messages[0].content, /sourceId必须逐字复制/);
      assert.match(messages[0].content, /不能混用/);
      assert.match(messages[0].content, /不概括、不拼接/);
      const knowledge = JSON.parse(messages[1].content).knowledge;
      const source = knowledge.find((item) => item.sourceId === selected);
      assert.ok(source, "模型输入提供与输出同名的sourceId");
      assert.ok(source.groundingQuotes.includes(selectedQuote), "模型可直接复制有效资料原文");
      assert.ok(source.text.includes(selectedQuote), "可复制引用必须真实存在于该资料");
      return modelResponse({ action: "reply", reply: "基础清洁服务价格129元，包含表面清洁与整理。", reason: "根据门店服务与FAQ资料。", productIds: source.productId ? [source.productId] : [], grounding: [{ sourceId: source.sourceId, quote: selectedQuote }] });
    });
    for (const [sourceId, quote] of [
      ["faq:0", "基础清洁服务价格129元，包含表面清洁与整理。"],
      [`product:${serviceId}`, "价格：129元"],
      [`product:${serviceId}:faq:0`, "服务价格为129元。"],
    ]) {
      selected = sourceId; selectedQuote = quote;
      const result = await f.server.runReplyAI("alice", input);
      assert.equal(result.action, "reply");
      assert.match(result.reply, /129元/);
      assert.deepEqual(result.productIds, sourceId === "faq:0" ? [] : [serviceId]);
      assert.equal(result.grounding, undefined);
    }
    assert.deepEqual(await f.server.loadState("alice"), before);
  } finally { f.close(); }
});

test("引用辅助不放宽门禁，服务ID错用、改写拼接原文、串资料或虚构价格仍转人工", async (t) => {
  const f = fixture();
  try {
    const { input, serviceId } = await serviceReplyFixture(f);
    const before = await f.server.loadState("alice");
    let selected;
    t.mock.method(globalThis, "fetch", async () => modelResponse(selected));
    const valid = { action: "reply", reply: "基础清洁服务价格129元，包含表面清洁与整理。", reason: "根据服务资料。", productIds: [serviceId], grounding: [{ sourceId: `product:${serviceId}:faq:0`, quote: "服务价格为129元。" }] };
    for (const invalid of [
      { ...valid, grounding: [] },
      { ...valid, grounding: [{ sourceId: serviceId, quote: "服务价格为129元。" }] },
      { ...valid, grounding: [{ sourceId: "faq:0", quote: "服务价格为129元。" }] },
      { ...valid, grounding: [{ sourceId: "faq:0", quote: "清洁服务收费129元，提供清洁整理。" }] },
      { ...valid, grounding: [{ sourceId: `product:${serviceId}`, quote: "基础清洁服务_合成验证价格：129元" }] },
      { ...valid, grounding: [{ sourceId: `product:${serviceId}`, quote: "包含表面清洁与整理。免费上门。" }] },
      { ...valid, productIds: [`product:${serviceId}`] },
      { ...valid, reply: "基础清洁服务价格130元。" },
    ]) {
      selected = invalid;
      const result = await f.server.runReplyAI("alice", input);
      assert.equal(result.action, "handoff");
      assert.equal(result.reply, "");
    }
    assert.deepEqual(await f.server.loadState("alice"), before);
  } finally { f.close(); }
});

test("旧回复设置缺省等待10秒，显式0、300和3600可保存，无效等待时间拒绝", async () => {
  const f = fixture();
  try {
    await replyFixture(f);
    const loaded = await f.server.loadState("alice");
    assert.equal(loaded.state.replySettings.debounceSeconds, 10);
    const legacy = structuredClone(loaded.state);
    delete legacy.replySettings.debounceSeconds;
    assert.equal(f.server.appStateSchema.parse(legacy).replySettings.debounceSeconds, 10);
    for (const seconds of [0, 60, 300, 3600]) {
      const next = structuredClone(legacy); next.replySettings.debounceSeconds = seconds;
      assert.equal(f.server.appStateSchema.parse(next).replySettings.debounceSeconds, seconds);
    }
    for (const seconds of [-1, 3601, 0.1, null, "60"]) {
      const next = structuredClone(legacy); next.replySettings.debounceSeconds = seconds;
      assert.equal(f.server.appStateSchema.safeParse(next).success, false);
    }
    const saved = structuredClone(loaded.state); saved.replySettings.debounceSeconds = 300;
    const response = await f.asUser("alice", () => f.stateRoute.POST(post("state", { state: saved, revision: loaded.revision })));
    assert.equal(response.status, 200);
    assert.equal((await f.server.loadState("alice")).state.replySettings.debounceSeconds, 300);
  } finally { f.close(); }
});

test("合并批次保留每条新消息原生证据，显式空context不回退客户旧历史", async (t) => {
  const f = fixture();
  try {
    const input = await replyFixture(f);
    const messages = [{ id: "new-one", nativeMessageId: "10001", text: "咖啡礼盒多少钱？", date: input.message.date }, { id: "new-two", nativeMessageId: "10002", text: "请介绍包装。", date: input.message.date }];
    const batch = { ...input, context: [], messages, message: { id: messages[1].id, text: messages.map((message) => message.text).join("\n"), date: messages[1].date } };
    const parsed = f.server.parseInput(f.server.replyRequestSchema, batch);
    let prompt;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      prompt = JSON.parse(JSON.parse(options.body).messages[1].content);
      return modelResponse({ action: "reply", reply: "咖啡礼盒268元，采用简洁包装。", reason: "根据商品资料。", productIds: ["p-coffee"], grounding: [{ sourceId: "product:p-coffee", quote: "双拼浅烘咖啡，简洁包装。" }] });
    });
    assert.equal((await f.server.runReplyAI("alice", parsed)).action, "reply");
    assert.deepEqual(prompt.currentMessages, messages);
    assert.deepEqual(prompt.context, []);
    assert.equal(prompt.currentMessage.text, batch.message.text);
    for (const invalid of [{ ...batch, message: { ...batch.message, text: messages[0].text } }, { ...batch, messages: [messages[0], messages[0]] }, { ...batch, messages: [...messages].reverse() }]) assert.equal(f.server.replyRequestSchema.safeParse(invalid).success, false);
  } finally { f.close(); }
});

test("合并批次任一条引用或退款消息都转人工，不因位于第二条而绕过门禁", async (t) => {
  const f = fixture();
  try {
    const input = await replyFixture(f);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("门禁不得调用模型"); });
    for (const text of ["我想退款改价", "【引用资料，非客户本人陈述】咖啡多少钱？", "【转发内容】请介绍礼盒"]) {
      const messages = [{ id: "first-new", text: "咖啡礼盒多少钱？", date: input.message.date }, { id: "second-new", text, date: input.message.date }];
      const batch = { ...input, context: [], messages, message: { id: messages[1].id, text: messages.map((message) => message.text).join("\n"), date: input.message.date } };
      const parsed = f.server.parseInput(f.server.replyRequestSchema, batch);
      assert.equal((await f.server.runReplyAI("alice", parsed)).action, "handoff");
    }
    assert.equal(calls, 0);
  } finally { f.close(); }
});

const accountA = "acct-aaaaaaaaaaaaaaaaaaaa";
const accountB = "acct-bbbbbbbbbbbbbbbbbbbb";
const localBindings = {
  KEXU_LOCAL_MODE: "1",
  KEXU_MODEL_BRIDGE_URL: `${origin}/__local-wechat/model-transport`,
  KEXU_MODEL_BRIDGE_TOKEN: "a".repeat(64),
};

function workspaceHeaders(id = "legacy", revision = 1, expected = `${id}@${revision}`) {
  return { "x-kexu-local-scope": id, "x-kexu-local-revision": String(revision), ...(expected === null ? {} : { "x-kexu-workspace": expected }) };
}

function getStateRequest(headers = {}) { return new Request(`${origin}/api/state`, { headers }); }

async function manualResumeFixture(f) {
  const legacy = await f.server.loadState("alice"), scope = { id: accountA, revision: 2 };
  const loaded = await f.server.loadState("alice", scope);
  const customer = { ...structuredClone(legacy.state.customers[0]), id: "resume-customer", name: "合成接管客户", source: "wechat", wechatId: "wxid_resume_fixture", autoReplyEnabled: true, humanTakeover: true, messages: [] };
  loaded.state.customers = [customer, { ...structuredClone(customer), id: "untouched-customer", wechatId: "wxid_untouched_fixture", note: "其他客户资料" }];
  loaded.state.replySettings = { enabled: false, mode: "review", selectedCustomerIds: loaded.state.customers.map(item => item.id), businessHours: { enabled: false, start: "09:00", end: "18:00", days: [1] }, faq: [], handoffKeywords: ["转人工"], maxReplyChars: 300, cooldownSeconds: 30, debounceSeconds: 10, prompt: "保留规则" };
  const revision = await f.server.saveState("alice", loaded.state, loaded.revision, scope);
  return { scope, headers: { ...workspaceHeaders(accountA, 2), "x-kexu-local": "1" }, body: { customerId: customer.id, wechatId: customer.wechatId, expectedRevision: revision } };
}

test("人工恢复接口只清除当前客户接管，CAS保存且重复恢复不增加版本", async () => {
  const f = fixture(localBindings);
  try {
    const input = await manualResumeFixture(f), before = await f.server.loadState("alice", input.scope);
    const legacyBefore = await f.server.loadState("alice");
    const response = await f.asUser("alice", () => f.manualResumeRoute.POST(post("reply/manual-resume", input.body, input.headers)));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { revision: before.revision + 1, customerId: input.body.customerId, wechatId: input.body.wechatId, humanTakeover: false });
    const saved = await f.server.loadState("alice", input.scope), expected = structuredClone(before.state);
    expected.customers[0].humanTakeover = false;
    assert.deepEqual(saved.state, expected);
    assert.deepEqual(await f.server.loadState("alice"), legacyBefore);
    const repeated = await f.asUser("alice", () => f.manualResumeRoute.POST(post("reply/manual-resume", { ...input.body, expectedRevision: saved.revision }, input.headers)));
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).revision, saved.revision);
    assert.deepEqual(await f.server.loadState("alice", input.scope), saved);
  } finally { f.close(); }
});

test("人工恢复接口拒绝云端、未绑定账号、跨源、过期工作区和缺少本机标识", async () => {
  const cloud = fixture();
  try {
    const response = await cloud.asUser("alice", () => cloud.manualResumeRoute.POST(post("reply/manual-resume", { customerId: "resume-customer", wechatId: "wxid_resume_fixture", expectedRevision: 0 }, { ...workspaceHeaders(accountA), "x-kexu-local": "1" })));
    assert.equal(response.status, 403);
    assert.equal(cloud.sqlite.prepare("SELECT COUNT(*) AS count FROM user_states").get().count, 0);
  } finally { cloud.close(); }
  const f = fixture(localBindings);
  try {
    const input = await manualResumeFixture(f), before = await f.server.loadState("alice", input.scope);
    const cases = [
      [{ ...workspaceHeaders(), "x-kexu-local": "1" }, 403],
      [{ ...input.headers, origin: "https://elsewhere.invalid" }, 403],
      [{ ...workspaceHeaders(accountA, 2, `${accountA}@1`), "x-kexu-local": "1" }, 409],
      [{ ...workspaceHeaders(accountB, 2, `${accountA}@2`), "x-kexu-local": "1" }, 409],
      [workspaceHeaders(accountA, 2), 403],
    ];
    for (const [headers, status] of cases) assert.equal((await f.asUser("alice", () => f.manualResumeRoute.POST(post("reply/manual-resume", input.body, headers)))).status, status);
    assert.equal((await f.manualResumeRoute.POST(post("reply/manual-resume", input.body, input.headers))).status, 401);
    assert.deepEqual(await f.server.loadState("alice", input.scope), before);
  } finally { f.close(); }
});

test("人工恢复接口拒绝旧数据版本、演示客户、停用、未选择及变更后的微信映射", async () => {
  const cases = [
    ["旧数据版本", () => {}, body => { body.expectedRevision -= 1; }],
    ["演示客户", state => { state.customers[0].source = "demo"; }],
    ["未启用客户", state => { state.customers[0].autoReplyEnabled = false; }],
    ["未选择客户", state => { state.replySettings.selectedCustomerIds = ["untouched-customer"]; }],
    ["微信号已变更", state => { state.customers[0].wechatId = "wxid_changed_fixture"; }],
    ["微信号重复", state => { state.customers[1].wechatId = state.customers[0].wechatId; }],
    ["客户已移除", state => { state.customers.shift(); state.replySettings.selectedCustomerIds = ["untouched-customer"]; }],
  ];
  for (const [label, changeState, changeBody] of cases) {
    const f = fixture(localBindings);
    try {
      const input = await manualResumeFixture(f), current = await f.server.loadState("alice", input.scope);
      changeState(current.state);
      input.body.expectedRevision = await f.server.saveState("alice", current.state, current.revision, input.scope);
      changeBody?.(input.body);
      const before = await f.server.loadState("alice", input.scope);
      const response = await f.asUser("alice", () => f.manualResumeRoute.POST(post("reply/manual-resume", input.body, input.headers)));
      assert.equal(response.status, 409, label);
      assert.deepEqual(await f.server.loadState("alice", input.scope), before, label);
    } finally { f.close(); }
  }
});

test("云端忽略伪造的本地账号范围和期望令牌，维持原有数据及API协议", async () => {
  const f = fixture();
  try {
    const headers = workspaceHeaders(accountA, 3, "forged-token");
    const loaded = await f.asUser("alice", async () => (await f.stateRoute.GET(getStateRequest(headers))).json());
    assert.equal(Object.hasOwn(loaded, "workspaceToken"), false);
    assert.equal(loaded.state.demo, true);
    assert.deepEqual(await f.server.loadState("alice", { id: accountB, revision: 1 }), await f.server.loadState("alice"));
    const response = await f.asUser("alice", () => f.stateRoute.POST(post("state", { state: loaded.state, revision: loaded.revision }, headers)));
    assert.equal(response.status, 200);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM user_states").get().count, 1);
    assert.equal((await f.asUser("alice", () => f.secretRoute.POST(post("secret", { remove: true }, headers)))).status, 200);
  } finally { f.close(); }
});

test("本地状态必须有有效的权威账号请求头，GET可不带期望令牌且不回退写入旧账号", async () => {
  const f = fixture(localBindings);
  try {
    assert.equal((await f.stateRoute.GET(getStateRequest(workspaceHeaders()))).status, 401);
    for (const headers of [{}, workspaceHeaders("arbitrary-user"), workspaceHeaders(accountA, 0), workspaceHeaders(accountA, "01"), workspaceHeaders(accountA, "9007199254740992"), workspaceHeaders("acct-AAAAAAAAAAAAAAAAAAAA")]) {
      const response = await f.asUser("alice", () => f.stateRoute.GET(getStateRequest(headers)));
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "LOCAL_WORKSPACE_UNAVAILABLE");
    }
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM user_states").get().count, 0);
    const response = await f.asUser("alice", () => f.stateRoute.GET(getStateRequest(workspaceHeaders(accountA, 2, null))));
    assert.equal(response.status, 200);
    const loaded = await response.json();
    assert.equal(loaded.workspaceToken, `${accountA}@2`);
    assert.equal(loaded.state.demo, false);
    assert.deepEqual(loaded.state.customers, []);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM user_states").get().count, 1);
    assert.equal(f.sqlite.prepare("SELECT user_id FROM user_states").get().user_id, `alice:wechat:${accountA}`);
  } finally { f.close(); }
});

test("微信账号分别保存业务快照，新账号只继承门店和模型设置，旧数据和共享密钥保留", async () => {
  const f = fixture(localBindings);
  try {
    const legacy = await f.server.loadState("alice");
    legacy.state.settings.storeName = "刚配置好的门店";
    legacy.state.settings.ai = { ...legacy.state.settings.ai, baseUrl: "https://api.openai.com/v1", model: "shared-provider-model" };
    legacy.state.products = [{ id: "legacy-product", name: "原账号商品", type: "product", price: 15, description: "原账号资料", faq: [], enabled: true }];
    await f.server.saveState("alice", legacy.state, legacy.revision);
    await f.server.storeKey("alice", "sk-unit-shared-local-key");
    const preserved = await f.server.loadState("alice");
    const scopeA = { id: accountA, revision: 1 };
    const [a, concurrent] = await Promise.all([f.server.loadState("alice", scopeA), f.server.loadState("alice", scopeA)]);
    assert.deepEqual(a, concurrent);
    assert.deepEqual(a.state.settings, preserved.state.settings);
    for (const key of ["customers", "orders", "tasks", "imports", "products"]) assert.deepEqual(a.state[key], []);
    assert.equal(a.state.demo, false);
    assert.equal(a.state.replySettings, undefined);
    a.state.customers = [{ ...structuredClone(legacy.state.customers[0]), id: "account-a-customer", source: "wechat" }];
    await f.server.saveState("alice", a.state, 0, scopeA);
    const b = await f.server.loadState("alice", { id: accountB, revision: 2 });
    assert.deepEqual(b.state.customers, []);
    assert.deepEqual(await f.server.loadState("alice"), preserved);
    assert.deepEqual(await f.server.loadState("alice", { id: "legacy", revision: 3 }), preserved);
    const returnedA = await f.asUser("alice", async () => (await f.stateRoute.GET(getStateRequest(workspaceHeaders(accountA, 4, null)))).json());
    assert.equal(returnedA.workspaceToken, `${accountA}@4`);
    assert.equal(returnedA.state.customers[0].id, "account-a-customer");
    assert.equal(returnedA.hasApiKey, true);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM user_secrets").get().count, 1);
    assert.equal(f.sqlite.prepare("SELECT user_id FROM user_secrets").get().user_id, "alice");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM user_states").get().count, 3);
  } finally { f.close(); }
});

test("换号后四个POST均先拒绝旧页面或缺失令牌，模型、状态和共享密钥不会被操作", async (t) => {
  const f = fixture(localBindings);
  try {
    const { state } = await f.server.loadState("alice");
    await f.server.storeKey("alice", "sk-unit-shared-local-key");
    const before = f.sqlite.prepare("SELECT * FROM user_secrets WHERE user_id = ?").get("alice");
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls += 1; throw new Error("旧页面不得调用模型"); });
    const cases = [
      ["state", f.stateRoute, { state, revision: 0 }],
      ["secret", f.secretRoute, { remove: true }],
      ["ai", f.aiRoute, { action: "test" }],
      ["reply", f.replyRoute, { customerId: state.customers[0].id, message: { id: "new-message", text: "请问商品价格", date: new Date().toISOString() } }],
    ];
    for (const expected of [null, `${accountA}@1`, `${accountB}@1`, `${accountB}@02`, `${accountB} @2`]) {
      for (const [endpoint, route, body] of cases) {
        const response = await f.asUser("alice", () => route.POST(post(endpoint, body, workspaceHeaders(accountB, 2, expected))));
        assert.equal(response.status, 409, `${endpoint}: ${expected}`);
        const error = await response.json();
        assert.equal(error.code, "WORKSPACE_CHANGED");
        assert.match(error.error, /微信账号已切换/);
      }
    }
    assert.equal(calls, 0);
    assert.deepEqual(f.sqlite.prepare("SELECT * FROM user_secrets WHERE user_id = ?").get("alice"), before);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM user_states").get().count, 1);
  } finally { f.close(); }
});

test("同一账号重新连接后旧版本令牌失效，正确令牌保存且D1并发冲突不混淆账号切换", async () => {
  const f = fixture(localBindings);
  try {
    const loaded = await f.asUser("alice", async () => (await f.stateRoute.GET(getStateRequest(workspaceHeaders(accountA, 7, null)))).json());
    const body = { state: loaded.state, revision: loaded.revision };
    const stale = await f.asUser("alice", () => f.stateRoute.POST(post("state", body, workspaceHeaders(accountA, 7, `${accountA}@6`))));
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "WORKSPACE_CHANGED");
    const good = await f.asUser("alice", () => f.stateRoute.POST(post("state", body, workspaceHeaders(accountA, 7))));
    assert.equal(good.status, 200);
    assert.equal((await good.json()).revision, 1);
    const conflict = await f.asUser("alice", () => f.stateRoute.POST(post("state", body, workspaceHeaders(accountA, 7))));
    assert.equal(conflict.status, 409);
    const error = await conflict.json();
    assert.equal(error.revision, 1);
    assert.equal(error.code, undefined);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM user_states").get().count, 1);
  } finally { f.close(); }
});

test("本地AI和客服仅加载当前微信账号，使用共享密钥并通过受保护的本机桥请求模型", async (t) => {
  const f = fixture(localBindings);
  try {
    const input = await replyFixture(f);
    const legacy = await f.server.loadState("alice");
    const scope = { id: accountA, revision: 2 };
    const account = await f.server.loadState("alice", scope);
    account.state.settings.ai.model = "current-account-model";
    account.state.customers = [{ ...structuredClone(legacy.state.customers[0]), id: "current-only-customer", name: "当前账号客户" }];
    account.state.products = legacy.state.products;
    account.state.replySettings = { ...legacy.state.replySettings, selectedCustomerIds: ["current-only-customer"] };
    await f.server.saveState("alice", account.state, 0, scope);
    const calls = [];
    let result = { summary: "当前账号客户的明确需求。" };
    t.mock.method(globalThis, "fetch", async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return modelResponse(result); });
    const ai = await f.asUser("alice", () => f.aiRoute.POST(post("ai", { action: "profile", customerId: "current-only-customer" }, workspaceHeaders(accountA, 2))));
    assert.equal(ai.status, 200);
    assert.deepEqual(await ai.json(), result);
    assert.equal(calls[0].url, localBindings.KEXU_MODEL_BRIDGE_URL);
    assert.equal(calls[0].options.redirect, "manual");
    assert.equal(calls[0].options.headers.Authorization, "Bearer sk-unit-only-0123456789");
    assert.equal(calls[0].options.headers["X-Kexu-Model-Token"], localBindings.KEXU_MODEL_BRIDGE_TOKEN);
    assert.equal(calls[0].options.headers["X-Kexu-Model-Url"], "https://api.deepseek.com/chat/completions");
    assert.equal(calls[0].body.model, "current-account-model");
    assert.equal(JSON.parse(calls[0].body.messages[1].content).customer.name, "当前账号客户");
    result = { action: "reply", reply: "浅烘咖啡礼盒268元。", reason: "商品资料。", productIds: ["p-coffee"], grounding: [{ sourceId: "product:p-coffee", quote: "浅烘咖啡礼盒" }] };
    const reply = await f.asUser("alice", () => f.replyRoute.POST(post("reply", { ...input, customerId: "current-only-customer" }, workspaceHeaders(accountA, 2))));
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).action, "reply");
    assert.equal(calls.length, 2);
    const oldCustomer = await f.asUser("alice", () => f.aiRoute.POST(post("ai", { action: "profile", customerId: input.customerId }, workspaceHeaders(accountA, 2))));
    assert.equal(oldCustomer.status, 404);
    assert.equal(calls.length, 2);
    assert.deepEqual(await f.server.loadState("alice"), legacy);
    const secret = await f.asUser("alice", () => f.secretRoute.POST(post("secret", { apiKey: "sk-unit-shared-replacement" }, workspaceHeaders(accountA, 2))));
    assert.equal(secret.status, 200);
    const b = await f.asUser("alice", async () => (await f.stateRoute.GET(getStateRequest(workspaceHeaders(accountB, 3, null)))).json());
    assert.equal(b.hasApiKey, true);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM user_secrets").get().count, 1);
  } finally { f.close(); }
});

test("模型所有3xx都拒绝且只请求一次，绝不跟随Location转发密钥", async (t) => {
  const f = fixture();
  try {
    await f.server.storeKey("alice", "sk-unit-only-0123456789");
    let status = 301;
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, options) => { calls.push({ url, options }); return new Response(null, { status, headers: { Location: "https://untrusted.example/collect-key" } }); });
    for (status of [300, 301, 302, 303, 304, 305, 307, 308, 399]) {
      const before = calls.length;
      await assert.rejects(() => f.server.runAI("alice", { action: "test" }), (error) => error.status === 502 && /重定向/.test(error.message));
      assert.equal(calls.length, before + 1);
      assert.equal(calls.at(-1).url, "https://api.deepseek.com/chat/completions");
      assert.equal(calls.at(-1).options.redirect, "manual");
    }
  } finally { f.close(); }
});

test("本机模型桥只接受回环固定路径和服务端令牌，失败提示不暴露上游原始错误", async (t) => {
  const f = fixture(localBindings);
  try {
    await f.server.storeKey("alice", "sk-unit-only-0123456789");
    let reason = "proxy_unreachable";
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls += 1; return new Response("private-upstream-error sk-unit-only-0123456789", { status: 502, headers: { "X-Kexu-Transport-Error": reason } }); });
    const hints = { proxy_unreachable: /代理无法连接/, upstream_unreachable: /网络不可达/, tls: /证书校验失败/, config: /代理配置无效/, invalid_response: /不兼容或过大/, unexpected: /网络服务暂时不可用/ };
    for (const [error, hint] of Object.entries(hints)) {
      reason = error;
      await assert.rejects(() => f.server.runAI("alice", { action: "test" }), (error) => error.status === 502 && hint.test(error.message) && !/private-upstream-error|sk-unit-only/.test(error.message));
    }
    const baseline = calls;
    for (const url of ["https://proxy.example/__local-wechat/model-transport", "http://localhost:3000/__local-wechat/model-transport", `${origin}/wrong-path`, `${origin}/__local-wechat/model-transport?token=x`, ""]) {
      f.environment.KEXU_MODEL_BRIDGE_URL = url;
      await assert.rejects(() => f.server.runAI("alice", { action: "test" }), (error) => error.status === 503);
    }
    f.environment.KEXU_MODEL_BRIDGE_URL = localBindings.KEXU_MODEL_BRIDGE_URL;
    f.environment.KEXU_MODEL_BRIDGE_TOKEN = "invalid";
    await assert.rejects(() => f.server.runAI("alice", { action: "test" }), (error) => error.status === 503);
    assert.equal(calls, baseline);
  } finally { f.close(); }
});

test("真实Workerd执行生产模型请求：云端和本机桥均兼容manual且不会跟随重定向", { timeout: 45_000 }, async () => {
  const [{ Miniflare }, { build }] = await Promise.all([import("miniflare"), import("esbuild")]);
  const bundle = await build({
    absWorkingDir: project, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers"],
    stdin: { contents: `import { POST } from "./app/api/ai/route.ts"; import { storeKey } from "./lib/server.ts"; export default { async fetch(request) { await storeKey("workerd-synthetic-user", "sk-workerd-synthetic-test-only"); return POST(request); } };`, resolveDir: project, sourcefile: "workerd-protocol-test.ts" },
    plugins: [{ name: "synthetic-auth", setup(builder) {
      builder.onResolve({ filter: /^@\/app\/chatgpt-auth$/ }, () => ({ path: "auth", namespace: "synthetic-auth" }));
      builder.onLoad({ filter: /.*/, namespace: "synthetic-auth" }, () => ({ contents: 'export async function getChatGPTUser() { return { userId: "workerd-synthetic-user" }; }', loader: "js" }));
    } }],
  });
  for (const local of [false, true]) {
    let upstreamStatus = 200;
    const calls = [];
    const mf = new Miniflare({
      modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-01-01", compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "model-protocol-test" }, bindings: { APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"), ...(local ? localBindings : {}) },
      outboundService: async (request) => {
        calls.push({ url: request.url, authorization: request.headers.get("Authorization"), bridgeToken: request.headers.get("X-Kexu-Model-Token"), modelUrl: request.headers.get("X-Kexu-Model-Url"), body: await request.json() });
        if (upstreamStatus !== 200) return new Response(null, { status: upstreamStatus, headers: { Location: "https://untrusted.example/collect-key" } });
        return modelResponse({ ok: true });
      },
    });
    try {
      const db = await mf.getD1Database("DB");
      for (const filename of readdirSync(path.join(project, "drizzle")).filter((name) => name.endsWith(".sql")).sort()) {
        const statements = readFileSync(path.join(project, "drizzle", filename), "utf8").split("--> statement-breakpoint").map((sql) => sql.trim()).filter(Boolean);
        await db.batch(statements.map((sql) => db.prepare(sql)));
      }
      const request = () => mf.dispatchFetch(`${origin}/api/ai`, { method: "POST", headers: { origin, "content-type": "application/json", ...(local ? workspaceHeaders("legacy", 1) : {}) }, body: JSON.stringify({ action: "test" }) });
      const success = await request();
      assert.equal(success.status, 200, `${local ? "local" : "cloud"}: ${await success.clone().text()}`);
      assert.match((await success.json()).summary, /连接成功/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, local ? localBindings.KEXU_MODEL_BRIDGE_URL : "https://api.deepseek.com/chat/completions");
      assert.equal(calls[0].authorization, "Bearer sk-workerd-synthetic-test-only");
      assert.equal(calls[0].bridgeToken, local ? localBindings.KEXU_MODEL_BRIDGE_TOKEN : null);
      assert.equal(calls[0].modelUrl, local ? "https://api.deepseek.com/chat/completions" : null);
      assert.equal(calls[0].body.stream, false);
      for (upstreamStatus of [301, 302, 307, 308]) {
        const before = calls.length;
        const rejected = await request();
        assert.equal(rejected.status, 502);
        assert.match((await rejected.json()).error, /重定向/);
        assert.equal(calls.length, before + 1);
      }
    } finally { await mf.dispose(); }
  }
});


test("自动建档接口拒绝云端、未绑定账号、跨源和过期工作区", async () => {
  const body = { contacts: [{ wechatId: "wxid_new_fixture", name: "新好友" }] };
  const cloud = fixture();
  try { assert.equal((await cloud.asUser("alice", () => cloud.enrollRoute.POST(post("reply/enroll", body, { ...workspaceHeaders(accountA), "x-kexu-local": "1" })))).status, 403); }
  finally { cloud.close(); }
  const local = fixture(localBindings);
  try {
    for (const headers of [workspaceHeaders(), { ...workspaceHeaders(accountA), origin: "https://elsewhere.invalid", "x-kexu-local": "1" }, { ...workspaceHeaders(accountA, 2, `${accountA}@1`), "x-kexu-local": "1" }, workspaceHeaders(accountA)]) {
      assert.ok([403, 409].includes((await local.asUser("alice", () => local.enrollRoute.POST(post("reply/enroll", body, headers)))).status));
    }
    assert.equal((await local.enrollRoute.POST(post("reply/enroll", body))).status, 401);
  } finally { local.close(); }
});

test("新私聊在正确账号幂等建档，已取消选择和人工接管客户不重新启用", async () => {
  const f = fixture(localBindings), scope = { id: accountA, revision: 1 };
  try {
    await replyFixture(f);
    const legacy = await f.server.loadState("alice"), current = await f.server.loadState("alice", scope);
    current.state.replySettings = { ...legacy.state.replySettings, autoEnrollNewContacts: true, selectedCustomerIds: [] };
    await f.server.saveState("alice", current.state, current.revision, scope);
    const headers = { ...workspaceHeaders(accountA), "x-kexu-local": "1" }, body = { contacts: [{ wechatId: "wxid_new_fixture", name: "新好友", date: "2026-11-07T01:00:00Z" }] };
    const response = await f.asUser("alice", () => f.enrollRoute.POST(post("reply/enroll", body, headers)));
    assert.equal(response.status, 200);const first = await response.json();assert.equal(first.addedCustomerIds.length, 1);
    assert.equal(first.config.settings.autoEnrollNewContacts, true);
    let saved = await f.server.loadState("alice", scope);
    assert.equal(saved.state.customers[0].stage, "新客户");assert.equal(saved.state.customers[0].messages.length, 0);
    const repeated = await f.asUser("alice", async () => (await f.enrollRoute.POST(post("reply/enroll", body, headers))).json());
    assert.deepEqual(repeated.addedCustomerIds, []);assert.equal(repeated.revision, first.revision);
    saved.state.customers[0].autoReplyEnabled = false;saved.state.customers[0].humanTakeover = true;saved.state.replySettings.selectedCustomerIds = [];
    await f.server.saveState("alice", saved.state, saved.revision, scope);
    const again = await f.asUser("alice", async () => (await f.enrollRoute.POST(post("reply/enroll", body, headers))).json());
    assert.equal(again.config.customers[0].humanTakeover, true);assert.deepEqual(again.config.settings.selectedCustomerIds, []);
    assert.deepEqual(await f.server.loadState("alice"), legacy);
    assert.equal((await f.server.loadState("alice", { id: accountB, revision: 2 })).state.customers.length, 0);
  } finally { f.close(); }
});

test("未启用新私聊、非法账号和超量建档请求不会扩展客户范围", async () => {
  const f = fixture(localBindings), scope = { id: accountA, revision: 1 }, headers = { ...workspaceHeaders(accountA), "x-kexu-local": "1" };
  try {
    const body = { contacts: [{ wechatId: "wxid_new_fixture", name: "新好友" }] };
    assert.equal((await f.asUser("alice", () => f.enrollRoute.POST(post("reply/enroll", body, headers)))).status, 409);
    await replyFixture(f);const legacy = await f.server.loadState("alice"), current = await f.server.loadState("alice", scope);
    current.state.replySettings = { ...legacy.state.replySettings, autoEnrollNewContacts: false, selectedCustomerIds: [] };
    await f.server.saveState("alice", current.state, current.revision, scope);
    assert.equal((await f.asUser("alice", () => f.enrollRoute.POST(post("reply/enroll", body, headers)))).status, 409);
    for (const wechatId of ["gh_fixture", "fixture@chatroom", "filehelper", "weixin"]) assert.equal((await f.asUser("alice", () => f.enrollRoute.POST(post("reply/enroll", { contacts: [{ wechatId, name: "排除" }] }, headers)))).status, 400);
    const tooMany = { contacts: Array.from({ length: 21 }, (_, i) => ({ wechatId: `wxid_fixture_${i}`, name: "客户" })) };
    assert.equal((await f.asUser("alice", () => f.enrollRoute.POST(post("reply/enroll", tooMany, headers)))).status, 400);
    assert.equal((await f.server.loadState("alice", scope)).state.customers.length, 0);
  } finally { f.close(); }
});


test("直接填写的店铺电话地址服务内容可作为真实回复依据且新字段可持久化", async (t) => {
  const f = fixture();
  try {
    const input = await replyFixture(f), current = await f.server.loadState("alice");
    current.state.replySettings.storeInfo = { contactName: "合成店长", phone: "010-55550000", address: "测试路88号", serviceContent: "提供预约体验，基础体验129元。" };
    current.state.products[0].needsRestock = false;
    current.state.products[0].stock = 0;
    current.state.products[0].restockThreshold = 5;
    current.state.products.push({ ...current.state.products[0], id: 'stock-unknown', stock: null });
    current.state.products.push({ ...current.state.products[0], id: 'service-with-unused-stock', type: 'service', stock: 0, needsRestock: true });
    current.state.exports = [{ id: "export-fixture", fileName: "合成导出.json", date: "2026-11-07T01:00:00Z", kind: "json", customerCount: current.state.customers.length, messageCount: 0 }];
    await f.server.saveState("alice", f.server.appStateSchema.parse(current.state), current.revision);
    let knowledge;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      knowledge = JSON.parse(JSON.parse(options.body).messages[1].content).knowledge;
      return modelResponse({ action: "reply", reply: "本店位于测试路88号，可拨打010-55550000预约。", reason: "店铺基础信息。", productIds: [], grounding: [{ sourceId: "store:address", quote: "店铺地址：测试路88号" }, { sourceId: "store:phone", quote: "店铺电话：010-55550000" }] });
    });
    const result = await f.server.runReplyAI("alice", input);
    assert.equal(result.action, "reply");
    assert.ok(knowledge.some(source => source.sourceId === "store:services" && source.text.includes("129元")));
    assert.ok(knowledge.some(source => source.sourceId === "store:contact" && source.text === "店铺联系人：合成店长"));
    assert.ok(knowledge.some(source => source.sourceId === "product:p-coffee" && source.text.includes("待补货")));
    assert.ok(knowledge.some(source => source.sourceId === "product:p-coffee" && source.text.includes("库存量：0")));
    assert.ok(knowledge.some(source => source.sourceId === "product:stock-unknown" && source.text.includes("库存量：未提供，需人工确认") && !source.text.includes("待补货")));
    assert.ok(knowledge.some(source => source.sourceId === "product:service-with-unused-stock" && !source.text.includes("库存量") && !source.text.includes("待补货")));
    const saved = await f.server.loadState("alice");
    assert.deepEqual(saved.state.replySettings.storeInfo, current.state.replySettings.storeInfo);
    assert.equal(saved.state.products[0].needsRestock, false);
    assert.equal(saved.state.products[0].stock, 0);
    assert.equal(saved.state.products[0].restockThreshold, 5);
    assert.equal(saved.state.exports[0].fileName, "合成导出.json");
  } finally { f.close(); }
});


test("句号结合已回答上下文忽略，首次含糊消息澄清，不调用模型或随机报商品价", async (t) => {
  const f=fixture();
  try {
    const input=await replyFixture(f);let calls=0;
    t.mock.method(globalThis,"fetch",async()=>{calls++;return modelResponse({action:"reply",reply:"面包10元。",reason:"错误示例",productIds:[]});});
    const message={...input.message,text:"。"};
    const ignored=await f.server.runReplyAI("alice",{...input,message,context:[{sender:"merchant",text:"浅烘咖啡礼盒268元。",date:"2026-11-07T09:00:00Z"}]});
    assert.equal(ignored.action,"ignore");assert.equal(ignored.reply,"");
    const unclear=await f.server.runReplyAI("alice",{...input,message,context:[]});
    assert.equal(unclear.action,"clarify");assert.equal(unclear.reply,'您想了解哪一款？告诉我商品或服务的名称，我来为您介绍。');assert.doesNotMatch(unclear.reply,/10元|268元/);
    const reference=await f.server.runReplyAI("alice",{...input,message:{...message,text:"这个多少钱？"},context:[]});
    assert.equal(reference.action,"clarify");assert.equal(reference.reply,unclear.reply);assert.equal(calls,0);
  }finally{f.close();}
});

test("省略问题可承接唯一商品上下文，模型ignore与clarify不携带虚构报价", async(t)=>{
  const f=fixture();
  try{
    const input=await replyFixture(f);let result={action:"reply",reply:"浅烘咖啡礼盒268元。",reason:"上文唯一商品",productIds:["p-coffee"],grounding:[{sourceId:"product:p-coffee",quote:"浅烘咖啡礼盒"}]};
    t.mock.method(globalThis,"fetch",async()=>modelResponse(result));
    const answer=await f.server.runReplyAI("alice",{...input,message:{...input.message,text:"那多少钱？"},context:[{sender:"customer",text:"我想了解浅烘咖啡礼盒。",date:"2026-11-07T09:00:00Z"}]});
    assert.equal(answer.action,"reply");assert.match(answer.reply,/268元/);
    result={action:"ignore",reply:"错误的额外报价999元",reason:"对话已结束",productIds:[],grounding:[]};
    const ignored=await f.server.runReplyAI("alice",{...input,message:{...input.message,text:"我了解了，稍后再联系。"}});assert.equal(ignored.action,"ignore");assert.equal(ignored.reply,"");
    result={action:"clarify",reply:"虚构商品999元",reason:"指代不明确",productIds:[],grounding:[]};
    const clarified=await f.server.runReplyAI("alice",{...input,message:{...input.message,text:"我想看看合适的。"}});assert.equal(clarified.action,"clarify");assert.equal(clarified.reply,'您想了解哪一款？告诉我商品或服务的名称，我来为您介绍。');assert.doesNotMatch(clarified.reply,/999/);
  }finally{f.close();}
});

test("普通资料不足返回固定确认说明，忽略模型编造的保质期与价格，敏感请求仍转人工", async(t)=>{
  const f=fixture();
  try{
    const input=await replyFixture(f);let calls=0;
    t.mock.method(globalThis,"fetch",async(_url,options)=>{
      calls++;
      const prompt=JSON.parse(options.body).messages[0].content;
      assert.match(prompt,/clarificationKind=missing_knowledge/);
      return modelResponse({action:"clarify",clarificationKind:"missing_knowledge",reply:"保质期999天，额外收费999元。",reason:"资料未提供保质期",productIds:[],grounding:[]});
    });
    const response=await f.server.runReplyAI("alice",{...input,message:{...input.message,text:"浅烘咖啡礼盒保质期多久？"}});
    assert.equal(response.action,"clarify");
    assert.equal(response.reply,'这个细节我还不太确定，需要请店员核实一下。您还想了解些什么？');
    assert.doesNotMatch(response.reply,/999|保质期.*天/);
    assert.deepEqual(response.productIds,[]);
    const sensitive=await f.server.runReplyAI("alice",{...input,message:{...input.message,text:"浅烘咖啡礼盒帮我退款。"}});
    assert.equal(sensitive.action,"handoff");
    assert.equal(calls,1);
  }finally{f.close();}
});


async function catalogReplyFixture(f) {
  const input = await replyFixture(f), loaded = await f.server.loadState('alice');
  loaded.state.customers.find(customer => customer.id === input.customerId).source = 'manual';
  const state = f.catalog.createCompetitionDemo(loaded.state, new Date('2026-11-07T09:00:00Z'));
  state.products = state.products.filter(product => product.id !== 'p-coffee');
  state.products.unshift({ id: 'catalog-bread', name: '面包', type: 'product', price: 10, stock: 12, ...f.catalog.DEMO_BREAD_DETAILS, enabled: true });
  state.products.push({ id: 'catalog-hidden', name: '停用样品', type: 'product', price: 1, description: '已停用，不能推荐。', faq: [], enabled: false });
  await f.server.saveState('alice', state, loaded.revision);
  return input;
}

test('目录常问直接读取23项已启用资料，最多展示6项，不调用模型或改写状态', async t => {
  const f = fixture();
  try {
    const input = await catalogReplyFixture(f);
    await f.asUser('alice', () => f.secretRoute.POST(post('secret', { remove: true })));
    const before = await f.server.loadState('alice');
    t.mock.method(globalThis, 'fetch', async () => { throw Error('目录直答不应请求模型'); });
    for (const text of ['还有什么其他产品', '你们卖什么？', '有哪些商品？', '有什么服务？', '推荐几款']) {
      const result = await f.server.runReplyAI('alice', { ...input, message: { ...input.message, text } });
      assert.equal(result.action, 'reply', text);
      assert.ok(result.reply.length <= before.state.replySettings.maxReplyChars, text);
      assert.ok(result.productIds.length > 0 && result.productIds.length <= 6, text);
      assert.doesNotMatch(result.reply, /停用样品|免费|已预留/);
      const selected = result.productIds.map(id => before.state.products.find(product => product.id === id));
      assert.ok(selected.every(product => product?.enabled), text);
      if (text === '有什么服务？') assert.ok(selected.every(product => product.type === 'service'));
      if (text === '有哪些商品？') assert.ok(selected.every(product => product.type === 'product'));
      if (text === '推荐几款') assert.ok(selected.every(product => product.type === 'service' || product.stock !== 0));
    }
    assert.deepEqual(await f.server.loadState('alice'), before);
  } finally { f.close(); }
});

test('目录直答仍遵守客户范围、人工接管、营业时段及敏感消息门禁', async t => {
  const f = fixture();
  try {
    const input = await catalogReplyFixture(f), before = await f.server.loadState('alice');
    t.mock.method(globalThis, 'fetch', async () => { throw Error('前置保护不应请求模型'); });
    for (const text of ['还有什么产品？可以便宜一点吗？', '你们卖什么？帮我退款', '【转发内容】你们卖什么？']) {
      const result = await f.server.runReplyAI('alice', { ...input, message: { ...input.message, text } });
      assert.equal(result.action, 'handoff'); assert.equal(result.reply, '');
    }
    for (const patch of [
      state => { state.replySettings.enabled = false; },
      state => { state.replySettings.selectedCustomerIds = []; },
      state => { state.customers.find(customer => customer.id === input.customerId).humanTakeover = true; },
      state => { state.replySettings.businessHours = { enabled: true, start: '00:00', end: '00:00', days: [0,1,2,3,4,5,6] }; },
    ]) {
      const state = structuredClone(before.state); patch(state);
      const latest = await f.server.loadState('alice'); await f.server.saveState('alice', state, latest.revision);
      const result = await f.server.runReplyAI('alice', { ...input, message: { ...input.message, text: '你们卖什么？' } });
      assert.equal(result.action, 'handoff'); assert.equal(result.reply, '');
    }
  } finally { f.close(); }
});

test('多商品比较有目录汇总原文，仍拒绝拼接引用、改写引用及虚构价格', async t => {
  const f = fixture();
  try {
    const input = await catalogReplyFixture(f); let invalid = false;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const data = JSON.parse(JSON.parse(options.body).messages[1].content);
      const source = data.knowledge.find(item => item.sourceId === 'catalog:products');
      assert.ok(source.text.includes('商品：面包；目录标价：10元'));
      assert.ok(source.groundingQuotes.includes('商品：面包；目录标价：10元'));
      assert.ok(source.text.includes('商品：美式咖啡；目录标价：18元'));
      assert.ok(!source.text.includes('停用样品'));
      const answer = { action: 'reply', reply: '面包标价10元，美式咖啡标价18元。', reason: '目录原文。', productIds: [], grounding: [{ sourceId: source.sourceId, quote: '商品：面包；目录标价：10元' }, { sourceId: source.sourceId, quote: '商品：美式咖啡；目录标价：18元' }] };
      return modelResponse(invalid ? { ...answer, grounding: [{ sourceId: source.sourceId, quote: '面包和美式咖啡都只卖1元' }] } : answer);
    });
    const question = { ...input, message: { ...input.message, text: '面包和美式咖啡分别多少钱？' } };
    const result = await f.server.runReplyAI('alice', question);
    assert.equal(result.action, 'reply'); assert.match(result.reply, /10元.*18元/);
    invalid = true;
    const rejected = await f.server.runReplyAI('alice', question);
    assert.equal(rejected.action, 'handoff'); assert.equal(rejected.reply, '');
  } finally { f.close(); }
});

test('常见价格规格保存库存及预约问题继续使用各商品FAQ，不被目录规则抢答', async t => {
  const f = fixture();
  try {
    const input = await catalogReplyFixture(f), before = await f.server.loadState('alice');
    const cases = [
      { question: '面包什么口味？多大一个？', name: '面包', faq: 0, facts: [/原味/, /80g/, /10元/] },
      { question: '面包保质期多久？怎么保存？', name: '面包', faq: 2, facts: [/2天/, /常温/, /当天/] },
      { question: '美式咖啡多少钱、多大杯？', name: '美式咖啡', faq: 0, facts: [/18元/, /300ml/] },
      { question: '咖啡手冲体验多少钱、包含什么？', name: '咖啡手冲体验', faq: 0, facts: [/128元/, /60分钟/, /不赠送器具/] },
    ];
    let current, calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      calls++;
      const data = JSON.parse(JSON.parse(options.body).messages[1].content);
      assert.equal(data.currentMessage.text, current.question);
      const product = before.state.products.find(product => product.name === current.name), answer = product.faq[current.faq].answer;
      const sourceId = `product:${product.id}:faq:${current.faq}`;
      assert.ok(data.knowledge.some(source => source.sourceId === sourceId && source.text.includes(answer)));
      for (const fact of current.facts) assert.match(answer, fact);
      return modelResponse({ action: 'reply', reply: answer, reason: '使用已保存商品FAQ原文。', productIds: [product.id], grounding: [{ sourceId, quote: answer }] });
    });
    for (current of cases) {
      const result = await f.server.runReplyAI('alice', { ...input, message: { ...input.message, text: current.question } });
      assert.equal(result.action, 'reply', current.question);
      for (const fact of current.facts) assert.match(result.reply, fact);
    }
    assert.equal(calls, cases.length);
    assert.deepEqual(await f.server.loadState('alice'), before);
  } finally { f.close(); }
});


test('现成引用编号可核对蛋糕冷藏说明，旧原文格式兼容且冲突编号不兜底', async t => {
  const f = fixture();
  try {
    const input = await catalogReplyFixture(f), before = await f.server.loadState('alice');
    const cake = before.state.products.find(product => product.name === '巴斯克蛋糕');
    let citation = { sourceId: `product:${cake.id}`, quoteIndex: 2 }, money = 28;
    let savedQuote;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const messages = JSON.parse(options.body).messages;
      assert.match(messages[0].content, /quoteIndex/);
      const source = JSON.parse(messages[1].content).knowledge.find(source => source.sourceId === `product:${cake.id}`);
      savedQuote = source.groundingQuotes[2];
      assert.match(savedQuote, /冷藏/);
      return modelResponse({ action: 'reply', reply: `巴斯克蛋糕${money}元，需0–4℃冷藏，保质期2天，开盒后建议当天食用。`, reason: '商品保存说明。', productIds: [cake.id], grounding: [citation] });
    });
    const question = { ...input, message: { ...input.message, text: '巴斯克蛋糕能常温放两天吗？' } };
    assert.equal((await f.server.runReplyAI('alice', question)).action, 'reply');
    for (citation of [{ sourceId: `product:${cake.id}`, quote: savedQuote }, { sourceId: `product:${cake.id}`, quoteIndex: 2, quote: savedQuote }]) assert.equal((await f.server.runReplyAI('alice', question)).action, 'reply');
    for (citation of [
      { sourceId: `product:${cake.id}`, quoteIndex: 2, quote: '蛋糕可常温保存两天，不用冷藏。' },
      { sourceId: `product:${cake.id}:faq:0`, quoteIndex: 4 },
      { sourceId: cake.id, quoteIndex: 2 },
      { sourceId: 'not-a-source', quoteIndex: 0 },
    ]) {
      const rejected = await f.server.runReplyAI('alice', question);
      assert.equal(rejected.action, 'handoff'); assert.equal(rejected.reply, '');
    }
    for (const quoteIndex of [-1, 5, 1.5, '2', null]) {
      citation = { sourceId: `product:${cake.id}`, quoteIndex };
      await assert.rejects(() => f.server.runReplyAI('alice', question), error => error.status === 502);
    }
    citation = { sourceId: `product:${cake.id}`, quoteIndex: 2 }; money = 999;
    const invented = await f.server.runReplyAI('alice', question);
    assert.equal(invented.action, 'handoff'); assert.equal(invented.reply, '');
    assert.deepEqual(await f.server.loadState('alice'), before);
  } finally { f.close(); }
});


test('重复资料标识不能借引用编号匹配另一商品的原文', async t => {
  const f = fixture();
  try {
    const input = await replyFixture(f), loaded = await f.server.loadState('alice');
    loaded.state.products[0].faq = [{ question: '咖啡礼盒怎么保存？', answer: '请保存在阴凉干燥处。' }];
    loaded.state.products.push({ ...loaded.state.products[0], id: 'p-coffee:faq:0', name: '另一件商品', faq: [] });
    await f.server.saveState('alice', loaded.state, loaded.revision);
    t.mock.method(globalThis, 'fetch', async () => modelResponse({ action: 'reply', reply: '请保存在阴凉干燥处。', reason: '资料说明。', productIds: [], grounding: [{ sourceId: 'product:p-coffee:faq:0', quoteIndex: 1 }] }));
    const result = await f.server.runReplyAI('alice', { ...input, message: { ...input.message, text: '咖啡礼盒怎么保存？' } });
    assert.equal(result.action, 'handoff'); assert.equal(result.reply, '');
  } finally { f.close(); }
});


test('客户预算可作为上限说明，但不能变成商品报价且商家聊天不成为预算来源', async t => {
  const f = fixture();
  try {
    const input = await catalogReplyFixture(f); let reply = '在20元以内，可以了解面包10元和美式咖啡18元。';
    t.mock.method(globalThis, 'fetch', async () => modelResponse({ action: 'reply', reply, reason: '依据目录并保留客户预算。', productIds: [], grounding: [{ sourceId: 'catalog:products', quoteIndex: 0 }, { sourceId: 'catalog:products', quoteIndex: 1 }] }));
    const question = { ...input, message: { ...input.message, text: '面包和美式咖啡有什么可以推荐？' } };
    const history = text => [{ sender: 'customer', text, date: '2026-11-07T09:00:00Z' }];
    for (const text of ['我的预算只有20元。', '只看20块以内的饮品。']) assert.equal((await f.server.runReplyAI('alice', { ...question, context: history(text) })).action, 'reply');
    for (const text of ['20元推荐什么产品', '20元推荐什么产品呢', '20块推荐几款', '20元能买什么', '推荐20元以内的产品']) {
      const oral = await f.server.runReplyAI('alice', { ...question, message: { ...question.message, text }, context: [] });
      assert.equal(oral.action, 'reply', text); assert.match(oral.reply, /10元[\s\S]*18元/);
    }
    assert.equal((await f.server.runReplyAI('alice', question)).action, 'handoff');
    assert.equal((await f.server.runReplyAI('alice', { ...question, context: [{ sender: 'merchant', text: '您的预算20元。', date: '2026-11-07T09:00:00Z' }] })).action, 'handoff');
    reply = '您的预算20元，面包标价20元。';
    const rejected = await f.server.runReplyAI('alice', { ...question, context: history('预算20元。') });
    assert.equal(rejected.action, 'handoff'); assert.equal(rejected.reply, '');
  } finally { f.close(); }
});


test('引用缺失最多修复一次且保持候选正文，修复编号无效仍转人工', async t => {
  const f = fixture();
  try {
    const input = await replyFixture(f), before = await f.server.loadState('alice'); let calls = 0, validRepair = true;
    const original = '浅烘咖啡礼盒268元，采用简洁包装。';
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      calls++; const request = JSON.parse(JSON.parse(options.body).messages[1].content);
      if (request.candidateReply !== undefined) {
        assert.equal(request.candidateReply, original); assert.equal(request.customer, undefined);
        assert.ok(request.knowledge[0].groundingQuotes.includes('价格：268元'));
        return modelResponse({ grounding: [{ sourceIndex: validRepair ? 0 : 9999, quoteIndex: 1 }] });
      }
      return modelResponse({ action: 'reply', reply: original, reason: '商品资料。', productIds: ['p-coffee'], grounding: [] });
    });
    const answer = await f.server.runReplyAI('alice', input);
    assert.equal(answer.action, 'reply'); assert.equal(answer.reply, original); assert.equal(calls, 2);
    calls = 0; validRepair = false;
    const rejected = await f.server.runReplyAI('alice', input);
    assert.equal(rejected.action, 'handoff'); assert.equal(rejected.reply, ''); assert.equal(calls, 2);
    assert.deepEqual(await f.server.loadState('alice'), before);
  } finally { f.close(); }
});

test('虚构金额和显式引用冲突不进入修复，前面的缺失引用不能掩盖后面的冲突', async t => {
  const f = fixture();
  try {
    const input = await replyFixture(f); let calls = 0, result;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return modelResponse(result); });
    const base = { action: 'reply', reply: '浅烘咖啡礼盒268元。', reason: '商品资料。', productIds: ['p-coffee'], grounding: [] };
    for (result of [
      { ...base, reply: '浅烘咖啡礼盒1元。' },
      { ...base, grounding: [{ sourceId: 'product:p-coffee', quoteIndex: 1, quote: '错误价格999元' }] },
      { ...base, grounding: [{ sourceId: 'missing', quote: '未知资料' }, { sourceId: 'product:p-coffee', quoteIndex: 1, quote: '错误价格999元' }] },
    ]) {
      calls = 0; const rejected = await f.server.runReplyAI('alice', input);
      assert.equal(rejected.action, 'handoff'); assert.equal(rejected.reply, ''); assert.equal(calls, 1);
    }
  } finally { f.close(); }
});


test('明确预算在多轮旧询价已确认留货及旧预算后连续直答，不调用模型', async t => {
  const f = fixture();
  try {
    const input = await replyFixture(f), loaded = await f.server.loadState('alice');
    loaded.state.products = [
      { id: 'synthetic-roll', name: '合成软包', type: 'product', price: 10, stock: 9, enabled: true, description: '', faq: [] },
      { id: 'synthetic-black', name: '合成黑咖', type: 'product', price: 18, stock: 9, enabled: true, description: '', faq: [] },
      { id: 'synthetic-high', name: '合成高价品', type: 'product', price: 28, stock: 9, enabled: true, description: '', faq: [] },
      { id: 'synthetic-service', name: '合成咨询', type: 'service', price: 15, enabled: true, description: '', faq: [] },
    ];
    await f.server.saveState('alice', loaded.state, loaded.revision);
    const before = await f.server.loadState('alice');
    const turn = (sender, text) => ({ sender, text, date: '2026-11-07T10:00:00Z' });
    const context = [turn('customer', '想咨询合成软包'), turn('customer', '合成软包多少钱一份'), turn('merchant', '合成软包标价10元。'), turn('customer', '.'), turn('customer', '你好，合成黑咖多少钱'), turn('merchant', '合成黑咖18元。'), turn('customer', '请给我留一份'), turn('merchant', '收到'), turn('customer', '合成软包有什么口味'), turn('merchant', '口味以店员核实为准。'), turn('customer', '店里卖哪些商品'), turn('merchant', '参考已保存目录。'), turn('customer', '20元推荐几款产品'), turn('merchant', 'x')];
    t.mock.method(globalThis, 'fetch', async () => { throw Error('明确预算目录不应请求模型'); });
    const body = { ...input, message: { ...input.message, text: '20元推荐什么产品呢' }, context };
    const first = await f.server.runReplyAI('alice', body);
    assert.equal(first.action, 'reply'); assert.deepEqual(first.productIds, ['synthetic-roll', 'synthetic-black']); assert.doesNotMatch(first.reply, /高价品|合成咨询|28元/);
    const second = await f.server.runReplyAI('alice', { ...body, message: { ...body.message, id: 'synthetic-repeat', date: '2026-11-07T10:02:00Z' }, context: [...context, turn('customer', body.message.text), turn('merchant', first.reply)] });
    assert.equal(second.action, 'reply'); assert.deepEqual(second.productIds, first.productIds);
    assert.deepEqual(await f.server.loadState('alice'), before);
  } finally { f.close(); }
});

async function syntheticRecommendationFixture(f) {
  const input = await replyFixture(f), loaded = await f.server.loadState('alice');
  loaded.state.products = [
    { id: 'recommend-roll', name: '合成软包', type: 'product', price: 10, stock: 9, enabled: true, description: '合成目录商品。', faq: [] },
    { id: 'recommend-black', name: '合成黑咖', type: 'product', price: 18, stock: 9, enabled: true, description: '合成目录商品。', faq: [] },
    { id: 'recommend-high', name: '合成高价品', type: 'product', price: 28, stock: 9, enabled: true, description: '合成目录商品。', faq: [] },
    { id: 'recommend-service', name: '合成咨询', type: 'service', price: 15, enabled: true, description: '合成目录服务。', faq: [] },
    { id: 'recommend-empty', name: '合成缺货品', type: 'product', price: 12, stock: 0, enabled: true, description: '合成缺货目录商品。', faq: [] },
    { id: 'recommend-hidden', name: '合成停用品', type: 'product', price: 1, stock: 9, enabled: false, description: '合成停用目录商品。', faq: [] },
  ];
  await f.server.saveState('alice', loaded.state, loaded.revision);
  await f.server.removeKey('alice');
  return input;
}

const recommendationTurn = (sender, text) => ({ sender, text, date: '2026-11-07T10:00:00Z' });
const simpleRecommendationHistory = () => [
  recommendationTurn('customer', '想咨询合成软包'),
  recommendationTurn('customer', '合成软包多少钱一份'),
  recommendationTurn('merchant', '合成软包标价10元。'),
  recommendationTurn('customer', '.'),
  recommendationTurn('customer', '你好，合成黑咖多少钱'),
  recommendationTurn('merchant', '合成黑咖18元。'),
  recommendationTurn('customer', '请给我留一份'),
  recommendationTurn('merchant', '收到'),
  recommendationTurn('customer', '合成软包有什么口味'),
  recommendationTurn('merchant', '口味以店员核实为准。'),
  recommendationTurn('customer', '店里卖哪些商品'),
  recommendationTurn('merchant', '参考已保存目录。'),
];

test('普通泛推荐结合多轮询价确认及留货历史直接读目录，不需密钥也不调用模型', async t => {
  const f = fixture();
  try {
    const input = await syntheticRecommendationFixture(f), before = await f.server.loadState('alice');
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('合成泛推荐不应请求模型'); });
    for (const text of ['有什么推荐的', '推荐几款', '帮我推荐一下产品']) {
      const body = { ...input, message: { ...input.message, text }, context: simpleRecommendationHistory() };
      const response = await f.asUser('alice', () => f.replyRoute.POST(post('reply', body)));
      assert.equal(response.status, 200, text);
      const result = await response.json();
      assert.equal(result.action, 'reply', text);
      assert.deepEqual(result.productIds, text.includes('产品') ? ['recommend-roll', 'recommend-black', 'recommend-high'] : ['recommend-roll', 'recommend-black', 'recommend-high', 'recommend-service']);
      assert.match(result.reply, /^我们有合成软包、合成黑咖/);
      assert.match(result.reply, /您想了解哪一[款项]？我可以为您详细介绍。$/);
      assert.doesNotMatch(result.reply, /商品·|服务·|标价|可参考|\d+元|具体方案请店员确认|合成缺货品|合成停用品|已为您预留|已下单/);
    }
    assert.equal(calls, 0);
    assert.equal(await f.server.hasSavedKey('alice'), false);
    assert.deepEqual(await f.server.loadState('alice'), before);
  } finally { f.close(); }
});

test('普通泛推荐继承六轮之前的20元预算和商品范围，不扩大到高价品或服务', async t => {
  const f = fixture();
  try {
    const input = await syntheticRecommendationFixture(f), before = await f.server.loadState('alice');
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('历史预算推荐不应请求模型'); });
    for (const budget of ['我的预算只有20元。', '20元推荐几款产品']) {
      const context = [recommendationTurn('customer', budget), recommendationTurn('merchant', '收到您的预算。'), ...simpleRecommendationHistory()];
      assert.ok(context.length > 6);
      const response = await f.asUser('alice', () => f.replyRoute.POST(post('reply', { ...input, message: { ...input.message, text: '有什么推荐的' }, context })));
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.action, 'reply', budget);
      assert.deepEqual(result.productIds, ['recommend-roll', 'recommend-black'], budget);
      assert.match(result.reply, /^20元以内，可以看看合成软包（10元）和合成黑咖（18元）。/);
      assert.doesNotMatch(result.reply, /合成高价品|合成咨询|28元|15元|合成缺货品|合成停用品/);
    }
    assert.equal(calls, 0);
    assert.deepEqual(await f.server.loadState('alice'), before);
  } finally { f.close(); }
});

test('历史条件无法完整确认时泛推荐返回固定澄清，不丢历史限制也不调用模型', async t => {
  const f = fixture();
  try {
    const input = await syntheticRecommendationFixture(f), before = await f.server.loadState('alice');
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('不明历史条件不应请求模型'); });
    for (const condition of ['需要适合露营携带的防潮款', '我不能吃奶制品', '只看20块以内的饮品']) {
      const context = [recommendationTurn('customer', condition), recommendationTurn('merchant', '收到您的需求。'), ...simpleRecommendationHistory()];
      const response = await f.asUser('alice', () => f.replyRoute.POST(post('reply', { ...input, message: { ...input.message, text: '有什么推荐的' }, context })));
      assert.equal(response.status, 200, condition);
      const result = await response.json();
      assert.equal(result.action, 'clarify', condition);
      assert.equal(result.reply, '您想挑点什么呢？可以说说用途或预算，我再帮您看看。');
      assert.deepEqual(result.productIds, []);
      assert.doesNotMatch(result.reply, /10元|18元|合成软包|合成黑咖/);
    }
    assert.equal(calls, 0);
    assert.deepEqual(await f.server.loadState('alice'), before);
  } finally { f.close(); }
});

test('回复API关键生成故障返回安全错误码，供应商正文密钥及堆栈不透出', async t => {
  const leak = 'SYNTHETIC_PROVIDER_PRIVATE_ERROR_DO_NOT_RETURN';
  const providerKey = 'sk-synthetic-provider-private-value';
  const providerBody = `${leak} ${providerKey}`;
  const cases = [
    { name: '缺少密钥', code: 'AI_KEY_MISSING', status: 400, missingKey: true },
    { name: '上游401', code: 'AI_AUTH_REJECTED', status: 502, response: () => Response.json({ error: { message: providerBody } }, { status: 401 }) },
    { name: '上游403', code: 'AI_AUTH_REJECTED', status: 502, response: () => new Response(providerBody, { status: 403 }) },
    { name: '上游429', code: 'AI_RATE_LIMITED', status: 429, response: () => Response.json({ error: { message: providerBody } }, { status: 429 }) },
    { name: '上游500', code: 'AI_UPSTREAM_ERROR', status: 502, response: () => new Response(providerBody, { status: 500 }) },
    { name: '网络异常', code: 'AI_NETWORK_UNREACHABLE', status: 502, response: () => { throw new TypeError(providerBody); } },
    { name: 'HTTP响应非法JSON', code: 'AI_RESPONSE_FORMAT', status: 502, response: () => new Response(`<html>${providerBody}</html>`, { status: 200 }) },
    { name: 'HTTP响应结构不兼容', code: 'AI_RESPONSE_FORMAT', status: 502, response: () => Response.json({ choices: [], error: providerBody }) },
    { name: '模型内容非法JSON', code: 'AI_RESPONSE_FORMAT', status: 502, response: () => modelResponse(providerBody) },
    { name: '模型结果schema不符', code: 'AI_RESPONSE_FORMAT', status: 502, response: () => modelResponse({ action: 'reply', reply: providerBody, reason: '', productIds: [] }) },
    { name: '模型空内容', code: 'AI_RESPONSE_EMPTY', status: 502, response: () => modelResponse(' \n ') },
  ];
  for (const scenario of cases) await t.test(scenario.name, async child => {
    const f = fixture();
    try {
      const input = await replyFixture(f), before = await f.server.loadState('alice');
      if (scenario.missingKey) await f.server.removeKey('alice');
      let calls = 0;
      child.mock.method(globalThis, 'fetch', async () => {
        calls++;
        if (!scenario.response) throw Error('缺少密钥时不得调用模型');
        return scenario.response();
      });
      const response = await f.asUser('alice', () => f.replyRoute.POST(post('reply', input)));
      assert.equal(response.status, scenario.status);
      const body = await response.json();
      assert.equal(body.code, scenario.code);
      assert.equal(typeof body.error, 'string');
      assert.ok(body.error.length > 0);
      assert.deepEqual(Object.keys(body).sort(), ['code', 'error']);
      const serialized = JSON.stringify(body);
      assert.ok(!serialized.includes(leak));
      assert.ok(!serialized.includes(providerKey));
      assert.ok(!serialized.includes('sk-unit-only-0123456789'));
      assert.doesNotMatch(serialized, /TypeError|\bat callModel\b|\bat runReplyAI\b/);
      assert.equal(calls, scenario.missingKey ? 0 : 1);
      assert.deepEqual(await f.server.loadState('alice'), before);
    } finally { f.close(); }
  });
});

test('本地登录或同源拒绝不冒充模型认证失败，不调用模型', async t => {
  const f = fixture();
  try {
    const input = await replyFixture(f); let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('应用访问拒绝不得请求模型'); });
    const unauthenticated = await f.replyRoute.POST(post('reply', input));
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).code, undefined);
    const crossOrigin = await f.asUser('alice', () => f.replyRoute.POST(post('reply', input, { origin: 'https://outside.example' })));
    assert.equal(crossOrigin.status, 403);
    assert.equal((await crossOrigin.json()).code, undefined);
    assert.equal(calls, 0);
  } finally { f.close(); }
});

test('生产回复API到本机队列通用核验预算，继承20元或裸预算50更新旧20都只发送一次', async t => {
  for (const scenario of [
    { name: '继承历史20元', amount: 20, current: '你好，有什么推荐' },
    { name: '裸预算50覆盖旧20元', amount: 50, current: '预算50有推荐吗' },
  ]) await t.test(scenario.name, async child => {
  const f = fixture(), temporary = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporary, 'kexu-api-engine-money-'));
  let engine;
  child.after(async () => {
    await engine?.close();
    const actual = await realpath(directory);
    // 仅清理已核实位于系统临时目录中的本次合成测试目录。
    assert.equal(path.dirname(actual).toLowerCase(), temporary.toLowerCase());
    assert.ok(path.basename(actual).startsWith('kexu-api-engine-money-'));
    await rm(actual, { recursive: true, force: true });
  });
  try {
    await replyFixture(f);
    const loaded = await f.server.loadState('alice');
    const customer = { ...structuredClone(loaded.state.customers[0]), id: 'pipeline-customer', name: '合成链路客户', wechatId: 'wxid_pipeline_fixture', source: 'wechat', autoReplyEnabled: true, humanTakeover: false, summary: '', preferences: '', budget: '', note: '', tags: [], manualTags: [], evidence: [], messages: [] };
    loaded.state.customers = [customer];loaded.state.orders = [];loaded.state.tasks = [];
    loaded.state.products = [
      { id: 'pipeline-roll', name: '合成软包', type: 'product', price: 10, stock: 9, enabled: true, description: '合成目录商品。', faq: [] },
      { id: 'pipeline-black', name: '合成黑咖', type: 'product', price: 18, stock: 9, enabled: true, description: '合成目录商品。', faq: [] },
    ];
    loaded.state.settings.storeName = '合成链路门店';
    loaded.state.replySettings = { ...loaded.state.replySettings, selectedCustomerIds: [customer.id], mode: 'review', welcomeEnabled: false, cooldownSeconds: 0, debounceSeconds: 0 };
    await f.server.saveState('alice', loaded.state, loaded.revision);
    const before = await f.server.loadState('alice');
    const config = { settings: before.state.replySettings, customers: before.state.customers, products: before.state.products, storeName: before.state.settings.storeName, industry: before.state.settings.industry };
    assert.ok(config.products.every(product => product.price !== scenario.amount));
    assert.doesNotMatch(JSON.stringify(config), /20元|50元/);
    let clock = Date.parse('2026-11-08T01:00:00Z'), modelCalls = 0, forgedModelReply;
    const sends = [];
    child.mock.method(globalThis, 'fetch', async () => {
      modelCalls++;
      if (!forgedModelReply) throw Error('合成预算目录直答不得请求模型');
      return modelResponse(forgedModelReply);
    });
    engine = await createReplyEngine({ directory, now: () => clock, tickMs: 10, send: async packet => { sends.push(packet);return { status: 'sent', messageId: `pipeline-native-${sends.length}` }; } });
    await engine.syncConfig(config);await engine.start();
    const incoming = (id, text) => ({ id, chatId: customer.wechatId, sender: 'customer', text, date: new Date(clock).toISOString(), source: 'realtime', kind: 'text' });
    await engine.ingest(incoming('pipeline-budget', '预算20元。'));
    const budgetWork = (await engine.claimWork()).jobs[0];assert.ok(budgetWork);
    await engine.completeWork({ jobId: budgetWork.id, leaseId: budgetWork.leaseId, result: { action: 'ignore', reply: '', reason: '合成测试保留客户预算背景。', productIds: [] } });
    clock += 1000;
    await engine.ingest(incoming('pipeline-recommendation', scenario.current));
    const work = (await engine.claimWork()).jobs[0];assert.ok(work);
    assert.ok(work.context.some(turn => turn.sender === 'customer' && turn.text === '预算20元。'));
    assert.ok(work.context.some(turn => turn.sender === 'customer' && turn.text === scenario.current));
    const apiBody = item => ({ customerId: item.customerId, message: item.message, ...(item.messages ? { messages: item.messages } : {}), context: item.context });
    const response = await f.asUser('alice', () => f.replyRoute.POST(post('reply', apiBody(work))));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.action, 'reply');assert.equal(modelCalls, 0);
    assert.equal(result.reply, `${scenario.amount}元以内，可以看看合成软包（10元）和合成黑咖（18元）。您想了解哪一款？我可以为您详细介绍。`);
    assert.deepEqual(result.productIds, ['pipeline-roll', 'pipeline-black']);
    const completed = await engine.completeWork({ jobId: work.id, leaseId: work.leaseId, result });
    assert.equal(completed.status, 'draft');
    await engine.approve(work.id);
    let sentState;
    for (let count = 0; count < 400; count++) {
      sentState = await engine.status();
      if (sentState.counts.sent === 1) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(sentState.counts.sent, 1);assert.equal(sends.length, 1);
    assert.equal(sends[0].text, result.reply);
    clock += 1000;
    await engine.ingest(incoming('pipeline-forged-price', '合成软包现在多少钱？'));
    const forgedWork = (await engine.claimWork()).jobs[0];assert.ok(forgedWork);
    forgedModelReply = { action: 'reply', reply: `合成软包${scenario.amount}元。`, reason: '合成错误报价。', productIds: ['pipeline-roll'], grounding: [{ sourceId: 'product:pipeline-roll', quote: '价格：10元' }] };
    const rejectedResponse = await f.asUser('alice', () => f.replyRoute.POST(post('reply', apiBody(forgedWork))));
    assert.equal(rejectedResponse.status, 200);
    const apiRejected = await rejectedResponse.json();
    assert.equal(apiRejected.action, 'handoff');assert.equal(apiRejected.reply, '');assert.equal(modelCalls, 1);
    const engineRejected = await engine.completeWork({ jobId: forgedWork.id, leaseId: forgedWork.leaseId, result: forgedModelReply });
    assert.equal(engineRejected.status, 'handoff');assert.match(engineRejected.reason, /价格不在已配置/);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(sends.length, 1);assert.equal((await engine.status()).counts.sent, 1);
    assert.deepEqual(await f.server.loadState('alice'), before);
  } finally { f.close(); }
  });
});
