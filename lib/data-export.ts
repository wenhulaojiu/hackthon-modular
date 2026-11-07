import type { AppState, Customer, FAQ, Order, Product, ReplySettings, Task } from './types';
import { customerStats } from './domain.ts';

export type CsvValue = string | number | boolean | null | undefined;

export const CUSTOMER_CSV_HEADERS = ['客户ID', '客户称呼', '微信标识', '来源', '客户阶段', 'AI标签', '手工标签', '客户概况', '需求偏好', '预算与消费习惯', '商家备注', '累计净消费（元）', '确认消费次数', '最近确认消费', '最近沟通', '下次跟进', '客户自动回复', '人工接管', '创建日期'];
export const ORDER_CSV_HEADERS = ['记录ID', '客户ID', '客户称呼', '微信标识', '项目', '交易类型', '记录状态', '记录金额（元）', '计入净消费（元）', '计入消费次数', '交易日期', '聊天证据'];
export const TASK_CSV_HEADERS = ['任务ID', '客户ID', '客户称呼', '微信标识', '跟进事项', '任务类型', '跟进日期', '任务状态', '优先级', '话术草稿'];

/** 文本按字面值导出；即使公式前有空白、控制符或不可见格式符，也不得交由表格执行。 */
export function csvCell(value: CsvValue): string {
  let text = value === null || value === undefined ? '' : typeof value === 'number' && !Number.isFinite(value) ? '' : String(value);
  if (typeof value === 'string' && /^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** UTF-8 BOM 配合标准逗号、双引号转义与 CRLF，便于直接用 Excel 打开。 */
export function buildCsv(headers: string[], rows: CsvValue[][]): string {
  return `\uFEFF${[headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

const faqData = (items: FAQ[]): FAQ[] => items.map(item => ({ question: item.question, answer: item.answer }));

// 误粘贴的接口凭据可能藏在URL中；导出仅保留接口地址，不携带鉴权或查询参数。
function exportModelUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? `${url.origin}${url.pathname}` : '';
  } catch { return ''; }
}

function customerData(customer: Customer): Customer {
  return {
    id: customer.id, name: customer.name, wechatId: customer.wechatId, color: customer.color, stage: customer.stage,
    tags: [...customer.tags], manualTags: [...customer.manualTags], summary: customer.summary, preferences: customer.preferences,
    budget: customer.budget, note: customer.note, createdAt: customer.createdAt, lastContactAt: customer.lastContactAt,
    nextFollowUpAt: customer.nextFollowUpAt, source: customer.source,
    evidence: customer.evidence.map(item => ({ id: item.id, text: item.text, date: item.date, source: item.source })),
    messages: customer.messages.map(item => ({ id: item.id, sender: item.sender, text: item.text, date: item.date })),
    ...(customer.autoReplyEnabled === undefined ? {} : { autoReplyEnabled: customer.autoReplyEnabled }),
    ...(customer.humanTakeover === undefined ? {} : { humanTakeover: customer.humanTakeover }),
  };
}

function productData(product: Product): Product {
  return { id: product.id, name: product.name, type: product.type, price: product.price, description: product.description, faq: faqData(product.faq), enabled: product.enabled, ...(product.needsRestock === undefined ? {} : { needsRestock: product.needsRestock }), ...(product.source === undefined ? {} : { source: product.source }) };
}

function replySettingsData(settings: ReplySettings): ReplySettings {
  return {
    enabled: settings.enabled, mode: settings.mode, selectedCustomerIds: [...settings.selectedCustomerIds],
    autoEnrollNewContacts: settings.autoEnrollNewContacts ?? true,
    welcomeEnabled: settings.welcomeEnabled ?? true,
    welcomeMessage: settings.welcomeMessage ?? '您好，欢迎添加本店！这里可以咨询商品和服务，欢迎告诉我们您的需求。',
    ...(settings.storeInfo ? { storeInfo: { phone: settings.storeInfo.phone, address: settings.storeInfo.address, serviceContent: settings.storeInfo.serviceContent } } : {}),
    businessHours: { enabled: settings.businessHours.enabled, start: settings.businessHours.start, end: settings.businessHours.end, days: [...settings.businessHours.days] },
    faq: faqData(settings.faq), handoffKeywords: [...settings.handoffKeywords], maxReplyChars: settings.maxReplyChars,
    cooldownSeconds: settings.cooldownSeconds, debounceSeconds: settings.debounceSeconds ?? 10, prompt: settings.prompt,
  };
}

/** 逐层列出已声明的业务字段，避免把附加密钥、密文或本机配置混入数据导出。真实聊天文字保持原样。 */
export function buildFullDataJson(state: AppState): string {
  const data: AppState = {
    schemaVersion: state.schemaVersion,
    customers: state.customers.map(customerData),
    orders: state.orders.map(order => ({ id: order.id, customerId: order.customerId, description: order.description, amount: order.amount, date: order.date, status: order.status, type: order.type, evidence: order.evidence })),
    tasks: state.tasks.map(task => ({ id: task.id, customerId: task.customerId, title: task.title, date: task.date, kind: task.kind, status: task.status, priority: task.priority, script: task.script })),
    settings: {
      storeName: state.settings.storeName, industry: state.settings.industry, followupDays: state.settings.followupDays,
      ai: { baseUrl: exportModelUrl(state.settings.ai.baseUrl), model: state.settings.ai.model, temperature: state.settings.ai.temperature, profilePrompt: state.settings.ai.profilePrompt, marketingPrompt: state.settings.ai.marketingPrompt, extractionPrompt: state.settings.ai.extractionPrompt },
    },
    imports: state.imports.map(record => ({ id: record.id, fileName: record.fileName, date: record.date, customerCount: record.customerCount, messageCount: record.messageCount })),
    ...(state.exports ? { exports: state.exports.map(record => ({ id: record.id, fileName: record.fileName, date: record.date, kind: record.kind, customerCount: record.customerCount, messageCount: record.messageCount })) } : {}),
    demo: state.demo,
    ...(state.products === undefined ? {} : { products: state.products.map(productData) }),
    ...(state.replySettings === undefined ? {} : { replySettings: replySettingsData(state.replySettings) }),
  };
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function buildCustomersCsv(state: AppState): string {
  const source = { demo: '示例数据', manual: '手动添加', wechat: '微信导入' };
  return buildCsv(CUSTOMER_CSV_HEADERS, state.customers.map(customer => {
    const stats = customerStats(customer.id, state.orders);
    const replyEnabled = customer.autoReplyEnabled === true || (customer.autoReplyEnabled !== false && !!state.replySettings?.selectedCustomerIds.includes(customer.id));
    return [customer.id, customer.name, customer.wechatId, source[customer.source], customer.stage, customer.tags.join('、'), customer.manualTags.join('、'), customer.summary, customer.preferences, customer.budget, customer.note, stats.total, stats.visits, stats.lastPurchaseAt, customer.lastContactAt, customer.nextFollowUpAt, replyEnabled ? '允许' : '关闭', customer.humanTakeover ? '是' : '否', customer.createdAt];
  }));
}

/** 待确认和已拒绝记录仍保留原金额，但计入净消费及消费次数均为零。 */
export function buildOrdersCsv(state: AppState): string {
  const customers = new Map(state.customers.map(customer => [customer.id, customer]));
  const status: Record<Order['status'], string> = { pending: '待确认', confirmed: '已确认', rejected: '已拒绝' };
  return buildCsv(ORDER_CSV_HEADERS, state.orders.map(order => {
    const customer = customers.get(order.customerId);
    const stats = customerStats(order.customerId, [order]);
    return [order.id, order.customerId, customer?.name ?? '', customer?.wechatId ?? '', order.description, order.type === 'refund' ? '退款' : '消费', status[order.status], order.amount, stats.total, stats.visits, order.date, order.evidence];
  }));
}

export function buildTasksCsv(state: AppState): string {
  const customers = new Map(state.customers.map(customer => [customer.id, customer]));
  const kind: Record<Task['kind'], string> = { followup: '客户跟进', marketing: '营销沟通', reminder: '提醒事项' };
  return buildCsv(TASK_CSV_HEADERS, state.tasks.map(task => {
    const customer = customers.get(task.customerId);
    return [task.id, task.customerId, customer?.name ?? '', customer?.wechatId ?? '', task.title, kind[task.kind], task.date, task.status === 'done' ? '已完成' : '待处理', task.priority === 'high' ? '高' : '普通', task.script];
  }));
}
