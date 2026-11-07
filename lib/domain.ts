import type { AppState, ChatMessage, Customer, CustomerStage, ImportRecord, Order } from './types';

const DAY = 86_400_000;
const COLORS = ['#b48254', '#789283', '#828fa5', '#b88087', '#a19470', '#8c82a2'];
const STAGES: CustomerStage[] = ['新客户', '潜在客户', '活跃客户', '重点维护', '待唤醒'];

/** 所有经营日期统一使用上海时区。 */
export function today(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)?.value).join('-');
}

export function shiftDate(days: number, base = today()): string {
  const value = new Date(`${base.slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(value.getTime()) || !Number.isFinite(days)) return today();
  return new Date(value.getTime() + Math.trunc(days) * DAY).toISOString().slice(0, 10);
}

export function currency(amount: number): string {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number.isFinite(amount) ? amount : 0);
}

const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const shanghaiIso = (value: Date) => new Date(value.getTime() + 8 * 3_600_000).toISOString().replace(/Z$/, '+08:00');
const businessDate = (value: string): string => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? shanghaiIso(parsed).slice(0, 10) : value.slice(0, 10);
};

export function customerStats(customerId: string, orders: Order[]) {
  const confirmed = orders.filter(order => order.customerId === customerId && order.status === 'confirmed');
  const sales = confirmed.filter(order => order.type === 'sale');
  return {
    total: money(confirmed.reduce((sum, order) => sum + (order.type === 'refund' ? -order.amount : order.amount), 0)),
    visits: sales.length,
    lastPurchaseAt: sales.map(order => order.date).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? '',
  };
}

export function overviewStats(state: AppState, rangeDays = 7) {
  const days = Math.max(1, Math.min(366, Math.trunc(rangeDays) || 7));
  const end = today();
  const start = shiftDate(1 - days, end);
  const confirmed = state.orders.filter(order => order.status === 'confirmed' && businessDate(order.date) >= start && businessDate(order.date) <= end);
  const revenue = money(confirmed.filter(order => order.type === 'sale').reduce((sum, order) => sum + order.amount, 0));
  const refunds = money(confirmed.filter(order => order.type === 'refund').reduce((sum, order) => sum + order.amount, 0));
  const series = Array.from({ length: days }, (_, index) => {
    const date = shiftDate(index, start);
    const orders = confirmed.filter(order => businessDate(order.date) === date);
    const sale = money(orders.filter(order => order.type === 'sale').reduce((sum, order) => sum + order.amount, 0));
    const refund = money(orders.filter(order => order.type === 'refund').reduce((sum, order) => sum + order.amount, 0));
    return { date, label: `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`, revenue: sale, refunds: refund, netRevenue: money(sale - refund), orders: orders.filter(order => order.type === 'sale').length };
  });
  return {
    revenue, refunds, netRevenue: money(revenue - refunds),
    orderCount: confirmed.filter(order => order.type === 'sale').length,
    customerCount: state.customers.length,
    newCustomers: state.customers.filter(customer => businessDate(customer.createdAt) >= start && businessDate(customer.createdAt) <= end).length,
    pendingCount: state.orders.filter(order => order.status === 'pending').length,
    dueTasks: state.tasks.filter(task => task.status === 'todo' && businessDate(task.date) <= end).length,
    todayRevenue: series.at(-1)?.netRevenue ?? 0,
    series,
    topCustomers: state.customers.map(customer => ({ customer, ...customerStats(customer.id, state.orders) })).sort((a, b) => b.total - a.total).slice(0, 5),
  };
}

type Row = Record<string, unknown>;
type ImportedChat = { data: Row; messages: Row[]; key: string };
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const field = (row: Row, ...keys: string[]): string => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return '';
};
const hash = (value: string): string => {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return (result >>> 0).toString(36);
};

/** 按 RFC 4180 读取带引号、逗号、双引号及换行的 CSV。 */
function csvRows(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (quoted || cell.length === 0) quoted = !quoted;
      else cell += character;
    } else if (character === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += character;
  }
  if (quoted) throw new Error('CSV 中有未闭合的双引号，请检查文件后重试。');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const nonempty = rows.filter(values => values.some(value => value.trim()));
  if (nonempty.length < 2) throw new Error('CSV 至少需要表头和一条消息。');
  const headers = nonempty.shift()!.map(header => header.trim().replace(/^\uFEFF/, ''));
  if (!headers.some(header => ['content', 'text', 'message', '消息', '消息内容', '内容'].includes(header))) throw new Error('CSV 缺少 content 或 text（消息内容）列。');
  return nonempty.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function flatChats(rows: unknown[]): ImportedChat[] {
  const groups = new Map<string, ImportedChat>();
  rows.forEach((value, index) => {
    const row = object(value);
    const wechatId = field(row, 'wechatId', 'wechat_id', 'wxid', '微信号');
    const identity = wechatId || field(row, 'chat_id', 'customer_id', 'conversation_id', '会话ID', '客户ID');
    const name = field(row, 'customer_name', 'name', 'chat_name', '客户姓名', '客户', '姓名');
    const key = identity ? `id:${identity}` : name ? `name:${name}` : 'single';
    if (!groups.has(key)) groups.set(key, { data: { ...row, name: name || '导入联系人', wechatId }, messages: [], key: `${key}:${index}` });
    groups.get(key)!.messages.push(row);
  });
  return [...groups.values()];
}

type ImportWarning = (message: string) => void;

/** 对上游分享卡片保留类型，不把待收款、引用或转发当作客户自述。 */
function exportMessage(row: Row, warn: ImportWarning): Row | null {
  const kind = field(object(row.app_message), 'kind');
  const type = field(row, 'type');
  if (Array.isArray(row.forwarded_messages) || kind === 'chat_history') {
    warn('已跳过合并转发记录：其中的原始发言不代表当前客户本人陈述，请勿据此生成个人画像或消费记录。');
    return null;
  }
  const author = field(row, 'sender');
  if (author === '系统' || /^(系统消息|撤回|拍一拍|加入群聊|退出群聊)$/.test(type)) {
    warn('已跳过系统通知，避免把通知内容当作客户本人表达。');
    return null;
  }
  let content = field(row, 'content', 'text');
  if (!content) return null;
  if (kind === 'payment' || type === '转账/收款') {
    content = `【转账/收款卡片，到账状态未核实】${content}`;
    warn('转账/收款卡片仅保留为聊天线索，不代表款项已到账，需对照实际支付凭据核实。');
  } else if (kind === 'red_packet' || type === '红包') {
    content = `【红包卡片，不作为营业收入凭据】${content}`;
    warn('红包卡片仅保留类型与描述，不作为营业收入凭据。');
  }
  if (kind === 'quote' || row.reference) {
    content = `【引用资料，非客户本人陈述】${content}`;
    warn('引用消息已加来源提示，其中的引文不作为客户本人陈述。');
  }
  return { ...row, content };
}

function wechatExportChat(root: Row, warn: ImportWarning): ImportedChat {
  const metadata = object(root.metadata);
  const wechatId = field(metadata, 'chat_username');
  const name = field(metadata, 'chat') || wechatId || '导入联系人';
  if (field(metadata, 'chat_type') === 'group' || wechatId.endsWith('@chatroom')) throw new Error('当前只支持该工具导出的好友私聊，群聊不能归属于单个客户。请在 wechat-chat-export 中选择好友私聊后重新导出。');
  if (wechatId === 'filehelper') throw new Error('文件传输助手不对应单个客户。请在 wechat-chat-export 中直接导出好友私聊。');
  if (!wechatId) throw new Error('该工具的 JSON 缺少 metadata.chat_username，无法可靠识别客户，请重新导出好友私聊 JSON。');
  const messages: Row[] = [];
  for (const value of root.messages as unknown[]) {
    const row = object(value);
    const author = field(row, 'sender');
    const username = field(row, 'sender_username');
    if (author !== '我' && author !== '系统' && username !== wechatId && author !== name) {
      warn('已跳过无法确认属于当前好友或本人的消息，请检查导出中的发送人信息。');
      continue;
    }
    const normalized = exportMessage(row, warn);
    if (!normalized) continue;
    const serverId = field(row, 'server_id');
    const localId = field(row, 'local_id');
    const sourceIdentity = /^\d+$/.test(serverId) && /[1-9]/.test(serverId) ? `${wechatId}|server:${serverId}` : localId ? `${wechatId}|local:${field(row, 'source_database')}|${localId}` : '';
    messages.push({ ...normalized, sender: author === '我' ? 'merchant' : 'customer', _messageIdentity: sourceIdentity });
  }
  warn('已适配 wechat-chat-export 好友私聊 JSON。图片、语音、视频及附件仅保留原工具提供的类型与描述，不读取媒体本体。');
  return { data: { name, wechatId, note: '来源：yeklongdi/wechat-chat-export 好友私聊导出。' }, messages, key: `wechat-export:${wechatId}` };
}

/** 上游 TXT 是“时间/发送人/类型”标题与多行正文组成的块。 */
function wechatExportText(text: string, warn: ImportWarning): ImportedChat | null {
  if (!/^会话[：:]/m.test(text) || !/^\[[^\]]+\]\s+\[[^\]]+\]\s+\[[^\]]+\]\s*$/m.test(text)) return null;
  const name = text.match(/^会话[：:]\s*(.+)$/m)?.[1].trim() || '导入联系人';
  if (name === '文件传输助手' || name === 'filehelper') throw new Error('文件传输助手不对应单个客户，请直接导出好友私聊 JSON。');
  if (name.endsWith('@chatroom')) throw new Error('群聊不能归属于单个客户，请直接导出好友私聊 JSON。');
  const messages: Row[] = [];
  let current: { time: string; sender: string; type: string; lines: string[]; forwarded: boolean } | null = null;
  let forwardRemaining = 0;
  const finish = () => {
    if (!current) return;
    if (current.forwarded) warn('已跳过合并转发记录：其中的原始发言不代表当前客户本人陈述，请勿据此生成个人画像或消费记录。');
    else if (!['未解析的发送方', '未记录的发送方'].includes(current.sender)) {
      const row: Row = { time: current.time, sender: current.sender, type: current.type, content: current.lines.join('\n').trim() };
      if (current.lines.some(line => /^\s+引用\s/.test(line))) row.reference = true;
      const normalized = exportMessage(row, warn);
      if (normalized) messages.push({ ...normalized, sender: current.sender === '我' ? 'merchant' : 'customer' });
    } else warn('已跳过发送人无法解析的消息。');
    current = null;
  };
  for (const line of text.split(/\r?\n/)) {
    const forwarded = line.match(/^转发记录\s+\d+[：:].*原始消息\s+(\d+)\s+条/);
    if (forwarded) { finish(); forwardRemaining = Number(forwarded[1]); continue; }
    const header = line.match(/^\[([^\]]+)\]\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s*$/);
    if (header) {
      finish(); current = { time: header[1], sender: header[2], type: header[3], lines: [], forwarded: forwardRemaining > 0 };
      if (forwardRemaining > 0) forwardRemaining -= 1;
    } else if (current) current.lines.push(line);
  }
  finish();
  warn('已识别 wechat-chat-export TXT。TXT 不携带微信号及会话类型，仅限你已核对的好友私聊；不会按昵称合并已有档案，建议优先导入可核验身份的 JSON。');
  return { data: { name, note: '来源：wechat-chat-export TXT；无微信号，需人工核对好友私聊身份。' }, messages, key: 'wechat-export-txt:single' };
}

function jsonChats(value: unknown, warn: ImportWarning): ImportedChat[] {
  if (Array.isArray(value)) {
    if (value.some(item => Array.isArray(object(item).messages) || Array.isArray(object(item).records))) {
      return value.flatMap((item, index) => {
        const data = object(item);
        if (field(object(data.metadata), 'chat_username', 'chat_type')) return [wechatExportChat(data, warn)];
        return [{ data, messages: (Array.isArray(data.messages) ? data.messages : Array.isArray(data.records) ? data.records : []).map(object), key: `chat:${index}` }];
      });
    }
    return flatChats(value);
  }
  const root = object(value);
  if (Array.isArray(root.messages) && field(object(root.metadata), 'chat_username', 'chat_type')) return [wechatExportChat(root, warn)];
  for (const key of ['customers', 'conversations', 'chats', 'sessions']) if (Array.isArray(root[key])) return jsonChats(root[key], warn);
  if (Array.isArray(root.messages)) return [{ data: root, messages: root.messages.map(object), key: 'chat:0' }];
  if (Object.keys(root).length && field(root, 'content', 'text', 'message')) return flatChats([root]);
  throw new Error('未找到聊天数据。JSON 请使用 customers / conversations 数组，或包含 messages 的单个会话。');
}

function normalizedDate(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'string' && /^\d{10}(\d{3})?$/.test(value)) {
    const number = Number(value);
    const date = new Date(number < 100_000_000_000 ? number * 1000 : number);
    return Number.isFinite(date.getTime()) ? shanghaiIso(date) : '';
  }
  if (typeof value !== 'string' || !value.trim()) return '';
  const dateText = value.trim().replace(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/, (_, year, month, day) => `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
  if (/^\d{4}-\d{2}-\d{2}/.test(dateText)) {
    const originalDay = dateText.slice(0, 10);
    const originalDate = new Date(`${originalDay}T12:00:00Z`);
    if (!Number.isFinite(originalDate.getTime()) || originalDate.toISOString().slice(0, 10) !== originalDay) return '';
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
    const date = new Date(`${dateText}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === dateText ? dateText : '';
  }
  const dateTime = dateText.replace(' ', 'T');
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(dateTime) ? dateTime : `${dateTime}+08:00`);
  return Number.isFinite(date.getTime()) ? shanghaiIso(date) : '';
}

function sender(row: Row): ChatMessage['sender'] {
  if (row.isSelf === true || row.is_self === true || row.isSelf === 1 || row.is_self === 1) return 'merchant';
  const label = field(row, 'sender', 'role', 'direction', '发送者', '角色').toLowerCase();
  return ['merchant', 'assistant', 'self', 'me', 'owner', 'outgoing', 'sent', '我', '本人', '商家', '客服', '店主', '销售'].includes(label) ? 'merchant' : 'customer';
}

export function parseChatImport(text: string, fileName: string, existingCustomers: Customer[]): { customers: Customer[]; record: ImportRecord; warnings: string[] } {
  const clean = text.replace(/^\uFEFF/, '').trim();
  if (!clean) throw new Error('文件内容为空，请选择包含聊天记录的文件。');
  if (new TextEncoder().encode(text).byteLength > 2_000_000) throw new Error('单个文件请控制在 2 MB 以内，较大的聊天记录可按会话拆分。');
  const warnings: string[] = [];
  const warn = (message: string) => { if (!warnings.includes(message)) warnings.push(message); };
  let chats: ImportedChat[];
  if (/\.(jsonl|ndjson)$/i.test(fileName)) {
    const rows = clean.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
      try { return JSON.parse(line); } catch { throw new Error(`JSONL 第 ${index + 1} 行不是有效 JSON。`); }
    });
    chats = flatChats(rows);
  } else if (/\.csv$/i.test(fileName)) chats = flatChats(csvRows(clean));
  else if (/\.json$/i.test(fileName) || /^[\[{]/.test(clean)) {
    try { chats = jsonChats(JSON.parse(clean), warn); }
    catch (error) { if (error instanceof SyntaxError) throw new Error('JSON 格式不正确，请检查括号、逗号和引号。'); throw error; }
  } else if (/\.(txt|md)$/i.test(fileName)) {
    const exported = wechatExportText(clean, warn);
    if (exported) chats = [exported];
    else {
    const name = fileName.replace(/\.(txt|md)$/i, '').replace(/[_-]?(聊天记录|聊天|导出|chat)$/i, '').trim() || '导入联系人';
    chats = [{ data: { name }, key: 'txt:single', messages: clean.split(/\r?\n/).filter(line => line.trim()).map(line => {
      const match = line.match(/^\[?(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)\]?\s+([^:：]+)[:：]\s*(.*)$/);
      return match ? { timestamp: match[1], sender: match[2], content: match[3] } : { content: line, sender: 'customer' };
    }) }];
    warn('TXT 按一个联系人导入；未标明角色的行视为客户消息。请在客户详情核对姓名、角色与日期。');
    }
  } else throw new Error('暂时支持 JSON、JSONL、CSV、TXT 和 Markdown。XLSX 请先另存为 UTF-8 CSV。');

  const customers = existingCustomers.map(customer => ({ ...customer, messages: [...customer.messages], evidence: [...customer.evidence], tags: [...customer.tags], manualTags: [...customer.manualTags] }));
  const usedIds = new Set(customers.map(customer => customer.id));
  const currentTargets = new Map<string, Customer>();
  const seenSourceIds = new Set<string>();
  const touched = new Set<string>();
  let messageCount = 0;
  let ignored = 0;
  let duplicates = 0;
  let missingDates = 0;
  const importKey = hash(`${fileName}\n${clean}`);
  const uniqueId = (preferred: string) => {
    let result = preferred;
    let count = 2;
    while (usedIds.has(result)) { result = `${preferred}-${count}`; count += 1; }
    usedIds.add(result);
    return result;
  };

  chats.forEach((chat, index) => {
    const data = chat.data;
    const wechatId = field(data, 'wechatId', 'wechat_id', 'wxid', '微信号');
    const name = field(data, 'name', 'customer_name', 'chat_name', 'displayName', '客户姓名', '姓名') || '导入联系人';
    if (name.length > 120 || wechatId.length > 200) throw new Error('客户姓名或微信标识过长，请缩短姓名至120字、微信标识至200字以内。');
    const originalId = field(data, 'id', 'customer_id', 'chat_id');
    if (originalId && seenSourceIds.has(originalId)) warn('文件包含重复客户 ID，已按明确微信号区分；昵称或重复 ID 不会用来合并已有客户。');
    if (originalId) seenSourceIds.add(originalId);
    const existingMatches = wechatId ? customers.filter(customer => customer.wechatId === wechatId) : [];
    if (existingMatches.length > 1) warn(`微信号 ${wechatId} 对应多个已有档案，未自动合并，请人工核对。`);
    let target = wechatId ? currentTargets.get(wechatId) : undefined;
    if (!target && existingMatches.length === 1) target = existingMatches[0];
    if (!wechatId) warn('部分联系人缺少微信号，已单独建档；不会因为昵称相同而合并已有客户。');
    const messages: ChatMessage[] = [];
    const sourceIdentified = new Set<string>();
    for (const row of chat.messages) {
      const content = field(row, 'content', 'text', 'message', '消息', '消息内容', '内容');
      if (!content) { ignored += 1; continue; }
      if (content.length > 8000) throw new Error('单条聊天超过8000字，请按原始消息拆分后再导入。');
      let date = normalizedDate(row.timestamp ?? row.date ?? row.time ?? row.created_at ?? row['时间'] ?? row['日期']);
      if (!date) { date = today(); missingDates += 1; }
      const role = sender(row);
      const sourceIdentity = field(row, '_messageIdentity');
      const messageId = sourceIdentity ? `wx-msg-${hash(sourceIdentity)}-${hash([...sourceIdentity].reverse().join(''))}` : `msg-${hash(`${wechatId || chat.key}|${role}|${date}|${content}`)}`;
      if (sourceIdentity) sourceIdentified.add(messageId);
      messages.push({ id: messageId, sender: role, text: content, date });
    }
    if (!messages.length) return;
    if (!target) {
      const stage = field(data, 'stage') as CustomerStage;
      const profile = object(data.profile);
      target = {
        id: uniqueId(`customer-${hash(wechatId || `${importKey}|${chat.key}|${index}`)}`), name, wechatId,
        color: COLORS[index % COLORS.length], stage: STAGES.includes(stage) ? stage : '新客户',
        tags: Array.isArray(data.tags) ? data.tags.filter((value): value is string => typeof value === 'string').slice(0, 20) : [], manualTags: [],
        summary: field(data, 'summary') || field(profile, 'summary') || '已导入聊天，等待整理客户画像。',
        preferences: field(data, 'preferences') || field(profile, 'preferences'), budget: field(data, 'budget') || field(profile, 'budget'),
        note: field(data, 'note'), createdAt: today(), lastContactAt: '', nextFollowUpAt: '', source: 'wechat', evidence: [], messages: [],
      };
      customers.push(target);
    }
    if (wechatId) currentTargets.set(wechatId, target);
    const ids = new Set(target.messages.map(message => message.id));
    const signatures = new Set(target.messages.map(message => `${message.sender}|${message.date}|${message.text}`));
    for (const message of messages) {
      const signature = `${message.sender}|${message.date}|${message.text}`;
      if (ids.has(message.id) || !sourceIdentified.has(message.id) && signatures.has(signature)) { duplicates += 1; continue; }
      target.messages.push(message); ids.add(message.id); signatures.add(signature); messageCount += 1;
    }
    target.messages.sort((a, b) => a.date.localeCompare(b.date));
    if (target.messages.length > 1500) throw new Error(`客户“${name}”的聊天超过1500条，请缩小时间范围后再导入。`);
    target.lastContactAt = target.messages.at(-1)?.date || target.lastContactAt;
    touched.add(target.id);
  });
  if (!touched.size) throw new Error('没有识别到可导入的文字消息，请检查 messages 数组或 CSV 消息内容列。');
  if (customers.length > 500) throw new Error('当前工作空间最多保存500位客户，请先整理已有档案。');
  if (customers.reduce((total, customer) => total + customer.messages.length, 0) > 12000) throw new Error('聊天总量超过12000条，请缩小时间范围或整理已有记录。');
  if (missingDates) warn(`${missingDates} 条消息缺少有效时间，暂记为今天；统计与候选订单前请核对原始日期。`);
  if (ignored) warn(`已跳过 ${ignored} 条没有文字内容的消息。`);
  if (duplicates) warn(`已跳过 ${duplicates} 条重复消息。`);
  return { customers, record: { id: `import-${importKey}-${hash(new Date().toISOString())}`, fileName, date: today(), customerCount: touched.size, messageCount }, warnings };
}

/** 仅把明确付款或收款的文字列为待确认候选，不能据此直接记收入。 */
export function extractCandidates(customer: Customer): Order[] {
  const candidates: Order[] = [];
  const seen = new Set<string>();
  for (const message of customer.messages) {
    const text = message.text;
    if (/^【(?:转账\/收款卡片|红包卡片|引用资料|转发内容)/.test(text)) continue;
    if (/[?？]|(?:如果|假如|是否|怎么|如何|打算|准备|预计|想要|报价|未付款|没付款|未支付|待支付|未转账|尚未|待付款|待收款|还没|没有收到|未收到|未到账|没到账)/.test(text)) continue;
    const refund = /(?:已退款|退款成功|已退回|退还成功|已退给|已收到退款|退款已到账)/.test(text);
    const paid = message.sender === 'merchant' ? /(?:已收款|收到(?:您的|你的)?(?:转账|付款|款项)|收款成功|已到账)/.test(text) : /(?:已付款|已支付|付款成功|支付成功|已经付款|已经支付|已转账|转账成功)/.test(text);
    if (!refund && !paid) continue;
    const amountMatch = text.match(/[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/) || text.match(/([\d,]+(?:\.\d{1,2})?)\s*元/);
    const amount = amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : 0;
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) continue;
    const signature = `${refund ? 'refund' : 'sale'}|${money(amount)}|${businessDate(message.date)}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    candidates.push({ id: `candidate-${hash(`${customer.id}|${message.id}|${refund ? 'refund' : 'sale'}`)}`, customerId: customer.id, description: refund ? '聊天识别退款，待人工确认' : '聊天识别收款，待人工确认', amount: money(amount), date: businessDate(message.date), status: 'pending', type: refund ? 'refund' : 'sale', evidence: text });
  }
  return candidates;
}
