import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, lstat } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_REPLY_SETTINGS = {
  enabled: false, mode: "review", selectedCustomerIds: [],
  businessHours: { enabled: true, start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5, 6] },
  faq: [], handoffKeywords: ["退款", "退货", "改价", "投诉"], maxReplyChars: 300, cooldownSeconds: 30, prompt: "",
};
const STATUSES = ["queued", "generating", "draft", "ready", "sending", "sent", "handoff", "failed", "unknown", "ignored", "cancelled"];
const PENDING = new Set(["queued", "generating", "draft", "ready", "sending"]);
const SENSITIVE = /退款|退货|退钱|改价|修改价格|调整价格|降价|砍价|还价|便宜一点|优惠一点|打折|折扣|赔偿|投诉|转人工|人工客服|真人/;
const QUOTED = /^\s*【(?:转账\/收款卡片|红包卡片|引用资料|转发内容)/u;

export class ReplyEngineError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (message, status = 400) => { throw new ReplyEngineError(status, message); };
const copy = (value) => structuredClone(value);
const text = (value, max, empty = false) => typeof value === "string" && value.length <= max && (empty || !!value.trim());
const clock = (value) => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const safeId = (value) => text(value, 200) && !/[\u0000-\u001f]/.test(value);
const privateId = (value) => safeId(value) && value !== "filehelper" && !value.endsWith("@chatroom");
const validDate = (value) => text(value, 80) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const amountStrings = (value) => Array.from(value.matchAll(/(?:[¥￥]\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*元)/g), (match) => Number(match[1] || match[2]));

function faqList(value, max = 100) {
  if (!Array.isArray(value) || value.length > max || value.some((item) => !item || !text(item.question, 500) || !text(item.answer, 4000))) fail("常见问题资料格式不正确。");
  return value.map(({ question, answer }) => ({ question, answer }));
}

function configInput(value) {
  if (!value || typeof value !== "object" || Object.keys(value).some((key) => !["settings", "customers", "products", "storeName", "industry"].includes(key))) fail("自动回复配置格式不正确。");
  const s = value.settings;
  const h = s?.businessHours;
  if (!s || typeof s.enabled !== "boolean" || !["review", "auto"].includes(s.mode) || !Array.isArray(s.selectedCustomerIds) || s.selectedCustomerIds.length > 500 || s.selectedCustomerIds.some((id) => !safeId(id))) fail("请选择回复模式与客户白名单。");
  if (!h || typeof h.enabled !== "boolean" || !clock(h.start) || !clock(h.end) || !Array.isArray(h.days) || h.days.length > 7 || h.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) fail("营业时间格式不正确。");
  if (!Number.isInteger(s.maxReplyChars) || s.maxReplyChars < 40 || s.maxReplyChars > 1000 || !Number.isInteger(s.cooldownSeconds) || s.cooldownSeconds < 0 || s.cooldownSeconds > 3600 || !text(s.prompt, 8000, true) || !Array.isArray(s.handoffKeywords) || s.handoffKeywords.length > 100 || s.handoffKeywords.some((word) => !text(word, 80))) fail("回复长度、冷却时间或人工规则格式不正确。");
  if (!Array.isArray(value.customers) || value.customers.length > 500 || value.customers.some((c) => !c || !safeId(c.id) || !text(c.name, 160) || typeof c.wechatId !== "string" || c.wechatId.length > 200 || (c.autoReplyEnabled !== undefined && typeof c.autoReplyEnabled !== "boolean") || (c.humanTakeover !== undefined && typeof c.humanTakeover !== "boolean"))) fail("客户映射格式不正确。");
  if (new Set(value.customers.map((c) => c.id)).size !== value.customers.length) fail("客户 ID 不能重复。");
  if (!Array.isArray(value.products) || value.products.length > 200) fail("商品资料格式不正确。");
  const products = value.products.map((product) => {
    if (!product || !safeId(product.id) || !text(product.name, 160) || !["product", "service"].includes(product.type) || !(product.price === null || typeof product.price === "number" && Number.isFinite(product.price) && product.price >= 0 && product.price <= 100_000_000) || !text(product.description, 8000, true) || typeof product.enabled !== "boolean") fail("商品名称、价格或服务资料格式不正确。");
    return { id: product.id, name: product.name, type: product.type, price: product.price, description: product.description, faq: faqList(product.faq, 30), enabled: product.enabled };
  });
  if (new Set(products.map((p) => p.id)).size !== products.length) fail("商品 ID 不能重复。");
  return {
    settings: { enabled: s.enabled, mode: s.mode, selectedCustomerIds: [...new Set(s.selectedCustomerIds)], businessHours: { enabled: h.enabled, start: h.start, end: h.end, days: [...new Set(h.days)] }, faq: faqList(s.faq), handoffKeywords: [...s.handoffKeywords], maxReplyChars: s.maxReplyChars, cooldownSeconds: s.cooldownSeconds, prompt: s.prompt },
    customers: value.customers.map((c) => ({ id: c.id, wechatId: c.wechatId, name: c.name, ...(c.autoReplyEnabled !== undefined ? { autoReplyEnabled: c.autoReplyEnabled } : {}), ...(c.humanTakeover !== undefined ? { humanTakeover: c.humanTakeover } : {}) })),
    products, storeName: text(value.storeName, 120, true) ? value.storeName : "", industry: text(value.industry, 120, true) ? value.industry : "",
  };
}

