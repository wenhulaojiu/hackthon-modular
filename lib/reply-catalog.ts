import type { Product, ReplyResult } from './types';

type Message = { text: string; date: string };
type Turn = Message & { sender: 'customer' | 'merchant' };
type Scope = 'product' | 'service' | 'all';
type Request = { scope: Scope | null; mode: 'catalog' | 'recommend'; other: boolean; maxPrice?: number };
const scopeFor = (noun?: string): Scope => noun === '商品' || noun === '产品' ? 'product' : noun === '服务' || noun === '服务项目' ? 'service' : 'all';
const normalize = (text: string) => text.normalize('NFKC').toLowerCase();

function parseRequest(text: string): Request | null {
  if (typeof text !== 'string' || text.length > 120) return null;
  let value = normalize(text).trim().replace(/[?!。.~]+$/u, '').trim();
  // 只接受完整简单句；不删句中标点，避免把复合问题或附加指令揉成目录请求。
  value = value.replace(/^(?:你好|您好)[,，\s]*/u, '').replace(/^请问[,，\s]*/u, '').replace(/\s+/gu, '').replace(/[吗呢呀啊]$/u, '');
  // 仅识别完整的简单金额推荐；没有类型时只列商品，类别或其他约束仍交回AI。
  const amount = String.raw`(\d+(?:\.\d+)?)`;
  const unit = '(?:元|块)(?:钱)?';
  const noun = '(商品|产品|服务项目|服务)?';
  const budgetRecommendation = value.match(new RegExp(`^(?:预算)?${amount}${unit}(?:(?:以内|以下|之内)的?)?请?(?:推荐(?:什么|哪些|几款|一些|几个|几种)|(?:可以|能)买(?:什么|哪些))${noun}$`, 'u'))
    ?? value.match(new RegExp(`^请?(?:给我|帮我)?推荐(?:几款|一些|几个|几种)?${amount}${unit}(?:以内|以下|之内)的?${noun}$`, 'u'));
  if (budgetRecommendation) {
    const maxPrice = Number(budgetRecommendation[1]);
    if (!Number.isFinite(maxPrice) || maxPrice < 0) return null;
    return { scope: budgetRecommendation[2]?.startsWith('服务') ? 'service' : 'product', mode: 'recommend', other: false, maxPrice };
  }
  if (/^(?:还有其他的|还有别的|还有其他|还有别的吗)$/u.test(value)) return { scope: null, mode: 'catalog', other: true };
  let match = value.match(/^(?:你们|店里|店内|这里)?(?:都)?(?:卖什么|卖哪些(?:商品|产品)?)$/u);
  if (match) return { scope: 'product', mode: 'catalog', other: false };
  match = value.match(/^(?:你们|店里|店内|这里)?(?:都)?(?:有哪些|有什么|提供哪些|提供什么)(商品|产品|服务项目|服务|项目)$/u);
  if (match) return { scope: scopeFor(match[1]), mode: 'catalog', other: false };
  match = value.match(/^(商品|产品|服务项目|服务|项目)(?:有)?哪些$/u);
  if (match) return { scope: scopeFor(match[1]), mode: 'catalog', other: false };
  match = value.match(/^(?:你们|店里|店内|这里)?还(?:有|提供)(?:什么|哪些)?(?:其他|别的)?(商品|产品|服务项目|服务|项目)$/u);
  if (match) return { scope: scopeFor(match[1]), mode: 'catalog', other: true };
  match = value.match(/^(?:你们|店里|店内|这里)?(?:有|提供)(?:什么|哪些)?(?:其他|别的)(商品|产品|服务项目|服务|项目)$/u);
  if (match) return { scope: scopeFor(match[1]), mode: 'catalog', other: true };
  match = value.match(/^请?(再|还)?(?:给我|帮我)?推荐(?:几款|一些|几个|几种)(商品|产品|服务项目|服务|项目)?$/u);
  if (match) return { scope: scopeFor(match[2]), mode: 'recommend', other: !!match[1] };
  return null;
}

function mentionedProducts(products: Product[], history: Turn[]): Set<string> {
  const found = new Set<string>();
  for (const turn of history) {
    const text = normalize(turn.text);
    const matches: Array<{ product: Product; start: number; end: number }> = [];
    for (const product of products) {
      const name = normalize(product.name.trim());
      if (!name) continue;
      for (let start = text.indexOf(name); start >= 0; start = text.indexOf(name, start + name.length)) matches.push({ product, start, end: start + name.length });
    }
    const chosen: Array<{ start: number; end: number }> = [];
    // 完整长名称优先，提到“红豆面包”不连带排除另一个名为“面包”的项目。
    for (const item of matches.sort((a, b) => (b.end - b.start) - (a.end - a.start))) {
      if (chosen.some(span => item.start >= span.start && item.end <= span.end && (item.start !== span.start || item.end !== span.end))) continue;
      chosen.push(item); found.add(item.product.id);
    }
  }
  return found;
}

