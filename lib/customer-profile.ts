import type { AppState, Customer, Order, Product } from './types';

export type ValueTier = 'high' | 'mid' | 'low' | 'new';
export type ShopRecord = { memberId: string; phone: string; name: string; date: string; description: string; amount: number; type: 'sale' | 'refund' };
export type SpokenDraft = { name: string; memberId: string; phone: string; summary: string; tags: string[]; preferences: string; budget: string; note: string; warnings: string[] };

export const VALUE_TIER_LABELS: Record<ValueTier, string> = { high: '高客单', mid: '中等客单', low: '入门客单', new: '暂无消费记录' };
const COLORS = ['#7566d9', '#6599a2', '#ce956c', '#8d93be', '#9d85b0'];
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

const memberKey = (value: string) => value.trim().replace(/[\s-]/gu, '').toUpperCase();
const phoneKey = (value: string) => value.trim().replace(/\D/gu, '');

/** 只有唯一匹配才绑定，避免把两位客户的历史消费并到一起。 */
export function findCustomerByIdentity(customers: Customer[], memberId: string, phone: string): Customer | null {
  const member = memberKey(memberId);
  const key = phoneKey(phone);
  if (!member && key.length < 6) return null;
  const matched = customers.filter(customer =>
    (member.length > 0 && memberKey(customer.memberId ?? '') === member) ||
    (key.length >= 6 && phoneKey(customer.phone ?? '') === key));
  return matched.length === 1 ? matched[0] : null;
}

/** 只统计已确认记录：候选与已拒绝记录不参与消费档次判断。 */
export function computeValueTier(orders: Order[], customerId: string): ValueTier {
  const rows = orders.filter(order => order.customerId === customerId && order.status === 'confirmed');
  const sales = rows.filter(order => order.type === 'sale');
  if (!sales.length) return 'new';
  const total = rows.reduce((sum, order) => sum + (order.type === 'sale' ? order.amount : -order.amount), 0);
  const average = sales.reduce((sum, order) => sum + order.amount, 0) / sales.length;
  if (average >= 300 || total >= 2000) return 'high';
  if (average >= 100 || total >= 500) return 'mid';
  return 'low';
}

export function recommendationForTier(tier: ValueTier, products: Product[]): { names: string[]; note: string } {
  // 没有已确认消费时不推断购买力，也不列商品，避免「先了解需求」与推荐名单自相矛盾。
  if (tier === 'new') return { names: [], note: '还没有已确认的消费记录，先了解需求再推荐，不作消费能力推断。' };
  const priced = products.filter(product => product.enabled && typeof product.price === 'number' && Number.isFinite(product.price) && product.price > 0);
  const ascending = [...priced].sort((left, right) => (left.price as number) - (right.price as number));
  const sorted = tier === 'low' ? ascending : ascending.reverse();
  return {
    names: sorted.slice(0, 3).map(product => product.name),
    note: `按历史消费档次（${VALUE_TIER_LABELS[tier]}）排列的目录参考，仅依据已登记标价，不代表适用或效果，需人工确认。`,
  };
}

type RawRecord = Record<string, unknown>;
const pick = (row: RawRecord, keys: string[]): string => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  }
  return '';
};

function toRecord(row: RawRecord): { record: ShopRecord | null; warning: string } {
  const memberId = pick(row, ['memberId', '会员卡号', '卡号', '会员号']);
  const phone = pick(row, ['phone', '电话', '手机号']);
  const name = pick(row, ['name', '姓名', '客户', '客户姓名']);
  const date = pick(row, ['date', '日期', '消费日期']);
  const description = pick(row, ['description', '商品', '项目', '消费项目']);
  const amount = Number(pick(row, ['amount', '金额', '消费金额']));
  const type = pick(row, ['type', '类型']) === 'refund' || pick(row, ['type', '类型']) === '退款' ? 'refund' : 'sale';
  if (!DATE.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) return { record: null, warning: '日期需为 YYYY-MM-DD' };
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) return { record: null, warning: '金额需为大于零的有效数字' };
  if (!description || description.length > 1000) return { record: null, warning: '缺少消费项目或项目过长' };
  if (!memberId && phoneKey(phone).length < 6 && !name) return { record: null, warning: '缺少会员卡号、电话或姓名，无法绑定客户' };
  return { record: { memberId, phone, name, date, description, amount, type }, warning: '' };
}

/** 解析店铺现有数据（JSON 数组或带表头的 CSV/TSV），只生成待核对草稿，不写状态。 */
export function parseShopRecords(text: string): { rows: ShopRecord[]; warnings: string[] } {
  const source = text.trim();
  if (!source) return { rows: [], warnings: ['请先粘贴店铺现有数据'] };
  let raw: RawRecord[] = [];
  try {
    if (source.startsWith('[')) {
      const parsed: unknown = JSON.parse(source);
      if (!Array.isArray(parsed)) return { rows: [], warnings: ['JSON 顶层需为数组'] };
      raw = parsed.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item)) as RawRecord[];
    } else {
      const lines = source.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
      if (lines.length < 2) return { rows: [], warnings: ['CSV 至少需要表头和一行数据'] };
      const separator = lines[0].includes('\t') ? '\t' : ',';
      const headers = lines[0].split(separator).map(item => item.trim().replace(/^"|"$/gu, ''));
      raw = lines.slice(1).map(line => {
        const cells = line.split(separator).map(item => item.trim().replace(/^"|"$/gu, ''));
        return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
      });
    }
  } catch {
    return { rows: [], warnings: ['数据格式无法解析，请检查 JSON 或 CSV 内容'] };
  }
  const rows: ShopRecord[] = [];
  const warnings: string[] = [];
  for (const [index, row] of raw.slice(0, 500).entries()) {
    const { record, warning } = toRecord(row);
    if (record) rows.push(record);
    else warnings.push(`第 ${index + 2} 行已跳过：${warning}`);
  }
  if (raw.length > 500) warnings.push('单次最多导入 500 行，其余数据未读取');
  return { rows, warnings };
}