export function isBusinessOpen(hours, timestamp) {
  if (!hours.enabled) return true;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestamp));
  let day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((item) => item.type === "weekday")?.value || "");
  const time = `${parts.find((item) => item.type === "hour")?.value}:${parts.find((item) => item.type === "minute")?.value}`;
  if (hours.start === hours.end) return false;
  if (hours.start < hours.end) return hours.days.includes(day) && time >= hours.start && time < hours.end;
  if (time < hours.end) day = (day + 6) % 7;
  return hours.days.includes(day) && (time >= hours.start || time < hours.end);
}

export async function createReplyEngine(options = {}) {
  if (!options.directory || !path.isAbsolute(options.directory)) fail("自动回复队列需要本地绝对目录。", 503);
  const directory = path.resolve(options.directory);
  const filename = path.join(directory, "queue.json");
  const now = options.now || Date.now;
  const iso = () => new Date(now()).toISOString();
  const leaseMs = options.generationLeaseMs || 90_000;
  const generate = options.generate;
  const send = options.send;
  let state = { version: 1, config: null, configRevision: 0, jobs: [], seen: [], takeovers: [], history: {}, lastSent: {} };
  let hasFile = false;
  let armed = false;
  let closed = false;
  let pausedReason = "尚未启动自动回复。";
  let chain = Promise.resolve();
  let pumpTimer = null;
  let ticking = false;
  let sendBusy = false;
  const inflight = new Set();
  const generationControllers = new Set();

  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 40_000_000) fail("自动回复队列文件无法安全读取，请先备份检查。", 503);
    const loaded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(filename)));
    if (loaded.version !== 1 || !Array.isArray(loaded.jobs) || !Array.isArray(loaded.seen) || !Array.isArray(loaded.takeovers) || !loaded.history || !loaded.lastSent) fail("自动回复队列格式异常，原数据未被覆盖。", 503);
    if (loaded.config) loaded.config = configInput(loaded.config);
    state = loaded;
    hasFile = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error instanceof ReplyEngineError ? error : new ReplyEngineError(503, "自动回复队列损坏或无法读取，原数据未被覆盖。");
  }

  async function persist(next, serialized) {
    const value = serialized || JSON.stringify(next);
    if (Buffer.byteLength(value, "utf8") > 40_000_000) fail("自动回复队列容量已满，请暂停后人工整理历史。", 503);
    const temporary = path.join(directory, `.queue-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(value, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    try {
      try { if ((await lstat(filename)).isSymbolicLink()) fail("队列文件安全检查失败。", 503); } catch (error) { if (error.code !== "ENOENT") throw error; }
      await rename(temporary, filename);
    } catch (error) { await rm(temporary, { force: true }); throw error; }
  }

  const exclusive = (work) => {
    const result = chain.then(work);
    chain = result.catch(() => {});
    return result;
  };
  async function mutate(work) {
    return exclusive(async () => {
      const next = copy(state);
      const result = await work(next);
      const serialized = JSON.stringify(next);
      if (!hasFile || serialized !== JSON.stringify(state)) {
        await persist(next, serialized);
        state = next;
        hasFile = true;
      }
      return result;
    });
  }

  // 重启时绝不重复发送无法确定结果的消息，也不自动恢复运行开关。
  await mutate((next) => {
    for (const job of next.jobs) {
      if (job.status === "sending") { job.status = "unknown"; job.reason = "服务在发送期间中断，必须人工核对微信，不能自动重发。"; if (!next.takeovers.includes(job.customerId)) next.takeovers.push(job.customerId); }
      else if (job.status === "generating") { job.status = "queued"; delete job.leaseId; }
      else if (job.status === "ready") { job.status = "draft"; job.reason = "服务已重启，请重新审核该回复。"; }
    }
  });

  function customerFor(next, job) { return next.config?.customers.find((customer) => customer.id === job.customerId && customer.wechatId === job.chatId); }
  function gate(next, job, checkCooldown = true) {
    const config = next.config;
    if (!config?.settings.enabled) return { action: "ignored", reason: "全局自动回复尚未启用。" };
    const customer = customerFor(next, job);
    if (!customer || !privateId(job.chatId) || !config.settings.selectedCustomerIds.includes(customer.id) || customer.autoReplyEnabled === false) return { action: "ignored", reason: "该好友不在已启用的客户白名单中。" };
    if (customer.humanTakeover || next.takeovers.includes(customer.id)) return { action: "handoff", reason: "该会话已转人工接管。" };
    if (!isBusinessOpen(config.settings.businessHours, now())) return { action: "ignored", reason: "当前不在配置的营业时间内。" };
    if (QUOTED.test(job.message.text)) return { action: "handoff", reason: "引用、转发或支付卡片需人工确认。" };
    if (SENSITIVE.test(job.message.text) || config.settings.handoffKeywords.some((word) => job.message.text.toLowerCase().includes(word.toLowerCase()))) return { action: "handoff", reason: "售后、改价或特殊需求需要人工处理。" };
    if (checkCooldown && next.lastSent[job.chatId] !== undefined && now() - next.lastSent[job.chatId] < config.settings.cooldownSeconds * 1000) return { action: "defer", reason: "等待会话冷却时间。" };
    return null;
  }

  function setHandoff(next, job, reason, status = "handoff") {
    job.status = status; job.reason = reason; job.updatedAt = iso();
    delete job.leaseId;
    if (!next.takeovers.includes(job.customerId)) next.takeovers.push(job.customerId);
  }

  function publicJob(job) {
    return { id: job.id, customerId: job.customerId, chatId: job.chatId, message: copy(job.message), status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt, ...(job.reply ? { reply: job.reply } : {}), ...(job.reason ? { reason: job.reason } : {}), ...(job.sendMessageId ? { sendMessageId: job.sendMessageId } : {}) };
  }

  async function status() {
    await chain;
    const counts = Object.fromEntries(STATUSES.map((name) => [name, state.jobs.filter((job) => job.status === name).length]));
    return { running: armed && !closed, generatorMode: typeof generate === "function" ? "background" : "browser", configReady: !!state.config, counts, jobs: state.jobs.slice(-200).reverse().map(publicJob), takeovers: [...state.takeovers], pausedReason: armed ? undefined : pausedReason };
  }

  function schedule() {
    if (closed || !armed || pumpTimer) return;
    pumpTimer = setTimeout(() => { pumpTimer = null; void tick().catch(() => { armed = false; pausedReason = "本地队列写入失败，已停止自动回复，请检查后重新启动。"; }); }, 0);
    pumpTimer.unref?.();
  }

  function track(promise, again = true) {
    inflight.add(promise);
    promise.finally(() => { inflight.delete(promise); if (again) schedule(); }).catch(() => { armed = false; pausedReason = "本地队列更新失败，已停止自动回复。"; });
  }

  function head(next, job) {
    return !next.jobs.some((earlier) => earlier.chatId === job.chatId && earlier.id !== job.id && PENDING.has(earlier.status) && next.jobs.indexOf(earlier) < next.jobs.indexOf(job));
  }

  async function reserveWork(limit = 2) {
    if (!armed || closed) return [];
    await chain;
    if (!state.jobs.some((job) => job.status === "queued" || job.status === "generating" && job.leaseUntil <= now())) return [];
    return mutate((next) => {
      const jobs = [];
      for (const job of next.jobs) {
        if (job.status === "generating" && job.leaseUntil <= now()) setHandoff(next, job, "生成响应超时，已转人工，避免重复处理。", "failed");
      }
      let capacity = Math.max(0, limit - next.jobs.filter((job) => job.status === "generating").length);
      for (const job of next.jobs) {
        if (!capacity || job.status !== "queued" || !head(next, job)) continue;
        const blocked = gate(next, job);
        if (blocked) {
          if (blocked.action === "defer") continue;
          if (blocked.action === "handoff") setHandoff(next, job, blocked.reason);
          else { job.status = "ignored"; job.reason = blocked.reason; job.updatedAt = iso(); }
          continue;
        }
        job.status = "generating"; job.leaseId = randomUUID(); job.leaseUntil = now() + leaseMs; job.configRevision = next.configRevision; job.updatedAt = iso();
        const history = next.history[job.chatId] || [];
        const end = history.findIndex((message) => message.id === job.message.id);
        const context = history.slice(0, end < 0 ? history.length : end + 1).slice(-20).map(({ sender, text, date }) => ({ sender, text: text.slice(0, 4000), date }));
        jobs.push({ id: job.id, leaseId: job.leaseId, customerId: job.customerId, message: copy(job.message), context });
        capacity -= 1;
      }
      return jobs;
    });
  }

  function resultInput(value) {
    if (!value || !["reply", "handoff"].includes(value.action) || !text(value.reply, 4000, true) || !text(value.reason, 800) || value.productIds !== undefined && (!Array.isArray(value.productIds) || value.productIds.length > 20 || value.productIds.some((id) => !safeId(id)))) fail("AI 回复结果格式不正确。");
    return { action: value.action, reply: value.reply.trim(), reason: value.reason, productIds: value.productIds || [] };
  }

  function outputBlock(next, result) {
    if (!result.reply || result.reply.length > next.config.settings.maxReplyChars) return "回复为空或超过配置长度。";
    if (/已为您退款|已经退款|已退款|已改价|已调整价格|保证有效|一定有效|百分之百|100%/.test(result.reply)) return "回复包含未经人工授权的操作或效果承诺。";
    const products = next.config.products.filter((product) => product.enabled);
    if (result.productIds.some((id) => !products.some((product) => product.id === id))) return "回复引用了未启用的商品或服务。";
    const money = new Set(products.filter((product) => product.price !== null).map((product) => product.price));
    const facts = [...next.config.settings.faq.map((faq) => faq.answer), ...products.flatMap((product) => [product.description, ...product.faq.map((faq) => faq.answer)])];
    for (const fact of facts) for (const value of amountStrings(fact)) money.add(value);
    if (amountStrings(result.reply).some((amount) => !money.has(amount))) return "回复中的价格不在已配置门店资料中。";
    return "";
  }

  async function completeWork(input) {
    if (!input || !safeId(input.jobId) || !safeId(input.leaseId) || (input.result === undefined) === (input.error === undefined)) fail("生成回调参数不正确。");
    const result = input.result === undefined ? null : resultInput(input.result);
    const completed = await mutate((next) => {
      const job = next.jobs.find((item) => item.id === input.jobId);
      if (!job || job.status !== "generating" || job.leaseId !== input.leaseId || job.leaseUntil <= now()) fail("此生成任务已失效，未发送回复。", 409);
      if (input.error !== undefined) { setHandoff(next, job, text(input.error, 800) ? input.error : "AI 生成失败，请检查设置后人工处理。", "failed"); return publicJob(job); }
      const blocked = gate(next, job, false);
      if (blocked && blocked.action !== "defer") { setHandoff(next, job, blocked.reason); return publicJob(job); }
      if (job.configRevision !== next.configRevision) { setHandoff(next, job, "生成期间门店资料或规则已变化，请人工审核。"); return publicJob(job); }
      if (result.action === "handoff") { setHandoff(next, job, result.reason); return publicJob(job); }
      const denied = outputBlock(next, result);
      if (denied) { setHandoff(next, job, denied); return publicJob(job); }
      job.reply = result.reply; job.productIds = result.productIds; job.reason = result.reason; job.status = armed && next.config.settings.mode === "auto" ? "ready" : "draft"; job.updatedAt = iso(); delete job.leaseId;
      return publicJob(job);
    });
    schedule();
    return completed;
  }

  async function sendNext() {
    if (sendBusy || !armed || closed || typeof send !== "function" || !state.jobs.some((job) => job.status === "ready")) return false;
    sendBusy = true;
    try {
      const packet = await mutate((next) => {
        if (!armed || closed) return null;
        for (const job of next.jobs) {
          if (job.status !== "ready" || !head(next, job)) continue;
          const blocked = gate(next, job);
          if (blocked) { if (blocked.action !== "defer") setHandoff(next, job, blocked.reason); continue; }
          if (job.configRevision !== next.configRevision && !job.manuallyApproved) { setHandoff(next, job, "发送前门店资料已变化，请人工审核。"); continue; }
          const denied = outputBlock(next, { reply: job.reply, productIds: job.productIds || [] });
          if (denied) { setHandoff(next, job, denied); continue; }
          job.status = "sending"; job.updatedAt = iso(); job.sendStartedAt = iso();
          return { jobId: job.id, chatId: job.chatId, text: job.reply, idempotencyKey: job.id };
        }
        return null;
      });
      if (!packet) return false;
      const current = state.jobs.find((job) => job.id === packet.jobId);
      const blocked = current && gate(state, current, false);
      if (!armed || closed || blocked) {
        await mutate((next) => {
          const job = next.jobs.find((item) => item.id === packet.jobId);
          if (job?.status === "sending") { if (blocked) setHandoff(next, job, blocked.reason); else { job.status = "draft"; job.reason = "发送前服务已暂停，未调用发送适配器。"; } }
        });
        return false;
      }
      let result;
      try { result = await send({ chatId: packet.chatId, text: packet.text, idempotencyKey: packet.idempotencyKey }); }
      catch { result = { status: "unknown", error: "发送适配器中断，结果未知，请人工核对微信。" }; }
      await mutate((next) => {
        const job = next.jobs.find((item) => item.id === packet.jobId);
        if (!job || job.status !== "sending") return;
        if (result?.status === "sent" && safeId(result.messageId)) {
          job.status = "sent"; job.reason = "微信适配器已确认发送。"; job.updatedAt = iso();
          if (safeId(result.messageId)) job.sendMessageId = result.messageId;
          next.lastSent[job.chatId] = now();
          const history = next.history[job.chatId] || [];
          history.push({ id: result.messageId || `out:${job.id}`, sender: "merchant", text: job.reply, date: iso() });
          next.history[job.chatId] = history.slice(-100);
        } else setHandoff(next, job, result?.status === "failed" ? "适配器确认未发送成功，请人工处理，不会自动重试。" : "发送结果未知，请核对微信实际记录，禁止自动重发。", result?.status === "failed" ? "failed" : "unknown");
      });
      return true;
    } finally { sendBusy = false; }
  }

  async function tick() {
    if (ticking || !armed || closed) return;
    ticking = true;
    try {
      if (typeof generate === "function") {
        const work = await reserveWork();
        for (const item of work) {
          const controller = new AbortController(); generationControllers.add(controller);
          track((async () => {
            try { const result = await generate(copy(item), { signal: controller.signal }); if (!closed) await completeWork({ jobId: item.id, leaseId: item.leaseId, result }); }
            catch { if (!closed) { try { await completeWork({ jobId: item.id, leaseId: item.leaseId, error: "AI 生成失败，已转人工，请检查模型配置。" }); } catch { /* 过期或已接管的任务不会重新发送。 */ } } }
            finally { generationControllers.delete(controller); }
          })());
        }
      }
      if (!sendBusy) track(sendNext().then((sent) => { if (sent) schedule(); }), false);
    } finally { ticking = false; }
  }

  const interval = setInterval(schedule, options.tickMs || 1000);
  interval.unref?.();

  async function syncConfig(value) {
    const config = configInput(value);
    await chain;
    if (JSON.stringify(state.config) === JSON.stringify(config)) return { configured: true };
    const scope = (current) => current ? JSON.stringify({ mode: current.settings.mode, selected: [...current.settings.selectedCustomerIds].sort().map((id) => { const customer = current.customers.find((c) => c.id === id); return [id, customer?.wechatId, customer?.autoReplyEnabled]; }) }) : "";
    const rearm = armed && scope(state.config) !== scope(config);
    await mutate((next) => {
      if (JSON.stringify(next.config) !== JSON.stringify(config)) { next.config = config; next.configRevision += 1; }
      for (const customer of config.customers) if (customer.humanTakeover && !next.takeovers.includes(customer.id)) next.takeovers.push(customer.id);
    });
    if (!config.settings.enabled) { armed = false; pausedReason = "全局开关已关闭。"; }
    else if (rearm) { armed = false; pausedReason = "回复模式或客户范围已变更，请重新启动以核验适配器并建立新消息基线。"; }
    schedule();
    return { configured: true };
  }

  async function start() {
    await chain;
    if (closed) fail("本地回复引擎已关闭。", 503);
    if (!state.config?.settings.enabled) fail("请先保存并启用自动回复规则。");
    const selected = state.config.customers.filter((c) => state.config.settings.selectedCustomerIds.includes(c.id) && c.autoReplyEnabled !== false);
    if (!selected.length || selected.some((c) => !privateId(c.wechatId))) fail("请先选择具有准确微信标识的好友客户。");
    if (state.config.settings.mode === "auto" && typeof send !== "function") fail("微信发送适配器尚未配置，不能启动自动发送。", 503);
    armed = true; pausedReason = ""; schedule(); return status();
  }

  async function pause(reason) { armed = false; pausedReason = text(reason, 500) ? reason : "商户已暂停自动回复。"; await chain; return status(); }

  async function ingest(event) {
    if (closed) fail("本地回复引擎已关闭。", 503);
    if (!event || !safeId(event.id) || !privateId(event.chatId) || !["customer", "merchant", "system"].includes(event.sender) || !text(event.text, 8000) || !validDate(event.date)) fail("实时消息缺少稳定标识或有效内容。");
    const accepted = await mutate((next) => {
      const key = `${event.chatId}\u0000${event.id}`;
      if (next.seen.includes(key)) return { accepted: false, duplicate: true };
      if (next.seen.length >= 50_000 || next.jobs.length >= 5000) fail("本地队列容量已满，已停止接收新任务，请暂停并整理记录。", 503);
      next.seen.push(key);
      if ((event.source || "realtime") !== "realtime") return { accepted: false, reason: "历史导入与营销任务不进入自动回复队列。" };
      const matches = next.config?.customers.filter((customer) => customer.wechatId === event.chatId) || [];
      if (matches.length !== 1) return { accepted: false, reason: "会话无法唯一映射到已配置客户。" };
      const customer = matches[0];
      if (event.sender === "system" || (event.kind && event.kind !== "text")) return { accepted: false, reason: "系统或非文字消息需人工处理。" };
      const history = next.history[event.chatId] || [];
      history.push({ id: event.id, sender: event.sender, text: event.text, date: event.date });
      next.history[event.chatId] = history.slice(-100);
      if (event.sender === "merchant") {
        const ownEcho = next.jobs.some((job) => job.chatId === event.chatId && ["sending", "sent"].includes(job.status) && job.reply === event.text && ((safeId(event.nativeMessageId) && event.nativeMessageId === job.sendMessageId) || now() - Date.parse(job.sendStartedAt || job.updatedAt) < 120_000));
        if (event.automated !== true && !ownEcho && !next.takeovers.includes(customer.id)) next.takeovers.push(customer.id);
        return { accepted: false, reason: ownEcho || event.automated ? "已忽略自动发送回声。" : "检测到商户人工回复，已转人工接管。" };
      }
      const job = { id: randomUUID(), customerId: customer.id, chatId: event.chatId, message: { id: event.id, text: event.text, date: event.date }, status: "queued", createdAt: iso(), updatedAt: iso() };
      const blocked = !armed ? { action: "ignored", reason: "回复服务尚未启动，消息不会补发。" } : gate(next, job);
      if (blocked && blocked.action !== "defer") {
        if (blocked.action === "handoff") setHandoff(next, job, blocked.reason);
        else { job.status = "ignored"; job.reason = blocked.reason; }
      }
      next.jobs.push(job);
      return { accepted: job.status === "queued", jobId: job.id, status: job.status };
    });
    schedule();
    return accepted;
  }

  async function claimWork() { if (typeof generate === "function") return { jobs: [] }; return { jobs: await reserveWork() }; }

  async function approve(jobId) {
    const result = await mutate((next) => {
      const job = next.jobs.find((item) => item.id === jobId);
      if (!job || job.status !== "draft") fail("只有待审核草稿可以批准发送。", 409);
      if (!armed || typeof send !== "function") fail("回复引擎或发送适配器尚未启动。", 409);
      const blocked = gate(next, job, false);
      if (blocked) fail(blocked.reason, 409);
      job.status = "ready"; job.updatedAt = iso(); job.reason = "商户已审核，等待发送。"; job.manuallyApproved = true;
      return publicJob(job);
    });
    schedule(); return result;
  }

  async function reject(jobId, reason = "商户已忽略此任务。") {
    const result = await mutate((next) => {
      const job = next.jobs.find((item) => item.id === jobId);
      if (!job || ["sending", "sent", "unknown"].includes(job.status)) fail("该任务不能撤回或重试，请核对微信实际状态。", 409);
      job.status = "cancelled"; job.reason = text(reason, 500) ? reason : "商户已忽略此任务。"; job.updatedAt = iso(); delete job.leaseId;
      return publicJob(job);
    });
    schedule(); return result;
  }

  async function takeover(input) {
    if (!input || !safeId(input.customerId) || typeof input.enabled !== "boolean") fail("人工接管参数不正确。");
    await mutate((next) => {
      const customer = next.config?.customers.find((item) => item.id === input.customerId);
      if (!customer) fail("未找到此客户。", 404);
      customer.humanTakeover = input.enabled;
      next.takeovers = next.takeovers.filter((id) => id !== input.customerId);
      if (input.enabled) {
        next.takeovers.push(input.customerId);
        for (const job of next.jobs) if (job.customerId === input.customerId && PENDING.has(job.status) && job.status !== "sending") setHandoff(next, job, "商户已接管此会话。");
      }
    });
    schedule(); return status();
  }

  async function close() {
    armed = false; closed = true; clearTimeout(pumpTimer); clearInterval(interval);
    for (const controller of generationControllers) controller.abort();
    await mutate((next) => {
      for (const job of next.jobs) {
        if (job.status === "sending") setHandoff(next, job, "服务在发送期间关闭，结果未知，必须人工核对。", "unknown");
        else if (job.status === "generating") { job.status = "queued"; delete job.leaseId; }
      }
    });
  }

  async function getConfig() { await chain; return copy(state.config); }
  return { syncConfig, getConfig, start, pause, ingest, status, claimWork, completeWork, approve, reject, takeover, close };
}
