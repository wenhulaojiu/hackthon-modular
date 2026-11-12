import { unzipSync } from 'fflate';
import type { Customer, GuideTopic, Product } from './types.ts';

export type ParsedDocument = { fileName: string; paragraphs: string[]; rows: string[][]; warnings: string[] };
export type ImportResult = { documents: ParsedDocument[]; warnings: string[] };

export const SUPPORTED_EXTENSIONS = ['.docx', '.xlsx', '.csv', '.tsv', '.txt', '.md', '.json'];
export const ACCEPT_ATTRIBUTE = SUPPORTED_EXTENSIONS.join(',');
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 20;
const MAX_ROWS = 500;
const MAX_PARAGRAPHS = 2000;
const COLORS = ['#7566d9', '#6599a2', '#ce956c', '#8d93be', '#9d85b0'];

/** 只解码 XML 实体，不解析或执行任何标记，避免文档内容变成可执行 HTML。 */
export function decodeXml(value: string): string {
  return value
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&apos;/gu, "'")
    .replace(/&#x([\da-f]+);/giu, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16) || 0))
    .replace(/&#(\d+);/gu, (_, decimal: string) => String.fromCodePoint(Number(decimal) || 0))
    .replace(/&amp;/gu, '&');
}

function decodeText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (!utf8.includes('\uFFFD')) return utf8.replace(/^\uFEFF/u, '');
  try { return new TextDecoder('gbk').decode(bytes); } catch { return utf8; }
}

/** Word 正文按段落抽取纯文本，短行在后续映射里作为标题。 */
export function parseDocxXml(xml: string): string[] {
  const lines: string[] = [];
  for (const block of xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/gu) ?? []) {
    const text = [...block.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)].map(match => decodeXml(match[1])).join('').trim();
    if (text) lines.push(text);
  }
  if (!lines.length) {
    for (const match of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)) {
      const text = decodeXml(match[1]).trim();
      if (text) lines.push(text);
    }
  }
  return lines.slice(0, MAX_PARAGRAPHS);
}

export function parseSharedStrings(xml: string): string[] {
  return (xml.match(/<si(?:\s[^>]*)?>[\s\S]*?<\/si>/gu) ?? [])
    .map(item => [...item.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)].map(match => decodeXml(match[1])).join(''));
}

function columnIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/iu)?.[0] ?? '';
  let value = 0;
  for (const char of letters.toUpperCase()) value = value * 26 + (char.charCodeAt(0) - 64);
  return value > 0 ? value - 1 : -1;
}

/** Excel 工作表按单元格列号还原成二维数组，跳过整行空白。 */
export function parseSheetXml(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const block of (xml.match(/<row(?:\s[^>]*)?>[\s\S]*?<\/row>/gu) ?? []).slice(0, MAX_ROWS)) {
    const values: string[] = [];
    for (const cell of block.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/gu)) {
      const attrs = cell[1] ?? cell[3] ?? '';
      const inner = cell[2] ?? '';
      const at = columnIndex(attrs.match(/\br="([^"]+)"/u)?.[1] ?? '');
      const type = attrs.match(/\bt="([^"]+)"/u)?.[1] ?? '';
      let text = '';
      if (type === 's') text = shared[Number(inner.match(/<v>([\s\S]*?)<\/v>/u)?.[1] ?? '-1')] ?? '';
      else if (type === 'inlineStr') text = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)].map(match => decodeXml(match[1])).join('');
      else text = decodeXml(inner.match(/<v>([\s\S]*?)<\/v>/u)?.[1] ?? '');
      const index = at >= 0 ? at : values.length;
      while (values.length < index) values.push('');
      values[index] = text.trim();
    }
    if (values.some(Boolean)) rows.push(values);
  }
  return rows;
}

/** CSV/TSV：支持逗号、制表符、双引号转义；跨行字段按行拆分处理。 */
export function parseDelimited(text: string): string[][] {
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u).filter(line => line.trim());
  if (!lines.length) return [];
  const separator = lines[0].includes('\t') && !lines[0].includes(',') ? '\t' : ',';
  return lines.slice(0, MAX_ROWS).map(line => {
    const cells: string[] = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (char === '"') {
        if (quoted && line[index + 1] === '"') { current += '"'; index++; }
        else quoted = !quoted;
      } else if (char === separator && !quoted) { cells.push(current.trim()); current = ''; }
      else current += char;
    }
    cells.push(current.trim());
    return cells;
  });
}

export function parsePlainText(text: string): string[] {
  return text.replace(/\r\n/gu, '\n').split(/\n{2,}/u).map(part => part.trim()).filter(Boolean).slice(0, MAX_PARAGRAPHS);
}

