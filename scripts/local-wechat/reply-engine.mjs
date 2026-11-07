import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, lstat } from "node:fs/promises";
import path from "node:path";
import { assertAdditiveEnrollment, isEnrollmentChatId } from "./reply-enrollment.mjs";
import { GenerationError, normalizeGenerationFailure } from "./reply-generation-errors.mjs";

export const DEFAULT_WELCOME_MESSAGE = "您好，欢迎光临！想了解店里的商品或服务，都可以在这里问我。";

export const DEFAULT_REPLY_SETTINGS = {
  enabled: false, mode: "review", selectedCustomerIds: [], autoEnrollNewContacts: true, welcomeEnabled: true, welcomeMessage: DEFAULT_WELCOME_MESSAGE,
  businessHours: { enabled: true, start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5, 6] },
  faq: [], handoffKeywords: ["退款", "退货", "改价", "投诉"], maxReplyChars: 300, cooldownSeconds: 30, debounceSeconds: 10, prompt: "",
};
const STATUSES = ["queued", "generating", "draft", "ready", "sending", "sent", "handoff", "failed", "unknown", "ignored", "cancelled"];
const PENDING = new Set(["queued", "generating", "draft", "ready", "sending"]);
const SENSITIVE = /退款|退货|退钱|改价|修改价格|调整价格|降价|砍价|还价|便宜一点|优惠一点|打折|折扣|赔偿|投诉|转人工|人工客服|真人/;
const QUOTED = /^\s*【(?:转账\/收款卡片|红包卡片|引用资料|转发内容)/u;
const RECENT_WELCOME_STATES = new Set(["queued", "draft", "ready", "sending", "sent"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const simpleGreeting = value => /^[\p{P}\s]*$/u.test(value) || /^(?:你好|您好|hi|hello|哈喽|嗨)$/iu.test(value.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, ""));

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
  const debounceSeconds = s?.debounceSeconds === undefined ? 10 : s.debounceSeconds;
  const autoEnrollNewContacts = s?.autoEnrollNewContacts === undefined ? true : s.autoEnrollNewContacts;
  const welcomeEnabled = s?.welcomeEnabled === undefined ? true : s.welcomeEnabled;
  const welcomeMessage = s?.welcomeMessage === undefined ? DEFAULT_WELCOME_MESSAGE : s.welcomeMessage;
  const h = s?.businessHours;
  const storeInfo = s?.storeInfo;
  if (!s || typeof s.enabled !== "boolean" || !["review", "auto"].includes(s.mode) || !Array.isArray(s.selectedCustomerIds) || s.selectedCustomerIds.length > 500 || s.selectedCustomerIds.some((id) => !safeId(id))) fail("请选择回复模式与客户白名单。");
  if (!Number.isInteger(debounceSeconds) || debounceSeconds < 0 || debounceSeconds > 3600) fail("等待客户说完的时间需要为0–3600整秒。");
  if (typeof autoEnrollNewContacts !== "boolean") fail("自动接待新私聊的设置需要为明确的开关。");
  if (typeof welcomeEnabled !== "boolean" || !text(welcomeMessage, 300, true) || !welcomeMessage.isWellFormed() || welcomeMessage.includes("\0") || Buffer.byteLength(welcomeMessage, "utf8") > 1023) fail("首次店铺介绍需要为300字以内的文本，且开关必须明确。");
  if (storeInfo !== undefined && (!storeInfo || Object.keys(storeInfo).some(key => !["contactName", "phone", "address", "serviceContent"].includes(key)) || storeInfo.contactName !== undefined && !text(storeInfo.contactName, 80, true) || !text(storeInfo.phone, 80, true) || !text(storeInfo.address, 500, true) || !text(storeInfo.serviceContent, 2000, true))) fail("店铺基础信息格式不正确。");
  if (!h || typeof h.enabled !== "boolean" || !clock(h.start) || !clock(h.end) || !Array.isArray(h.days) || h.days.length > 7 || h.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) fail("营业时间格式不正确。");
  if (!Number.isInteger(s.maxReplyChars) || s.maxReplyChars < 40 || s.maxReplyChars > 1000 || !Number.isInteger(s.cooldownSeconds) || s.cooldownSeconds < 0 || s.cooldownSeconds > 3600 || !text(s.prompt, 8000, true) || !Array.isArray(s.handoffKeywords) || s.handoffKeywords.length > 100 || s.handoffKeywords.some((word) => !text(word, 80))) fail("回复长度、冷却时间或人工规则格式不正确。");
  if (!Array.isArray(value.customers) || value.customers.length > 500 || value.customers.some((c) => !c || !safeId(c.id) || !text(c.name, 160) || typeof c.wechatId !== "string" || c.wechatId.length > 200 || (c.autoReplyEnabled !== undefined && typeof c.autoReplyEnabled !== "boolean") || (c.humanTakeover !== undefined && typeof c.humanTakeover !== "boolean") || (c.source !== undefined && !["demo", "manual", "wechat"].includes(c.source)))) fail("客户映射格式不正确。");
  if (new Set(value.customers.map((c) => c.id)).size !== value.customers.length) fail("客户 ID 不能重复。");
  if (!Array.isArray(value.products) || value.products.length > 200) fail("商品资料格式不正确。");
  const products = value.products.map((product) => {
    if (!product || !safeId(product.id) || !text(product.name, 160) || !["product", "service"].includes(product.type) || !(product.price === null || typeof product.price === "number" && Number.isFinite(product.price) && product.price >= 0 && product.price <= 100_000_000) || !text(product.description, 8000, true) || typeof product.enabled !== "boolean" || product.needsRestock !== undefined && typeof product.needsRestock !== "boolean" || product.source !== undefined && !["demo", "manual"].includes(product.source)) fail("商品名称、价格或服务资料格式不正确。");
    if (product.stock != null && (!Number.isInteger(product.stock) || product.stock < 0 || product.stock > 1_000_000_000) || product.restockThreshold !== undefined && (!Number.isInteger(product.restockThreshold) || product.restockThreshold < 0 || product.restockThreshold > 1_000_000_000)) fail("库存量与补货提醒值需要为0至10亿的整数，库存可留空。");
    return { id: product.id, name: product.name, type: product.type, price: product.price, ...(product.stock === undefined ? {} : { stock: product.stock }), ...(product.restockThreshold === undefined ? {} : { restockThreshold: product.restockThreshold }), description: product.description, faq: faqList(product.faq, 30), enabled: product.enabled, ...(product.needsRestock === undefined ? {} : { needsRestock: product.needsRestock }), ...(product.source === undefined ? {} : { source: product.source }) };
  });
  if (new Set(products.map((p) => p.id)).size !== products.length) fail("商品 ID 不能重复。");
  return {
    settings: { enabled: s.enabled, mode: s.mode, selectedCustomerIds: [...new Set(s.selectedCustomerIds)], autoEnrollNewContacts, welcomeEnabled, welcomeMessage, businessHours: { enabled: h.enabled, start: h.start, end: h.end, days: [...new Set(h.days)] }, ...(storeInfo ? { storeInfo: { ...(storeInfo.contactName === undefined ? {} : { contactName: storeInfo.contactName }), phone: storeInfo.phone, address: storeInfo.address, serviceContent: storeInfo.serviceContent } } : {}), faq: faqList(s.faq), handoffKeywords: [...s.handoffKeywords], maxReplyChars: s.maxReplyChars, cooldownSeconds: s.cooldownSeconds, debounceSeconds, prompt: s.prompt },
    customers: value.customers.map((c) => ({ id: c.id, wechatId: c.wechatId, name: c.name, ...(c.autoReplyEnabled !== undefined ? { autoReplyEnabled: c.autoReplyEnabled } : {}), ...(c.humanTakeover !== undefined ? { humanTakeover: c.humanTakeover } : {}), ...(c.source !== undefined ? { source: c.source } : {}) })),
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
  const sendManual = options.sendManual;
  let state = { version: 1, config: null, configRevision: 0, jobs: [], seen: [], takeovers: [], history: {}, lastSent: {}, welcomeOnce: {}, followupOnce: {}, manualOnce: {}, conversationVersions: {} };
  let hasFile = false;
  let armed = false;
  let closed = false;
  let pausedReason = "尚未启动自动回复。";
  let chain = Promise.resolve();
  let pumpTimer = null;
  let ticking = false;
  let sendBusy = false;
  const inflight = new Set();
  const generationControllers = new Map();

  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 40_000_000) fail("自动回复队列文件无法安全读取，请先备份检查。", 503);
    const loaded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(filename)));
    if (loaded.version !== 1 || !Array.isArray(loaded.jobs) || !Array.isArray(loaded.seen) || !Array.isArray(loaded.takeovers) || !loaded.history || !loaded.lastSent) fail("自动回复队列格式异常，原数据未被覆盖。", 503);
    if (loaded.welcomeOnce === undefined) loaded.welcomeOnce = {};
    if (loaded.followupOnce === undefined) loaded.followupOnce = {};
    if (loaded.manualOnce === undefined) loaded.manualOnce = {};
    if (loaded.conversationVersions === undefined) loaded.conversationVersions = {};
    if (!loaded.conversationVersions || Array.isArray(loaded.conversationVersions) || typeof loaded.conversationVersions !== "object" || Object.keys(loaded.conversationVersions).length > 5000 || Object.entries(loaded.conversationVersions).some(([id, value]) => !safeId(id) || !Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER)) fail("会话保护版本异常，原数据未被覆盖。", 503);
    if (!loaded.welcomeOnce || Array.isArray(loaded.welcomeOnce) || typeof loaded.welcomeOnce !== "object" || Object.keys(loaded.welcomeOnce).length > 500 || Object.entries(loaded.welcomeOnce).some(([chatId, record]) => !isEnrollmentChatId(chatId) || !record || !safeId(record.customerId) || !validDate(record.enrolledAt) || !["eligible", "queued", "skipped"].includes(record.state) || record.state === "queued" && (!safeId(record.jobId) || !safeId(record.eventId) || !validDate(record.date)))) fail("首次店铺介绍的防重记录异常，原数据未被覆盖。", 503);
    if (!loaded.followupOnce || Array.isArray(loaded.followupOnce) || typeof loaded.followupOnce !== "object" || Object.keys(loaded.followupOnce).length > 5000 || Object.entries(loaded.followupOnce).some(([taskId, record]) => !safeId(taskId) || !record || !safeId(record.jobId) || !safeId(record.customerId) || !/^[a-f0-9]{64}$/.test(record.textSha256))) fail("主动跟进防重记录异常，原数据未被覆盖。", 503);
    if (!loaded.manualOnce || Array.isArray(loaded.manualOnce) || typeof loaded.manualOnce !== "object" || Object.keys(loaded.manualOnce).length > 5000 || Object.entries(loaded.manualOnce).some(([requestId, record]) => !UUID.test(requestId) || !record || !safeId(record.jobId) || !safeId(record.sourceJobId) || !safeId(record.customerId) || !isEnrollmentChatId(record.chatId) || !/^[a-f0-9]{64}$/.test(record.textSha256))) fail("手动回复防重记录异常，原数据未被覆盖。", 503);
    if (loaded.jobs.some(job => job.kind !== undefined && !["reply", "welcome", "followup", "manual"].includes(job.kind))) fail("自动回复任务类型异常，原数据未被覆盖。", 503);
    if (loaded.jobs.some(job => job.kind === "followup" && (!safeId(job.taskId) || !safeId(job.customerId) || !text(job.reply, 300)))) fail("主动跟进任务格式异常，原数据未被覆盖。", 503);
    if (loaded.jobs.some(job => job.kind === "manual" && (!safeId(job.sourceJobId) || !UUID.test(job.requestId || "") || !safeId(job.customerId) || !isEnrollmentChatId(job.chatId) || !text(job.reply, 300) || !job.reply.isWellFormed() || job.reply.includes("\0") || Buffer.byteLength(job.reply, "utf8") > 1023))) fail("手动回复任务格式异常，原数据未被覆盖。", 503);
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
      if (job.kind === "manual" && PENDING.has(job.status)) { job.status = "unknown"; job.reason = "手动回复在服务重启前尚未确认，必须核对微信；不会自动重发。"; if (!next.takeovers.includes(job.customerId)) next.takeovers.push(job.customerId); }
      else if (job.status === "sending") { job.status = "unknown"; job.reason = "服务在发送期间中断，必须人工核对微信，不能自动重发。"; if (!next.takeovers.includes(job.customerId)) next.takeovers.push(job.customerId); }
      else if (job.status === "generating") { job.status = "queued"; delete job.leaseId; }
      else if (job.status === "ready") { job.status = "draft"; job.reason = "服务已重启，请重新审核该回复。"; }
      if (!job.messages) job.messages = [copy(job.message)];
      if (job.kind === "welcome" && !Object.hasOwn(next.welcomeOnce, job.chatId)) {
        if (Object.keys(next.welcomeOnce).length >= 500) fail("首次店铺介绍防重容量已满，原队列未被覆盖。", 503);
        next.welcomeOnce = { ...next.welcomeOnce, [job.chatId]: { customerId: job.customerId, enrolledAt: job.createdAt, state: "queued", jobId: job.id, eventId: job.message.id, date: job.message.date } };
      }
      if (job.kind === "followup" && !Object.hasOwn(next.followupOnce, job.taskId)) {
        if (!safeId(job.taskId) || !safeId(job.customerId) || !text(job.reply, 300) || Object.keys(next.followupOnce).length >= 5000) fail("主动跟进防重记录异常，原队列未被覆盖。", 503);
        next.followupOnce = { ...next.followupOnce, [job.taskId]: { jobId: job.id, customerId: job.customerId, textSha256: createHash("sha256").update(job.reply, "utf8").digest("hex") } };
      }
      if (job.kind === "manual") {
        if (["failed", "unknown", "handoff"].includes(job.status)) { job.autoResumeStatus = "blocked"; job.autoResumeReason = "发送尚未核实成功，继续保留人工处理。"; }
        // 旧成功记录不具备本次恢复保护凭据，不能在升级或重启时顺带释放人工接管。
        if (job.status === "sent" && job.autoResumeStatus !== "restored") { job.autoResumeStatus = "blocked"; job.autoResumeReason = "旧记录或重启前的恢复尚未核实，请人工核对托管状态。"; }
        const record = { jobId: job.id, sourceJobId: job.sourceJobId, customerId: job.customerId, chatId: job.chatId, textSha256: createHash("sha256").update(job.reply, "utf8").digest("hex") };
        if (Object.hasOwn(next.manualOnce, job.requestId) && JSON.stringify(next.manualOnce[job.requestId]) !== JSON.stringify(record)) fail("手动回复任务与防重记录不一致，原队列未被覆盖。", 503);
        if (!Object.hasOwn(next.manualOnce, job.requestId)) {
          if (Object.keys(next.manualOnce).length >= 5000) fail("手动回复防重容量已满，原队列未被覆盖。", 503);
          next.manualOnce[job.requestId] = record;
        }
      }
      if (job.kind === "welcome" && job.quietUntil === undefined) job.quietUntil = 0;
      if (job.kind !== "welcome" && job.status === "queued" && job.quietUntil === undefined) {
        job.lastIncomingAt = Date.parse(job.updatedAt || job.createdAt);
        if (!Number.isFinite(job.lastIncomingAt)) fail("旧回复任务缺少有效时间，原队列未被覆盖。", 503);
        job.quietUntil = job.lastIncomingAt + (next.config?.settings.debounceSeconds ?? 10) * 1000;
      }
    }
  });

  function customerFor(next, job) { return next.config?.customers.find((customer) => customer.id === job.customerId && customer.wechatId === job.chatId); }
  function bumpConversation(next, customerId) {
    const previous = Object.hasOwn(next.conversationVersions, customerId) ? next.conversationVersions[customerId] : 0;
    if (!Number.isSafeInteger(previous) || previous >= Number.MAX_SAFE_INTEGER - 1 || !Object.hasOwn(next.conversationVersions, customerId) && Object.keys(next.conversationVersions).length >= 5000) fail("会话保护版本容量已满，未释放人工接管。", 503);
    next.conversationVersions = { ...next.conversationVersions, [customerId]: previous + 1 };
    return previous + 1;
  }
  function gate(next, job, checkCooldown = true) {
    const config = next.config;
    if (!config?.settings.enabled) return { action: "ignored", reason: "全局自动回复尚未启用。" };
    const customer = customerFor(next, job);
    if (!customer || !privateId(job.chatId) || !config.settings.selectedCustomerIds.includes(customer.id) || customer.autoReplyEnabled === false) return { action: "ignored", reason: "该好友不在已启用的客户白名单中。" };
    if (customer.humanTakeover || next.takeovers.includes(customer.id)) return { action: "handoff", reason: "该会话已转人工接管。" };
    if (job.kind === "welcome") {
      if (!config.settings.welcomeEnabled || !config.settings.welcomeMessage.trim()) return { action: "ignored", reason: "首次店铺介绍已关闭或文案为空。" };
      if (job.reply !== config.settings.welcomeMessage) return { action: "handoff", reason: "首次店铺介绍文案已变化，请人工核对，未发送旧文案。" };
    }
    if (!isBusinessOpen(config.settings.businessHours, now())) return { action: job.kind === "welcome" ? "defer" : "ignored", reason: "当前不在配置的营业时间内。" };
    if (job.kind === "welcome" || job.kind === "followup") {
      if (checkCooldown && next.lastSent[job.chatId] !== undefined && now() - next.lastSent[job.chatId] < config.settings.cooldownSeconds * 1000) return { action: "defer", reason: "等待会话冷却时间。" };
      return null;
    }
    const messages = job.messages || [job.message];
    if (messages.length > 50 || job.message.text.length > 8000) return { action: "handoff", reason: "连续消息超过单次处理容量，请人工处理，原始消息已保留。" };
    if (messages.some((message) => QUOTED.test(message.text))) return { action: "handoff", reason: "引用、转发或支付卡片需人工确认。" };
    if (messages.some((message) => SENSITIVE.test(message.text) || config.settings.handoffKeywords.some((word) => message.text.toLowerCase().includes(word.toLowerCase())))) return { action: "handoff", reason: "售后、改价或特殊需求需要人工处理。" };
    if (checkCooldown && next.lastSent[job.chatId] !== undefined && now() - next.lastSent[job.chatId] < config.settings.cooldownSeconds * 1000) return { action: "defer", reason: "等待会话冷却时间。" };
    return null;
  }

  function setHandoff(next, job, reason, status = "handoff", lockConversation = true) {
    generationControllers.get(job.leaseId)?.abort();
    job.status = status; job.reason = reason; job.updatedAt = iso();
    delete job.leaseId;
    if (job.kind === "manual") { job.autoResumeStatus = "blocked"; job.autoResumeReason = "发送尚未核实成功，继续保留人工处理。"; }
    if (lockConversation) { bumpConversation(next, job.customerId); if (!next.takeovers.includes(job.customerId)) next.takeovers.push(job.customerId); }
  }

  function publicJob(job) {
    return { id: job.id, kind: job.kind || "reply", ...(job.kind === "followup" ? { taskId: job.taskId } : {}), ...(job.kind === "manual" ? { sourceJobId: job.sourceJobId, requestId: job.requestId, ...(job.autoResumeStatus ? { autoResumeStatus: job.autoResumeStatus } : {}), ...(job.autoResumeReason ? { autoResumeReason: job.autoResumeReason } : {}) } : {}), ...(job.resolvedAt ? { resolvedAt: job.resolvedAt, resolvedByManualJobId: job.resolvedByManualJobId } : {}), customerId: job.customerId, chatId: job.chatId, message: copy(job.message), messages: copy(job.messages || [job.message]), ...(job.quietUntil !== undefined ? { quietUntil: new Date(job.quietUntil).toISOString() } : {}), status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt, ...(job.reply ? { reply: job.reply } : {}), ...(job.reason ? { reason: job.reason } : {}), ...(job.failureCode ? { failureCode: normalizeGenerationFailure({ code: job.failureCode }).code } : {}), ...(job.sendMessageId ? { sendMessageId: job.sendMessageId } : {}) };
  }

  async function status() {
    await chain;
    const counts = Object.fromEntries(STATUSES.map((name) => [name, state.jobs.filter((job) => job.status === name && !job.resolvedAt).length]));
    return { running: armed && !closed, generatorMode: typeof generate === "function" ? "background" : "browser", configReady: !!state.config, counts, jobs: state.jobs.slice(-200).reverse().map(publicJob), submittedFollowups: Object.entries(state.followupOnce).map(([taskId, record]) => ({ taskId, jobId: record.jobId })), takeovers: [...state.takeovers], pausedReason: armed ? undefined : pausedReason };
  }

  function schedule() {
    if (closed || !armed && !state.jobs.some(job => job.kind === "manual" && job.status === "ready") || pumpTimer) return;
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

  async function prepareWelcomes() {
    if (!armed || closed || !state.jobs.some(job => job.kind === "welcome" && job.status === "queued")) return;
    await mutate(next => {
      if (!armed || closed) return;
      for (const job of next.jobs) {
        if (job.kind !== "welcome" || job.status !== "queued" || !head(next, job)) continue;
        const blocked = gate(next, job);
        if (blocked) {
          if (blocked.action === "defer") continue;
          if (blocked.action === "handoff") setHandoff(next, job, blocked.reason);
          else { job.status = "ignored"; job.reason = blocked.reason; job.updatedAt = iso(); }
          continue;
        }
        job.status = next.config.settings.mode === "auto" ? "ready" : "draft";
        job.configRevision = next.configRevision;
        job.reason = job.status === "ready" ? "首次店铺介绍已按保存文案排队，不调用AI。" : "首次店铺介绍待人工审阅，不调用AI。";
        job.updatedAt = iso();
      }
    });
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
        if (!capacity || ["welcome", "followup", "manual"].includes(job.kind) || job.status !== "queued" || !head(next, job) || now() < (job.quietUntil || 0)) continue;
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
        jobs.push({ id: job.id, leaseId: job.leaseId, customerId: job.customerId, message: copy(job.message), messages: copy(job.messages || [job.message]), context });
        capacity -= 1;
      }
      return jobs;
    });
  }

  function resultInput(value) {
    if (!value || !["reply", "handoff", "ignore", "clarify"].includes(value.action) || !text(value.reply, 4000, true) || !text(value.reason, 800) || value.productIds !== undefined && (!Array.isArray(value.productIds) || value.productIds.length > 20 || value.productIds.some((id) => !safeId(id)))) throw new GenerationError("AI_RESPONSE_FORMAT", 400);
    return { action: value.action, reply: value.reply.trim(), reason: value.reason, productIds: value.productIds || [] };
  }

  function outputBlock(next, result) {
    if (!result.reply || result.reply.length > next.config.settings.maxReplyChars) return "回复为空或超过配置长度。";
    if (/已为您退款|已经退款|已退款|已改价|已调整价格|保证有效|一定有效|百分之百|100%/.test(result.reply)) return "回复包含未经人工授权的操作或效果承诺。";
    const products = next.config.products.filter((product) => product.enabled);
    if (result.productIds.some((id) => !products.some((product) => product.id === id))) return "回复引用了未启用的商品或服务。";
    const money = new Set(products.filter((product) => product.price !== null).map((product) => product.price));
    const facts = [...next.config.settings.faq.map((faq) => faq.answer), next.config.settings.storeInfo?.serviceContent || '', ...products.flatMap((product) => [product.description, ...product.faq.map((faq) => faq.answer)])];
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
      if (input.error !== undefined) {
        const failure = normalizeGenerationFailure({ code: input.failureCode });
        job.failureCode = failure.code;
        setHandoff(next, job, failure.reason, "failed");
        return publicJob(job);
      }
      const blocked = gate(next, job, false);
      if (blocked && blocked.action !== "defer") { setHandoff(next, job, blocked.reason); return publicJob(job); }
      if (job.configRevision !== next.configRevision) { setHandoff(next, job, "生成期间门店资料或规则已变化，请人工审核。"); return publicJob(job); }
      // AI资料不足只交人工处理本条问题；明确接管与发送异常仍锁住整段会话。
      if (result.action === "handoff") { setHandoff(next, job, result.reason, "handoff", false); return publicJob(job); }
      if (result.action === "ignore") {
        // 模型结合语境判断无需回复时保留原因，不发送，也不把客户转交人工。
        job.status = "ignored"; job.reason = result.reason; job.updatedAt = iso(); delete job.leaseId; delete job.leaseUntil; delete job.reply; delete job.productIds;
        return publicJob(job);
      }
      const denied = outputBlock(next, result);
      if (denied) { setHandoff(next, job, denied); return publicJob(job); }
      job.reply = result.reply; job.productIds = result.productIds; job.reason = result.reason; job.status = armed && next.config.settings.mode === "auto" ? "ready" : "draft"; job.updatedAt = iso(); delete job.leaseId;
      return publicJob(job);
    });
    schedule();
    return completed;
  }

  async function sendNext() {
    if (sendBusy || closed || !state.jobs.some(job => job.status === "ready" && (job.kind === "manual" ? typeof sendManual === "function" : armed && typeof send === "function"))) return false;
    sendBusy = true;
    try {
      const packet = await mutate((next) => {
        if (closed) return null;
        for (const job of next.jobs) {
          if (job.status !== "ready" || !head(next, job) || now() < (job.quietUntil || 0)) continue;
          const manual = job.kind === "manual";
          if (manual ? typeof sendManual !== "function" : !armed || typeof send !== "function") continue;
          const blocked = manual ? manualGate(next, job) : gate(next, job);
          if (blocked) { if (blocked.action !== "defer") setHandoff(next, job, blocked.reason); continue; }
          if (!manual && job.kind !== "welcome" && job.configRevision !== next.configRevision && !job.manuallyApproved) { setHandoff(next, job, "发送前门店资料已变化，请人工审核。"); continue; }
          const denied = manual || job.kind === "welcome" ? "" : outputBlock(next, { reply: job.reply, productIds: job.productIds || [] });
          if (denied) { setHandoff(next, job, denied); continue; }
          job.status = "sending"; job.updatedAt = iso(); job.sendStartedAt = iso();
          return { jobId: job.id, chatId: job.chatId, text: job.reply, idempotencyKey: manual ? `manual:${job.requestId}` : job.id, manual };
        }
        return null;
      });
      if (!packet) return false;
      const current = state.jobs.find((job) => job.id === packet.jobId);
      const blocked = current && (packet.manual ? manualGate(state, current) : gate(state, current, false));
      if (!armed && !packet.manual || closed || blocked) {
        await mutate((next) => {
          const job = next.jobs.find((item) => item.id === packet.jobId);
          if (job?.status === "sending") {
            if (job.kind === "welcome" && blocked?.action === "defer") { job.status = "queued"; job.reason = blocked.reason; job.updatedAt = iso(); }
            else if (blocked) setHandoff(next, job, blocked.reason);
            else { job.status = "draft"; job.reason = "发送前服务已暂停，未调用发送适配器。"; }
          }
        });
        return false;
      }
      let result;
      try { result = await (packet.manual ? sendManual : send)({ chatId: packet.chatId, text: packet.text, idempotencyKey: packet.idempotencyKey }); }
      catch { result = { status: "unknown", error: "发送适配器中断，结果未知，请人工核对微信。" }; }
      await mutate((next) => {
        const job = next.jobs.find((item) => item.id === packet.jobId);
        if (!job || job.status !== "sending") return;
        if (result?.status === "sent" && safeId(result.messageId)) {
          job.status = "sent"; job.reason = "微信适配器已确认发送。"; job.updatedAt = iso();
          if (safeId(result.messageId)) job.sendMessageId = result.messageId;
          next.lastSent[job.chatId] = now();
          const history = next.history[job.chatId] || [];
          // 严格发送回执已确认的正文立即进入对话上下文，不等待下一轮导出回声。
          history.push({ id: result.messageId, nativeMessageId: result.messageId, sender: "merchant", text: job.reply, date: validDate(job.sendStartedAt) ? job.sendStartedAt : iso() });
          next.history[job.chatId] = history.slice(-100);
          if (job.kind === "manual") { job.autoResumeStatus = "pending"; job.autoResumeReason = "消息已核实发送，正在核对托管恢复条件。"; }
        } else setHandoff(next, job, result?.status === "failed" ? "适配器确认未发送成功，请人工处理，不会自动重试。" : "发送结果未知，请核对微信实际记录，禁止自动重发。", result?.status === "failed" ? "failed" : "unknown");
      });
      if (packet.manual && state.jobs.find(job => job.id === packet.jobId)?.status === "sent") await resumeManualJob(packet.jobId);
      return true;
    } finally { sendBusy = false; }
  }

  async function tick() {
    if (ticking || closed || !armed && !state.jobs.some(job => job.kind === "manual" && job.status === "ready")) return;
    ticking = true;
    try {
      if (armed) await prepareWelcomes();
      if (armed && typeof generate === "function") {
        const work = await reserveWork();
        for (const item of work) {
          const controller = new AbortController(); generationControllers.set(item.leaseId, controller);
          track((async () => {
            try { const result = await generate(copy(item), { signal: controller.signal }); if (!closed) await completeWork({ jobId: item.id, leaseId: item.leaseId, result }); }
            catch (error) {
              if (!closed) {
                const failure = normalizeGenerationFailure(error);
                try { await completeWork({ jobId: item.id, leaseId: item.leaseId, error: failure.reason, failureCode: failure.code }); }
                catch { /* 过期或已接管的任务不会重新发送。 */ }
              }
            }
            finally { generationControllers.delete(item.leaseId); }
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
      for (const job of next.jobs) if (!["welcome", "followup", "manual"].includes(job.kind) && job.status === "queued" && job.lastIncomingAt !== undefined) job.quietUntil = job.lastIncomingAt + config.settings.debounceSeconds * 1000;
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
    if ((!selected.length && !state.config.settings.autoEnrollNewContacts) || selected.some((c) => !privateId(c.wechatId))) fail("请先选择具有准确微信标识的好友客户，或开启自动接待新私聊。");
    if (state.config.settings.mode === "auto" && typeof send !== "function") fail("微信发送适配器尚未配置，不能启动自动发送。", 503);
    armed = true; pausedReason = ""; schedule(); return status();
  }

  async function pause(reason) { armed = false; pausedReason = text(reason, 500) ? reason : "商户已暂停自动回复。"; await chain; return status(); }

  async function enrollCustomers(value) {
    if (!Array.isArray(value?.settings?.selectedCustomerIds) || new Set(value.settings.selectedCustomerIds).size !== value.settings.selectedCustomerIds.length) fail("新客户接待范围包含重复标识。", 409);
    const config = configInput(value);
    return mutate(next => {
      if (closed || !armed) fail("本机接待已暂停，不能自动追加客户。", 409);
      let added;
      try { added = assertAdditiveEnrollment(next.config, config); }
      catch { fail("新客户接待范围只能追加；原有规则或客户已变化，请重新核对后启动。", 409); }
      for (const customerId of added) {
        const customer = config.customers.find(item => item.id === customerId);
        if (!Object.hasOwn(next.welcomeOnce, customer.wechatId)) {
          if (Object.keys(next.welcomeOnce).length >= 500) fail("首次店铺介绍防重容量已满，请人工处理新客户。", 503);
          next.welcomeOnce = { ...next.welcomeOnce, [customer.wechatId]: { customerId, enrolledAt: iso(), state: "eligible" } };
        }
      }
      // 追加客户不改变旧会话生成依据，也不重算任何等待截止时间。
      next.config = config;
      return { configured: true, added: added.length };
    });
  }

  // 只供已核验本机发现流程调用；正文固定取已保存文案，不接受外部自定义消息。
  async function enqueueWelcome(input) {
    if (!input || Array.isArray(input) || Object.keys(input).some(key => !["chatId", "eventId", "date"].includes(key)) || !isEnrollmentChatId(input.chatId) || !safeId(input.eventId) || !validDate(input.date)) fail("首次店铺介绍事件格式不正确。");
    const result = await mutate(next => {
      if (closed || !armed || !next.config?.settings.enabled) return { accepted: false, reason: "本机接待尚未运行，不补发首次介绍。" };
      const record = Object.hasOwn(next.welcomeOnce, input.chatId) ? next.welcomeOnce[input.chatId] : null;
      if (!record) return { accepted: false, reason: "此会话没有新客户接纳资格，不向已有客户补发。" };
      if (record.state !== "eligible") return { accepted: false, duplicate: true, ...(record.jobId ? { jobId: record.jobId } : {}) };
      const matches = next.config.customers.filter(customer => customer.wechatId === input.chatId);
      const customer = matches[0];
      const settings = next.config.settings;
      if (!settings.autoEnrollNewContacts || matches.length !== 1 || customer.id !== record.customerId || !settings.selectedCustomerIds.includes(customer.id) || customer.autoReplyEnabled !== true || customer.humanTakeover || next.takeovers.includes(customer.id) || !settings.welcomeEnabled || !settings.welcomeMessage.trim()) {
        record.state = "skipped";
        return { accepted: false, reason: "该客户未授权接待、已接管或首次介绍关闭／为空，不会补发。" };
      }
      if (next.jobs.length >= 5000) fail("本地队列容量已满，未创建首次店铺介绍。", 503);
      const message = { id: input.eventId, text: "新客户首次接待：发送已保存的店铺介绍。", date: input.date };
      const job = { id: randomUUID(), kind: "welcome", customerId: customer.id, chatId: input.chatId, message, messages: [copy(message)], reply: settings.welcomeMessage, status: "queued", quietUntil: now(), configRevision: next.configRevision, createdAt: iso(), updatedAt: iso(), reason: "首次店铺介绍已排队，等待营业时段及当前发送规则。" };
      const firstPending = next.jobs.findIndex(previous => previous.chatId === input.chatId && PENDING.has(previous.status) && previous.status !== "sending");
      if (firstPending < 0) next.jobs.push(job); else next.jobs.splice(firstPending, 0, job);
      next.welcomeOnce = { ...next.welcomeOnce, [input.chatId]: { ...record, state: "queued", jobId: job.id, eventId: input.eventId, date: input.date } };
      return { accepted: true, jobId: job.id, status: job.status };
    });
    schedule();
    return result;
  }

  // 只接收本机服务核对过的已保存任务，点击即表示商家批准发送当前文案。
  async function enqueueFollowup(input) {
    if (!input || Array.isArray(input) || Object.keys(input).some(key => !["taskId", "customerId", "text"].includes(key)) || !safeId(input.taskId) || !safeId(input.customerId) || !text(input.text, 300) || !input.text.isWellFormed() || input.text.includes("\0") || Buffer.byteLength(input.text, "utf8") > 1023) fail("跟进任务需要明确客户及300字以内的已保存消息草稿。");
    const digest = createHash("sha256").update(input.text, "utf8").digest("hex");
    const result = await mutate(next => {
      if (closed || !armed || !next.config?.settings.enabled) fail("本机接待已暂停，请先到自动回复页确认并启动。", 409);
      if (typeof send !== "function") fail("微信发送组件尚未接通，不能发送主动跟进。", 503);
      const previous = Object.hasOwn(next.followupOnce, input.taskId) ? next.followupOnce[input.taskId] : null;
      if (previous) {
        if (previous.customerId !== input.customerId || previous.textSha256 !== digest) fail("同一跟进任务已提交，不能更换客户或正文后再次发送，请新建跟进任务。", 409);
        const job = next.jobs.find(item => item.id === previous.jobId);
        return { accepted: false, duplicate: true, jobId: previous.jobId, status: job?.status || "unknown" };
      }
      const matches = next.config.customers.filter(customer => customer.id === input.customerId);
      const customer = matches[0];
      if (matches.length !== 1 || customer.source === "demo" || !isEnrollmentChatId(customer.wechatId) || next.config.customers.filter(item => item.wechatId === customer.wechatId).length !== 1 || !next.config.settings.selectedCustomerIds.includes(customer.id) || customer.autoReplyEnabled !== true) fail("此客户未加入当前已启用的真实私聊接待范围，不能直接发送跟进。", 409);
      const message = { id: input.taskId, text: "商家主动跟进：发送已保存的消息草稿。", date: iso() };
      const job = { id: randomUUID(), kind: "followup", taskId: input.taskId, customerId: customer.id, chatId: customer.wechatId, message, messages: [copy(message)], reply: input.text, status: "ready", quietUntil: now(), configRevision: next.configRevision, manuallyApproved: true, createdAt: iso(), updatedAt: iso(), reason: "商家已批准本次跟进，按现有私聊队列顺序发送。" };
      const blocked = gate(next, job);
      if (blocked && blocked.action !== "defer") fail(blocked.reason, 409);
      const denied = outputBlock(next, { reply: job.reply, productIds: [] });
      if (denied) fail(denied);
      if (next.jobs.length >= 5000 || Object.keys(next.followupOnce).length >= 5000) fail("主动跟进队列或防重记录已满，未提交新的发送。", 503);
      next.jobs.push(job);
      next.followupOnce = { ...next.followupOnce, [input.taskId]: { jobId: job.id, customerId: customer.id, textSha256: digest } };
      return { accepted: true, jobId: job.id, status: job.status };
    });
    schedule();
    return result;
  }

  async function ingest(event) {
    if (closed) fail("本地回复引擎已关闭。", 503);
    if (!event || !safeId(event.id) || !privateId(event.chatId) || !["customer", "merchant", "system"].includes(event.sender) || !text(event.text, 8000, event.sender === "customer") || !validDate(event.date)) fail("实时消息缺少稳定标识或有效内容。");
    const accepted = await mutate((next) => {
      const key = `${event.chatId}\u0000${event.id}`;
      const nativeKey = safeId(event.nativeMessageId) ? `${event.chatId}\u0000native:${event.nativeMessageId}` : null;
      if (next.seen.includes(key) || nativeKey && next.seen.includes(nativeKey)) return { accepted: false, duplicate: true };
      if (next.seen.length >= 50_000 || next.jobs.length >= 5000) fail("本地队列容量已满，已停止接收新任务，请暂停并整理记录。", 503);
      next.seen.push(key);
      if (nativeKey) next.seen.push(nativeKey);
      if ((event.source || "realtime") !== "realtime") return { accepted: false, reason: "历史导入与营销任务不进入自动回复队列。" };
      const matches = next.config?.customers.filter((customer) => customer.wechatId === event.chatId) || [];
      if (matches.length !== 1) return { accepted: false, reason: "会话无法唯一映射到已配置客户。" };
      const customer = matches[0];
      if (event.sender === "system" || (event.kind && event.kind !== "text")) return { accepted: false, reason: "系统或非文字消息需人工处理。" };
      const history = next.history[event.chatId] || [];
      const confirmedEcho = event.sender === "merchant" && safeId(event.nativeMessageId) && next.jobs.some(job => job.chatId === event.chatId && job.status === "sent" && job.sendMessageId === event.nativeMessageId && job.reply === event.text);
      if (confirmedEcho && history.some(message => message.sender === "merchant" && message.text === event.text && (message.nativeMessageId === event.nativeMessageId || message.id === event.nativeMessageId))) return { accepted: false, duplicate: true, reason: "已核实的发送回声已在对话记录中，保留消息审计但不重复写入。" };
      history.push({ id: event.id, ...(safeId(event.nativeMessageId) ? { nativeMessageId: event.nativeMessageId } : {}), sender: event.sender, text: event.text, date: event.date });
      next.history[event.chatId] = history.slice(-100);
      if (event.sender === "merchant") {
        const ownEcho = next.jobs.some((job) => job.chatId === event.chatId && ["sending", "sent"].includes(job.status) && job.reply === event.text && (safeId(event.nativeMessageId) ? event.nativeMessageId === job.sendMessageId : now() - Date.parse(job.sendStartedAt || job.updatedAt) < 120_000));
        if (event.automated !== true && !ownEcho) {
          bumpConversation(next, customer.id);
          if (!next.takeovers.includes(customer.id)) next.takeovers.push(customer.id);
          for (const pending of next.jobs) if (pending.chatId === event.chatId && PENDING.has(pending.status) && pending.status !== "sending") setHandoff(next, pending, "检测到商户人工回复，已停止该会话的待发送回复。");
        }
        return { accepted: false, reason: ownEcho || event.automated ? "已忽略自动发送回声。" : "检测到商户人工回复，已转人工接管。" };
      }
      bumpConversation(next, customer.id);
      const welcome = next.jobs.find(job => job.kind === "welcome" && job.chatId === event.chatId && RECENT_WELCOME_STATES.has(job.status));
      const welcomeAge = welcome ? now() - Date.parse(welcome.sendStartedAt || welcome.createdAt) : Infinity;
      const needsHandoff = SENSITIVE.test(event.text) || next.config.settings.handoffKeywords.some(word => event.text.toLowerCase().includes(word.toLowerCase()));
      // 首次介绍附近的简单招呼只留作审计，不再生成第二份介绍，也不延后实质问题。
      if (welcomeAge >= 0 && welcomeAge <= 120_000 && !needsHandoff && !customer.humanTakeover && !next.takeovers.includes(customer.id) && simpleGreeting(event.text)) return { accepted: false, status: "ignored", reason: "首次店铺介绍已安排，已记录简单招呼，不再生成重复介绍。" };
      if (!event.text.trim()) fail("实时消息缺少稳定标识或有效内容。");
      // 仅合并尚未交给发送适配器的消息；发送中的批次保留，新消息另起一批。
      const pending = next.jobs.filter((item) => !["welcome", "followup", "manual"].includes(item.kind) && item.chatId === event.chatId && item.customerId === customer.id && ["queued", "generating", "draft", "ready"].includes(item.status));
      const job = pending[0] || { id: randomUUID(), kind: "reply", customerId: customer.id, chatId: event.chatId, createdAt: iso() };
      const messages = pending.flatMap((item) => item.messages || [item.message]);
      messages.push({ id: event.id, ...(safeId(event.nativeMessageId) ? { nativeMessageId: event.nativeMessageId } : {}), text: event.text, date: event.date });
      const seenMessages = new Set();
      job.messages = messages.filter((message) => !seenMessages.has(message.id) && seenMessages.add(message.id));
      const last = job.messages.at(-1);
      job.message = { id: last.id, text: job.messages.map((message) => message.text).join("\n"), date: last.date };
      for (const previous of pending) {
        generationControllers.get(previous.leaseId)?.abort();
        delete previous.leaseId; delete previous.leaseUntil; delete previous.reply; delete previous.productIds; delete previous.manuallyApproved;
        if (previous !== job) { previous.status = "cancelled"; previous.reason = "已合并到同一会话的连续消息批次。"; previous.mergedInto = job.id; previous.updatedAt = iso(); }
      }
      job.status = "queued"; job.lastIncomingAt = now(); job.quietUntil = now() + (next.config.settings.debounceSeconds ?? 10) * 1000; job.updatedAt = iso(); job.reason = "等待客户说完后合并回复。";
      const blocked = !armed ? { action: "ignored", reason: "回复服务尚未启动，消息不会补发。" } : gate(next, job);
      if (blocked && blocked.action !== "defer") {
        if (blocked.action === "handoff") setHandoff(next, job, blocked.reason);
        else { job.status = "ignored"; job.reason = blocked.reason; }
      }
      if (!pending.length) next.jobs.push(job);
      if (blocked?.action === "handoff") for (const previous of next.jobs) if (previous.chatId === event.chatId && previous !== job && PENDING.has(previous.status) && previous.status !== "sending") setHandoff(next, previous, blocked.reason);
      return { accepted: job.status === "queued", jobId: job.id, status: job.status, merged: pending.length > 0 };
    });
    schedule();
    return accepted;
  }

  function manualGate(next, job) {
    const matches = (next.config?.customers || []).filter(customer => customer.id === job.customerId && customer.wechatId === job.chatId);
    if (matches.length !== 1 || matches[0].source === "demo" || !isEnrollmentChatId(job.chatId) || next.config.customers.filter(customer => customer.wechatId === job.chatId).length !== 1) return { action: "handoff", reason: "手动回复的客户映射已变化，请核对后重新操作。" };
    return null;
  }

  async function prepareManual(input, resumeSnapshot = {}) {
    if (!input || Array.isArray(input) || Object.keys(input).some(key => !["jobId", "requestId", "text"].includes(key)) || !UUID.test(input.jobId || "") || !UUID.test(input.requestId || "") || !text(input.text, 300) || !input.text.isWellFormed() || input.text.includes("\0") || Buffer.byteLength(input.text, "utf8") > 1023) fail("手动回复需要原任务编号、唯一请求编号及300字以内的消息。");
    const manualText = input.text.trim();
    const digest = createHash("sha256").update(manualText, "utf8").digest("hex");
    return mutate(next => {
      if (closed) fail("本地回复引擎已关闭。", 503);
      const previous = Object.hasOwn(next.manualOnce, input.requestId) ? next.manualOnce[input.requestId] : null;
      if (previous) {
        if (previous.sourceJobId !== input.jobId || previous.textSha256 !== digest) fail("同一手动回复请求不能更换原任务或正文。", 409);
        const job = next.jobs.find(item => item.id === previous.jobId);
        if (!job) fail("手动回复防重记录存在但任务缺失，请核对微信，不能重发。", 409);
        return { duplicate: true, job: publicJob(job) };
      }
      if (typeof sendManual !== "function") fail("当前本机发送器不支持单次手动回复，请启用原生后台发送组件。", 503);
      const source = next.jobs.find(job => job.id === input.jobId);
      if (!source) fail("原接待任务不存在，请刷新处理队列。", 404);
      const blocked = manualGate(next, source);
      if (blocked) fail(blocked.reason, 409);
      if (next.jobs.some(job => job.chatId === source.chatId && job.status === "sending")) fail("该客户有消息正在发送，请等待结果确认后再手动回复。", 409);
      if (next.jobs.length >= 5000 || Object.keys(next.manualOnce).length >= 5000) fail("手动回复队列或防重记录已满，未发送。", 503);
      const customer = customerFor(next, source);
      customer.humanTakeover = true;
      if (!next.takeovers.includes(source.customerId)) next.takeovers.push(source.customerId);
      const conversationVersion = bumpConversation(next, source.customerId);
      // 人工明确接待后取消尚未发送的自动内容，已核实的历史和发送结果保持原样。
      for (const pending of next.jobs) if (pending.chatId === source.chatId && pending.kind !== "manual" && PENDING.has(pending.status)) {
        generationControllers.get(pending.leaseId)?.abort();
        pending.status = pending === source ? "handoff" : "cancelled"; pending.reason = "商家已开始手动回复，已停止本条自动发送，等待手动发送核实。"; pending.updatedAt = iso(); delete pending.leaseId; delete pending.leaseUntil;
      }
      const job = { id: randomUUID(), kind: "manual", sourceJobId: source.id, requestId: input.requestId, customerId: source.customerId, chatId: source.chatId, message: copy(source.message), messages: copy(source.messages || [source.message]), reply: manualText, status: "draft", quietUntil: now(), createdAt: iso(), updatedAt: iso(), reason: "手动回复已保存，等待本机核验客户与单次发送授权。", autoResumeStatus: "pending", autoResumeReason: "发送核实成功后才会恢复托管并完成原问题。", autoResumeGuard: { conversationVersion, configRevision: next.configRevision, ...(Number.isSafeInteger(resumeSnapshot.persistedRevision) && resumeSnapshot.persistedRevision >= 0 ? { persistedRevision: resumeSnapshot.persistedRevision } : {}) } };
      next.jobs.push(job);
      next.manualOnce[input.requestId] = { jobId: job.id, sourceJobId: source.id, customerId: source.customerId, chatId: source.chatId, textSha256: digest };
      return { duplicate: false, job: publicJob(job) };
    });
  }

  async function dispatchManual(jobId) {
    const result = await mutate(next => {
      if (closed) fail("本地回复引擎已关闭。", 503);
      const job = next.jobs.find(item => item.id === jobId && item.kind === "manual");
      if (!job) fail("手动回复任务不存在。", 404);
      if (job.status !== "draft") return publicJob(job);
      const blocked = manualGate(next, job);
      if (blocked) { setHandoff(next, job, blocked.reason); return publicJob(job); }
      job.status = "ready"; job.updatedAt = iso(); job.reason = "商家已确认本次手动回复，等待原生发送及回读核实。";
      return publicJob(job);
    });
    schedule(); return result;
  }

  async function getManualRequest(input) {
    await chain;
    const record = Object.hasOwn(state.manualOnce, input.requestId) ? state.manualOnce[input.requestId] : null;
    if (!record) return null;
    if (record.sourceJobId !== input.jobId || record.textSha256 !== createHash("sha256").update(input.text.trim(), "utf8").digest("hex")) fail("同一手动回复请求不能更换原任务或正文。", 409);
    const job = state.jobs.find(item => item.id === record.jobId);
    if (!job) fail("手动回复防重记录存在但任务缺失，请核对微信，不能重发。", 409);
    return publicJob(job);
  }

  function manualResumeBlock(next, job, { ignoreGuard = false } = {}) {
    if (!job || job.kind !== "manual" || job.status !== "sent" || !/^[0-9]{1,40}$/.test(job.sendMessageId || "") || !/[1-9]/.test(job.sendMessageId)) return "手动消息尚无可核实的成功回执，继续保留人工处理。";
    const source = next.jobs.find(item => item.id === job.sourceJobId);
    const record = Object.hasOwn(next.manualOnce, job.requestId) ? next.manualOnce[job.requestId] : null;
    if (!source || source.customerId !== job.customerId || source.chatId !== job.chatId || !record || record.jobId !== job.id || record.sourceJobId !== source.id || record.customerId !== job.customerId || record.chatId !== job.chatId || record.textSha256 !== createHash("sha256").update(job.reply, "utf8").digest("hex")) return "原问题、手动请求与发送记录无法完整对应，未自动恢复。";
    if (source.resolvedAt && source.resolvedByManualJobId !== job.id) return "原问题已由另一条手动回复处理，请核对历史。";
    const mapped = manualGate(next, job);
    if (mapped) return mapped.reason;
    if (next.jobs.some(item => item.id !== job.id && item.id !== source.id && item.chatId === job.chatId && (PENDING.has(item.status) || item.status === "unknown"))) return "该客户还有待处理或结果不明的发送，继续保留人工处理。";
    if (!ignoreGuard) {
      const guard = job.autoResumeGuard;
      if (!guard || !Number.isSafeInteger(guard.persistedRevision) || guard.persistedRevision < 0) return "旧记录缺少本次恢复凭据，请核对后点击恢复托管并完成。";
      if (guard.configRevision !== next.configRevision) return "手动发送期间接待规则发生变化，继续保留人工处理。";
      if (guard.conversationVersion !== (next.conversationVersions[job.customerId] || 0)) return "手动发送期间出现新消息或人工操作，继续保留人工处理。";
    }
    return "";
  }

  async function resumeManualJob(jobId) {
    const candidate = await mutate(next => {
      const job = next.jobs.find(item => item.id === jobId);
      if (closed) return null;
      if (job?.autoResumeStatus === "restored") return null;
      const blocked = manualResumeBlock(next, job);
      if (blocked || typeof options.restoreManual !== "function") {
        if (job?.kind === "manual") { job.autoResumeStatus = "blocked"; job.autoResumeReason = blocked || "持久客户资料恢复接口尚未就绪，继续保留人工处理。"; }
        return null;
      }
      job.autoResumeStatus = "pending"; job.autoResumeReason = "消息已发送，正在核对客户资料并恢复托管。";
      const config = copy(next.config);
      config.customers.find(customer => customer.id === job.customerId).humanTakeover = false;
      const echoes = next.jobs.filter(item => item.chatId === job.chatId && item.status === "sent" && /^[0-9]{1,40}$/.test(item.sendMessageId || "")).map(item => ({ messageId: item.sendMessageId, text: item.reply }));
      return { job: copy(job), config, expectedRevision: job.autoResumeGuard.persistedRevision, echoes };
    });
    if (!candidate) return;
    let restored;
    try { restored = await options.restoreManual(candidate); }
    catch (error) { restored = { restored: false, reason: text(error?.message, 800) ? error.message : "托管恢复未核实，继续保留人工处理。" }; }
    const committed = await mutate(next => {
      const job = next.jobs.find(item => item.id === jobId);
      if (!job) return false;
      const blocked = closed ? "服务已关闭，托管恢复未核实。" : manualResumeBlock(next, job);
      if (blocked || restored?.restored !== true) { job.autoResumeStatus = "blocked"; job.autoResumeReason = blocked || (text(restored?.reason, 800) ? restored.reason : "托管恢复未核实，继续保留人工处理。"); return false; }
      customerFor(next, job).humanTakeover = false;
      next.takeovers = next.takeovers.filter(id => id !== job.customerId);
      const source = next.jobs.find(item => item.id === job.sourceJobId);
      source.resolvedAt = iso(); source.resolvedByManualJobId = job.id;
      job.autoResumeStatus = "restored"; job.autoResumeReason = "本条已处理，客户托管已恢复；自动接待仍按当前开关和运行状态执行。";
      return true;
    });
    if (!committed && typeof options.syncManualProtection === "function") { try { await options.syncManualProtection(copy(state.config)); } catch { /* 保持本地人工锁，不把同步失败伪装成已恢复。 */ } }
    schedule();
  }

  async function manualResumeAudit(jobId) {
    await chain;
    const job = state.jobs.find(item => item.id === jobId);
    const blocked = manualResumeBlock(state, job, { ignoreGuard: true });
    if (blocked) fail(blocked, 409);
    return { job: copy(job), conversationVersion: state.conversationVersions[job.customerId] || 0, configRevision: state.configRevision };
  }

  async function requestManualResume(jobId, snapshot) {
    await mutate(next => {
      if (closed) fail("本地回复引擎已关闭。", 503);
      const job = next.jobs.find(item => item.id === jobId);
      if (job?.autoResumeStatus === "restored") return;
      const blocked = manualResumeBlock(next, job, { ignoreGuard: true });
      if (blocked) fail(blocked, 409);
      const currentVersion = next.conversationVersions[job.customerId] || 0;
      if (!Number.isSafeInteger(snapshot?.persistedRevision) || snapshot.persistedRevision < 0 || snapshot.conversationVersion !== currentVersion || snapshot.configRevision !== next.configRevision) fail("核对期间会话、人工操作或规则已变化，未恢复托管。", 409);
      if (job.autoResumeGuard ? job.autoResumeGuard.conversationVersion !== currentVersion : currentVersion !== 0) fail("该手动回复之后存在新消息或人工操作，请先处理新的问题。", 409);
      job.autoResumeGuard = { conversationVersion: currentVersion, configRevision: next.configRevision, persistedRevision: snapshot.persistedRevision };
      job.autoResumeStatus = "pending"; job.autoResumeReason = "正在核对已发送记录并恢复托管，不会再次发送消息。";
    });
    await resumeManualJob(jobId);
    return getJob(jobId);
  }

  async function claimWork() { if (typeof generate === "function") return { jobs: [] }; return { jobs: await reserveWork() }; }

  async function approve(jobId) {
    const result = await mutate((next) => {
      const job = next.jobs.find((item) => item.id === jobId);
      if (!job || job.status !== "draft" || job.kind === "manual") fail("只有待审核的自动回复草稿可以批准发送；手动回复请使用原提交操作。", 409);
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
      bumpConversation(next, customer.id);
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
    for (const controller of generationControllers.values()) controller.abort();
    await mutate((next) => {
      for (const job of next.jobs) {
        if (job.status === "sending") setHandoff(next, job, "服务在发送期间关闭，结果未知，必须人工核对。", "unknown");
        else if (job.status === "generating") { job.status = "queued"; delete job.leaseId; }
      }
    });
  }

  async function getConfig() { await chain; return copy(state.config); }
  async function getJob(jobId) { if (!safeId(jobId)) fail("跟进任务编号不正确。"); await chain; const job = state.jobs.find(item => item.id === jobId); return job ? publicJob(job) : null; }
  return { syncConfig, enrollCustomers, enqueueWelcome, enqueueFollowup, prepareManual, dispatchManual, getManualRequest, manualResumeAudit, requestManualResume, getConfig, getJob, start, pause, ingest, status, claimWork, completeWork, approve, reject, takeover, close };
}