function simpleHistoricalQuestion(text: string, products: Product[]): boolean {
  const request = parseRequest(text);
  if (request) return request.maxPrice === undefined;
  const value = normalize(text).trim().replace(/[?!。.~]+$/u, '').replace(/^(?:你好|您好)[,，\s]*/u, '').replace(/^请问[,，\s]*/u, '').replace(/\s+/gu, '');
  const acknowledgement = value.replace(/[\p{P}\p{S}]/gu, '');
  if (!acknowledgement || new Set(['你好', '您好', 'hi', 'hello', '哈喽', '嗨', '嗯', '嗯嗯', '好', '好的', '收到', '知道了', '了解了', '明白了', '谢谢', '谢谢你', '谢谢您', '谢谢啦', '好的谢谢', '好谢谢', '稍后再说']).has(acknowledgement)) return true;
  const suffixes = new Set(['', '呢', '啊', '呀', '多少钱', '多少钱啊', '价格', '价格多少', '什么价格', '价格是多少', '怎么卖', '有货', '有货吗', '还有吗', '怎么样', '保质期', '保质期多久', '保质期是多久', '保质期多长', '怎么保存', '如何保存', '怎么储存', '如何储存', '保存多久', '能放多久', '有什么口味', '是什么口味', '有哪些口味', '口味是什么']);
  if (value && suffixes.has(value)) return true;
  // 只放行已知名称和无条件短查询；未知历史内容交回AI，不靠穷举禁忌词猜约束。
  const prefixes = ['', '我想了解', '我想了解一下', '想了解', '想了解一下', '我想咨询', '我想咨询一下', '想咨询', '想咨询一下', '介绍一下', '请介绍一下', '请介绍', '了解一下'];
  for (const prefix of prefixes) {
    if (!value.startsWith(prefix)) continue;
    const remaining = value.slice(prefix.length);
    for (const product of products) {
      const name = normalize(product.name.trim()).replace(/\s+/gu, '');
      if (name && remaining.startsWith(name) && suffixes.has(remaining.slice(name.length))) return true;
    }
  }
  return false;
}

function budgetHistoryResolved(history: Turn[], products: Product[], scope: Scope): boolean {
  const compact = (text: string) => normalize(text).trim().replace(/[?!。.~]+$/u, '').replace(/\s+/gu, '');
  const money = String.raw`(?:[¥￥]?\d+(?:\.\d+)?(?:元|块)(?:钱)?)`;
  const pureBudget = new RegExp(`^(?:(?:(?:我|本次|这次)的?)?预算(?:只有|是|为|在|不超过|最多|上限(?:是|为)?)?${money}(?:以内|以下|之内|内)?|(?:不超过|最多)${money}|${money}(?:以内|以下|之内|的预算))$`, 'u');
  for (const [index, turn] of history.entries()) {
    if (turn.sender !== 'customer') continue;
    const value = compact(turn.text);
    // 持续的饮食、类别和偏好条件不能被新预算或商家的后续应答冲掉。
    if (/过敏|乳糖|忌口|禁忌|不耐受|素食|吃素|偏好|喜欢|不(?:能|要|想|吃|喝)|只(?:要|看|吃|喝|选)|必须|仅限/u.test(value)) return false;
    const priorRequest = parseRequest(turn.text);
    if (priorRequest?.maxPrice !== undefined) {
      if (priorRequest.scope !== scope) return false;
      continue;
    }
    // 当前明确预算更新的是纯预算维度，不能让附带其他要求的旧句混入。
    if (pureBudget.test(value) || simpleHistoricalQuestion(turn.text, products)) continue;
    const inquiry = value.replace(/^(?:你好|您好)[,，]*/u, '').replace(/^请问[,，]*/u, '');
    const answered = history.slice(index + 1).some(next => next.sender === 'merchant' && /[\p{L}\p{N}]/u.test(next.text) && !/^[a-z]$/iu.test(next.text.trim()));
    if (answered && products.some(product => {
      const name = normalize(product.name.trim()).replace(/\s+/gu, '');
      return name && inquiry.startsWith(name) && /^(?:多少钱|价格多少)(?:一|每)(?:份|个|杯|盒|件|套|束)[吗呢呀啊]?$/u.test(inquiry.slice(name.length));
    })) continue;
    const reservation = value.match(/^请?(?:帮我|给我)?(?:预留|留)(?:[一二三四五六七八九十两]+|\d+)(?:个|份|杯|盒|件|套|束)(.*)$/u);
    const nextTurn = history.slice(index + 1).find(next => next.text.trim());
    const acknowledged = nextTurn?.sender === 'merchant' && /^(?:好|好的|可以|行|收到|没问题|已为您预留|已帮您预留|已留好)[！!。.\s]*$/u.test(nextTurn.text.trim());
    if (reservation && acknowledged && (!reservation[1] || products.some(product => normalize(product.name.trim()).replace(/\s+/gu, '') === reservation[1]))) continue;
    // 未识别的实质内容继续交给AI，不能因为当前问题完整就丢掉历史。
    return false;
  }
  return true;
}