function parseJsonDocument(text: string): { paragraphs: string[]; rows: string[][] } {
  const data: unknown = JSON.parse(text);
  if (Array.isArray(data)) {
    const objects = data.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item)) as Array<Record<string, unknown>>;
    if (objects.length) {
      const keys = Array.from(new Set(objects.flatMap(item => Object.keys(item)))).slice(0, 40);
      return { paragraphs: [], rows: [keys, ...objects.slice(0, MAX_ROWS - 1).map(item => keys.map(key => String(item[key] ?? '').trim()))] };
    }
    return { paragraphs: data.map(item => String(item).trim()).filter(Boolean).slice(0, MAX_PARAGRAPHS), rows: [] };
  }
  if (data && typeof data === 'object') {
    return { paragraphs: [], rows: [['字段', '内容'], ...Object.entries(data as Record<string, unknown>).slice(0, MAX_ROWS - 1).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)])] };
  }
  return { paragraphs: [String(data)], rows: [] };
}

async function parseOne(file: File, ext: string): Promise<ParsedDocument> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const base: ParsedDocument = { fileName: file.name, paragraphs: [], rows: [], warnings: [] };
  if (ext === '.docx' || ext === '.xlsx') {
    const entries = unzipSync(bytes);
    if (ext === '.docx') return { ...base, paragraphs: parseDocxXml(decodeText(entries['word/document.xml'] ?? new Uint8Array())) };
    const shared = parseSharedStrings(decodeText(entries['xl/sharedStrings.xml'] ?? new Uint8Array()));
    const sheet = Object.keys(entries).filter(key => /^xl\/worksheets\/sheet\d+\.xml$/u.test(key)).sort()[0];
    return { ...base, rows: sheet ? parseSheetXml(decodeText(entries[sheet]), shared) : [] };
  }
  const text = decodeText(bytes);
  if (ext === '.csv' || ext === '.tsv') return { ...base, rows: parseDelimited(text) };
  if (ext === '.json') return { ...base, ...parseJsonDocument(text) };
  return { ...base, paragraphs: parsePlainText(text) };
}

/** 文件只在浏览器本地解析：不上传、不调用模型、不执行文档里的宏或脚本。 */
export async function importFiles(files: File[]): Promise<ImportResult> {
  const documents: ParsedDocument[] = [];
  const warnings: string[] = [];
  for (const file of files.slice(0, MAX_FILES)) {
    const ext = file.name.toLowerCase().match(/\.[^.]+$/u)?.[0] ?? '';
    if (!SUPPORTED_EXTENSIONS.includes(ext)) { warnings.push(`${file.name}：暂不支持该格式`); continue; }
    if (file.size > MAX_FILE_BYTES) { warnings.push(`${file.name}：超过 8 MB`); continue; }
    try {
      const document = await parseOne(file, ext);
      if (document.paragraphs.length || document.rows.length) documents.push(document);
      else warnings.push(`${file.name}：未识别到内容`);
    } catch (error) { warnings.push(`${file.name}：${error instanceof Error ? error.message : '解析失败'}`); }
  }
  if (files.length > MAX_FILES) warnings.push(`单次最多处理 ${MAX_FILES} 个文件`);
  return { documents, warnings };
}

const ALIASES: Record<string, string[]> = {
  title: ['标题', '问题', '知识点', '主题', 'title', 'question', '关键词'],
  answer: ['解答', '答案', '内容', '正文', '回复', 'answer', 'content', '说明'],
  name: ['姓名', '客户', '客户姓名', '称呼', '名字', '客户称呼', 'name'],
  phone: ['电话', '手机', '手机号', '联系电话', 'phone', 'mobile'],
  memberId: ['会员卡号', '卡号', '会员号', 'memberid'],
  wechatId: ['微信号', '微信', 'wechat'],
  stage: ['阶段', '客户阶段', 'stage'],
  note: ['备注', '说明', 'note'],
  babyMonths: ['宝宝月龄', '月龄', '宝宝年龄', 'age', 'months'],
  babyName: ['宝宝小名', '宝宝姓名', '小名'],
  allergies: ['过敏', '过敏史', '注意事项'],
  productName: ['名称', '商品', '品名', '商品名称', '服务名称', '商品/服务', 'name'],
  price: ['价格', '售价', '单价', '金额', 'price'],
  stock: ['库存', '数量', 'stock'],
  description: ['描述', '介绍', '详情', '商品说明', '说明', 'description'],
  type: ['类型', '类别', '品类', 'type'],
};

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s（）()/、：:]/gu, '');
}

