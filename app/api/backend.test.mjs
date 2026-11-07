import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
      fileName: absolute,
    }).outputText;
    const module = { exports: {} };
    loaded.set(absolute, module);
    const localRequire = (specifier) => {
      if (specifier === "cloudflare:workers") return { env: environment };
      if (specifier === "@/app/chatgpt-auth") return { getChatGPTUser: async () => identity.getStore() ? { userId: identity.getStore(), email: `${identity.getStore()}@test.invalid` } : null };
      if (specifier === "@/db") return { getDb: () => drizzle(d1, { schema }) };
      if (specifier.startsWith("@/")) return load(`${specifier.slice(2)}.ts`);
      if (specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(absolute), specifier);
        return load(target.endsWith(".ts") ? target : `${target}.ts`);
      }
      return nativeRequire(specifier);
    };
    new Function("require", "module", "exports", output)(localRequire, module, module.exports);
    return module.exports;
  };
  schema = load("db/schema.ts");
  const server = load("lib/server.ts");
  return {
    sqlite, environment, server,
    stateRoute: load("app/api/state/route.ts"),
    secretRoute: load("app/api/secret/route.ts"),
    aiRoute: load("app/api/ai/route.ts"),
    replyRoute: load("app/api/reply/route.ts"),
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

test("旧回复设置缺省等待60秒，显式0和120可保存，无效等待时间拒绝", async () => {
  const f = fixture();
  try {
    await replyFixture(f);
    const loaded = await f.server.loadState("alice");
    assert.equal(loaded.state.replySettings.debounceSeconds, 60);
    const legacy = structuredClone(loaded.state);
    delete legacy.replySettings.debounceSeconds;
    assert.equal(f.server.appStateSchema.parse(legacy).replySettings.debounceSeconds, 60);
    for (const seconds of [0, 120]) {
      const next = structuredClone(legacy); next.replySettings.debounceSeconds = seconds;
      assert.equal(f.server.appStateSchema.parse(next).replySettings.debounceSeconds, seconds);
    }
    for (const seconds of [-1, 121, 0.1, null, "60"]) {
      const next = structuredClone(legacy); next.replySettings.debounceSeconds = seconds;
      assert.equal(f.server.appStateSchema.safeParse(next).success, false);
    }
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