export function suggestCatalogReply(products: Product[], messages: Message[], context: Turn[], maxReplyChars: number): ReplyResult | null {
  if (!messages.length || !Number.isFinite(maxReplyChars)) return null;
  const limit = Math.min(300, Math.floor(maxReplyChars));
  if (limit < 40) return null;
  const requests = messages.map(message => parseRequest(message.text));
  if (requests.some(request => !request)) return null;
  const current = new Set(messages.map(message => `${message.date}\0${message.text}`));
  const preceding = context.filter(turn => turn.sender !== 'customer' || !current.has(`${turn.date}\0${turn.text}`));
  const history = preceding.slice(-6);
  const valid = products.filter(product => typeof product.name === 'string' && product.name.trim() && product.name.isWellFormed() && !product.name.includes('\0'));
  const mentioned = mentionedProducts(valid, history);
  const mentionedTypes = new Set(valid.filter(product => mentioned.has(product.id)).map(product => product.type));
  const resolved = requests.map(request => {
    if (request!.scope !== null) return request!;
    return mentionedTypes.size === 1 ? { ...request!, scope: [...mentionedTypes][0] } : null;
  });
  if (resolved.some(request => !request)) return null;
  const request = resolved[0]!;
  if (resolved.some(item => item!.scope !== request.scope || item!.mode !== request.mode || item!.other !== request.other || item!.maxPrice !== request.maxPrice)) return null;
  // 普通目录保留原有完整历史保护；明确预算只更新已识别的预算维度。
  if (request.maxPrice !== undefined) {
    if (!budgetHistoryResolved(preceding, valid, request.scope!)) return null;
  } else if (preceding.some(turn => turn.sender === 'customer' && !simpleHistoricalQuestion(turn.text, valid))) return null;
  const candidates = valid.filter(product => product.enabled && (request.scope === 'all' || product.type === request.scope) && (!request.other || !mentioned.has(product.id)) && (request.mode !== 'recommend' || product.type !== 'product' || product.stock !== 0) && (request.maxPrice === undefined || typeof product.price === 'number' && Number.isFinite(product.price) && product.price >= 0 && product.price <= request.maxPrice));
  const prefix = '可参考：';
  const ending = '具体方案请店员确认。';
  const rows: string[] = [], ids: string[] = [];
  for (const product of candidates) {
    if (rows.length === 6) break;
    const price = product.price !== null && Number.isFinite(product.price) && product.price >= 0 ? `标价${product.price}元` : '价格需确认';
    const soldOut = product.type === 'product' && product.stock === 0 ? '（售罄）' : '';
    const row = `${product.type === 'service' ? '服务' : '商品'}·${product.name}：${price}${soldOut}`;
    if (`${prefix}\n${[...rows, row].join('\n')}\n${ending}`.length > limit) continue;
    rows.push(row); ids.push(product.id);
  }
  if (!rows.length) return { action: 'clarify', reply: '当前资料暂不足以完整列出其他项目，请向店员确认或指定名称咨询。', reason: '已启用目录没有符合本次范围且能完整列入字数限制的项目，需店员确认。', productIds: [] };
  return { action: 'reply', reply: `${prefix}\n${rows.join('\n')}\n${ending}`, reason: `依据已启用目录的name/type/price/stock结构字段生成${request.mode === 'recommend' ? '参考项目' : '目录'}${request.other ? '，排除最近6轮已提及的项目' : ''}；价格为目录标价，具体方案需店员确认。`, productIds: ids };
}