/** 先做表头精确匹配，再做包含匹配；识别不到时由调用方回退到列序号。 */
export function findColumn(headers: string[], key: string): number {
  const aliases = ALIASES[key] ?? [];
  const values = headers.map(normalize);
  for (const alias of aliases) {
    const exact = values.indexOf(alias);
    if (exact >= 0) return exact;
  }
  for (const alias of aliases) {
    const partial = values.findIndex(value => value.includes(alias));
    if (partial >= 0) return partial;
  }
  return -1;
}

/** 文档段落标题同时充当检索词，避免再出现单独的关键词字段。 */
export function keywordsFor(title: string): string[] {
  const value = title.trim();
  if (!value) return [];
  const pieces = value.split(/[\s,，、|｜\/：:；;（）()【】\[\]。？?！!]+/u).map(part => part.trim()).filter(Boolean);
  const latin = value.match(/[a-z0-9]+/giu) ?? [];
  return Array.from(new Set([value, ...pieces, ...latin])).filter(word => word.length <= 80).slice(0, 12);
}

function groupParagraphs(lines: string[]): Array<{ title: string; body: string }> {
  const groups: Array<{ title: string; body: string }> = [];
  let current: { title: string; body: string[] } | null = null;
  for (const line of lines) {
    const heading = line.length <= 40 && !/[。！？；，,]$/u.test(line);
    if (heading) {
      if (current?.body.length) groups.push({ title: current.title, body: current.body.join('\n') });
      current = { title: line, body: [] };
    } else {
      if (!current) current = { title: '资料', body: [] };
      current.body.push(line);
    }
  }
  if (current?.body.length) groups.push({ title: current.title, body: current.body.join('\n') });
  if (!groups.length && lines.length) groups.push({ title: '资料', body: lines.join('\n') });
  return groups;
}

function makeTopic(title: string, answer: string, makeId: () => string): GuideTopic {
  const cleanTitle = title.slice(0, 200);
  return { id: makeId(), title: cleanTitle, keywords: keywordsFor(cleanTitle), answer: answer.slice(0, 4000), enabled: true };
}

/** 把上传的文档识别成知识库段落：表格按「问题/解答」列，Word 按短标题分段。 */
export function documentToTopics(documents: ParsedDocument[], makeId: () => string = () => crypto.randomUUID(), limit = 50): GuideTopic[] {
  const topics: GuideTopic[] = [];
  if (limit <= 0) return topics;
  for (const document of documents) {
    if (document.rows.length > 1) {
      const headers = document.rows[0];
      const titleAt = Math.max(findColumn(headers, 'title'), 0);
      const answerAt = findColumn(headers, 'answer');
      for (const row of document.rows.slice(1)) {
        const title = (row[titleAt] ?? '').trim();
        const answer = (answerAt >= 0 ? row[answerAt] : row.filter((_, index) => index !== titleAt).join(' ')).trim();
        if (!title || !answer) continue;
        topics.push(makeTopic(title, answer, makeId));
        if (topics.length >= limit) return topics;
      }
    }
    for (const group of groupParagraphs(document.paragraphs)) {
      topics.push(makeTopic(group.title, group.body, makeId));
      if (topics.length >= limit) return topics;
    }
  }
  return topics;
}

const STAGES: Customer['stage'][] = ['新客户', '潜在客户', '活跃客户', '重点维护', '待唤醒'];

