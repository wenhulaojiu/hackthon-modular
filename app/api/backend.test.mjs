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
function fixture() {
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
  const environment = { DB: d1, APP_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
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
    assert.equal(calls[0].options.redirect, "error");
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