export type LinkResult = { state: AppState; addedCustomers: number; addedOrders: number; skipped: number };

/** 按会员卡或电话绑定消费记录；无唯一匹配时新建档案，不覆盖已有姓名与聊天资料。 */
export function linkShopRecords(state: AppState, rows: ShopRecord[], options: { fileName?: string; makeId?: () => string; now?: () => string } = {}): LinkResult {
  const makeId = options.makeId ?? (() => globalThis.crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString().slice(0, 10));
  const customers = state.customers.map(customer => ({ ...customer }));
  const orders = [...state.orders];
  let addedCustomers = 0;
  let addedOrders = 0;
  let skipped = 0;
  for (const row of rows) {
    let customer = findCustomerByIdentity(customers, row.memberId, row.phone);
    if (!customer) {
      if (customers.length >= 500) { skipped += 1; continue; }
      customer = {
        id: makeId(), name: row.name || row.memberId || row.phone || '待补全客户',
        wechatId: '', color: COLORS[customers.length % COLORS.length], stage: '新客户',
        tags: [], manualTags: ['店铺数据导入'], summary: '', preferences: '', budget: '',
        note: '由店铺现有消费数据建档，姓名与联系方式请导购核对。',
        createdAt: now(), lastContactAt: '', nextFollowUpAt: '', source: 'manual', evidence: [], messages: [],
        memberId: row.memberId || undefined, phone: row.phone || undefined,
      };
      customers.push(customer);
      addedCustomers += 1;
    } else if ((!customer.memberId && row.memberId) || (!customer.phone && row.phone)) {
      customer.memberId = customer.memberId || row.memberId || undefined;
      customer.phone = customer.phone || row.phone || undefined;
    }
    const duplicate = orders.some(order => order.customerId === customer!.id && order.date === row.date && order.amount === row.amount && order.type === row.type && order.description === row.description);
    if (duplicate) { skipped += 1; continue; }
    orders.push({ id: makeId(), customerId: customer.id, description: row.description, amount: row.amount, date: row.date, type: row.type, status: 'confirmed', evidence: '店铺现有消费数据导入，需商家核对' });
    addedOrders += 1;
  }
  const imports = options.fileName
    ? [...state.imports, { id: makeId(), fileName: options.fileName, date: now(), customerCount: addedCustomers, messageCount: 0 }].slice(-500)
    : state.imports;
  return { state: { ...state, customers, orders, imports }, addedCustomers, addedOrders, skipped };
}

const SYMPTOM_WORDS = ['发烧', '头晕', '腹泻', '呕吐', '咳嗽', '过敏', '便血', '抽搐'];
const INTEREST_WORDS = ['DHA', '鱼油', '补钙', '头发黄', '晒太阳', '睡眠', '辅食', '便秘', '奶粉', '免疫力'];

/** 把导购口述内容解析成档案草稿，全程本地规则，不调用模型、不自动保存。 */
export function parseSpokenNote(text: string, products: Product[] = []): SpokenDraft {
  const value = text.trim();
  const phone = value.match(/1[3-9]\d{9}/u)?.[0] ?? '';
  const memberId = value.match(/(?:会员卡|卡号)[:：]?\s*([A-Za-z0-9_-]{4,24})/u)?.[1] ?? '';
  const name = value.match(/(?:客户叫|宝妈叫|客户是|这位是|姓名[:：]?\s*|叫)([\u4e00-\u9fa5]{2,4})(?=[，,。的咨询问想说来买]|$)/u)?.[1]
    ?? value.match(/^([\u4e00-\u9fa5]{2,4})(?:女士|先生|妈妈|宝妈)?(?:咨询|问|想|说|来)/u)?.[1] ?? '';
  const months = value.match(/(\d{1,2})\s*(?:个)?月(?:大|龄)?/u)?.[1] ?? '';
  const budget = value.match(/预算\s*(\d+(?:\.\d{1,2})?)\s*元?/u)?.[1] ?? value.match(/(\d{2,5})\s*元(?:左右|以内|预算)?/u)?.[1] ?? '';
  const tags = [...new Set([
    ...(months ? [`${months}个月`] : []),
    ...INTEREST_WORDS.filter(word => value.toLowerCase().includes(word.toLowerCase())),
  ])];
  const wanted = products.filter(product => product.enabled && value.includes(product.name)).map(product => product.name);
  const symptoms = SYMPTOM_WORDS.filter(word => value.includes(word));
  const warnings: string[] = ['口述内容由规则提取，请导购逐项核对后再保存。'];
  if (symptoms.length) warnings.push(`口述涉及身体症状（${symptoms.join('、')}），档案只记录现象，不提供医疗判断，请提醒客户咨询医生。`);
  if (!name) warnings.push('未识别到客户称呼，请手动补全。');
  return {
    name, memberId, phone,
    summary: tags.length ? `口述关注：${tags.join('、')}。` : '',
    tags, preferences: wanted.length ? `口述提到：${wanted.join('、')}。` : '',
    budget: budget ? `约 ${budget} 元` : '',
    note: `口述记录（需导购核对）：${value.slice(0, 500)}`,
    warnings,
  };
}