/** 客户表按列名自主识别，重复的姓名或电话只跳过、不覆盖已有档案。 */
export function documentToCustomers(documents: ParsedDocument[], existing: Customer[], makeId: () => string = () => crypto.randomUUID(), today: () => string = () => new Date().toISOString().slice(0, 10)): { customers: Customer[]; skipped: number } {
  const added: Customer[] = [];
  let skipped = 0;
  const names = new Set(existing.map(customer => customer.name.trim()));
  const phones = new Set(existing.map(customer => (customer.phone ?? '').replace(/\D/gu, '')).filter(Boolean));
  for (const document of documents) {
    const rows = document.rows.length ? document.rows : document.paragraphs.map(line => [line]);
    if (!rows.length) continue;
    const headers = rows[0];
    const hasHeader = findColumn(headers, 'name') >= 0 || findColumn(headers, 'phone') >= 0 || findColumn(headers, 'memberId') >= 0;
    const data = hasHeader ? rows.slice(1) : rows;
    const at = (key: string, fallback: number) => hasHeader ? Math.max(findColumn(headers, key), fallback === 0 ? 0 : -1) : fallback;
    for (const row of data.slice(0, MAX_ROWS)) {
      if (existing.length + added.length >= 500) break;
      const name = (row[at('name', 0)] ?? '').trim().slice(0, 120);
      if (!name) continue;
      const phone = (at('phone', -1) >= 0 ? row[at('phone', -1)] ?? '' : '').trim().slice(0, 40);
      const phoneKey = phone.replace(/\D/gu, '');
      if (names.has(name) || (phoneKey.length >= 6 && phones.has(phoneKey))) { skipped++; continue; }
      const memberId = (at('memberId', -1) >= 0 ? row[at('memberId', -1)] ?? '' : '').trim().slice(0, 80);
      const stageText = (at('stage', -1) >= 0 ? row[at('stage', -1)] ?? '' : '').trim();
      const monthsAt = at('babyMonths', -1);
      const monthsText = monthsAt >= 0 ? (row[monthsAt] ?? '').replace(/\D/gu, '') : '';
      const babyMonths = monthsText ? Number(monthsText) : Number.NaN;
      const babyName = (at('babyName', -1) >= 0 ? row[at('babyName', -1)] ?? '' : '').trim().slice(0, 80);
      const allergies = (at('allergies', -1) >= 0 ? row[at('allergies', -1)] ?? '' : '').trim().slice(0, 500);
      const baby = babyName || allergies || Number.isInteger(babyMonths) ? {
        ...(babyName ? { name: babyName } : {}),
        ...(allergies ? { allergies } : {}),
        ...(Number.isInteger(babyMonths) && babyMonths >= 0 && babyMonths <= 72 ? { ageMonths: babyMonths } : {}),
      } : undefined;
      added.push({
        id: makeId(), name, wechatId: (at('wechatId', -1) >= 0 ? row[at('wechatId', -1)] ?? '' : '').trim().slice(0, 200),
        color: COLORS[(existing.length + added.length) % COLORS.length],
        stage: STAGES.find(stage => stage === stageText) ?? '新客户',
        tags: [], manualTags: [], summary: '', preferences: '', budget: '',
        note: (at('note', -1) >= 0 ? row[at('note', -1)] ?? '' : '').trim().slice(0, 8000),
        createdAt: today(), lastContactAt: '', nextFollowUpAt: '', source: 'manual', evidence: [], messages: [],
        ...(memberId ? { memberId } : {}), ...(phone ? { phone } : {}), ...(baby ? { baby } : {}),
      });
      names.add(name);
      if (phoneKey.length >= 6) phones.add(phoneKey);
    }
  }
  return { customers: added, skipped };
}

/** 商品表按列名自主识别；同名商品跳过，价格非法时置空由店员人工报价。 */
export function documentToProducts(documents: ParsedDocument[], existing: Product[], makeId: () => string = () => crypto.randomUUID(), limit = 100): { products: Product[]; skipped: number } {
  const added: Product[] = [];
  let skipped = 0;
  const names = new Set(existing.map(product => product.name.trim()));
  for (const document of documents) {
    const rows = document.rows.length ? document.rows : document.paragraphs.map(line => [line]);
    if (!rows.length) continue;
    const headers = rows[0];
    const hasHeader = findColumn(headers, 'productName') >= 0 || findColumn(headers, 'price') >= 0;
    const data = hasHeader ? rows.slice(1) : rows;
    const at = (key: string, fallback: number) => hasHeader ? Math.max(findColumn(headers, key), fallback === 0 ? 0 : -1) : fallback;
    for (const row of data.slice(0, MAX_ROWS)) {
      if (existing.length + added.length >= limit) break;
      const name = (row[at('productName', 0)] ?? '').trim().slice(0, 160);
      if (!name) continue;
      if (names.has(name)) { skipped++; continue; }
      const priceText = (at('price', -1) >= 0 ? row[at('price', -1)] ?? '' : '').replace(/[¥￥,，\s]/gu, '');
      const priceValue = priceText ? Number(priceText) : Number.NaN;
      const price = Number.isFinite(priceValue) && priceValue >= 0 && priceValue <= 100_000_000 ? priceValue : null;
      const stockText = (at('stock', -1) >= 0 ? row[at('stock', -1)] ?? '' : '').replace(/[,\s]/gu, '');
      const stockValue = stockText ? Number(stockText) : Number.NaN;
      const stock = Number.isInteger(stockValue) && stockValue >= 0 && stockValue <= 1_000_000_000 ? stockValue : undefined;
      const typeText = (at('type', -1) >= 0 ? row[at('type', -1)] ?? '' : '').trim();
      const description = (at('description', -1) >= 0 ? row[at('description', -1)] ?? '' : '').trim().slice(0, 8000);
      added.push({
        id: makeId(), name, type: /服务|咨询|课程/u.test(typeText) ? 'service' : 'product', price,
        description: description || name, faq: [], enabled: true, source: 'manual',
        ...(stock !== undefined ? { stock, restockThreshold: 0 } : {}),
      });
      names.add(name);
    }
  }
  return { products: added, skipped };
}
