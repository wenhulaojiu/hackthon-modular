// 网页生成与本机发送共用同一金额核验，预算引用不能为商品报价放行。
/** @typedef {{ value: number, start: number, end: number }} Amount */
const numberPart = String.raw`[+-]?(?:\d(?:[\d,.]*\d)?|\.\d+)`;

/** @typedef {{ amount: number, scope: 'product' | 'service' | null, recommendation: boolean }} CustomerBudget */
/** @param {string} text
 * @returns {CustomerBudget | null} */
export function parseCustomerBudget(text) {
  if (typeof text !== 'string' || text.length > 240) return null;
  // 无货币单位只在完整的明确预算句里推断为人民币，不从编号、数量或附加条件猜金额。
  const value = text.normalize('NFKC').toLowerCase().trim().replace(/[?!。.~]+$/u, '').trim().replace(/^(?:你好|您好)[,，\s]*/u, '').replace(/^请问[,，\s]*/u, '').replace(/\s+/gu, '').replace(/[吗呢呀啊吧呗]$/u, '');
  const amount = String.raw`((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)`;
  const unit = '(?:元|块)(?:钱)?';
  const upper = '(?:以内|以下|之内|内)';
  const prefix = '(?:(?:我|本次|这次)的?)?预算(?:只有|是|为|在|不超过|最多|上限(?:是|为)?)?';
  const noun = '(商品|产品|服务项目|服务)?';
  const recommendation = `(?:请?(?:给我|帮我)?(?:(?:可以|能)?推荐(?:一下|什么|哪些|几款|一些|几个|几种)?|(?:可以|能)(?:买|选)(?:什么|哪些))|(?:有(?:什么|哪些|啥)?|有没有(?:什么|啥)?)推荐(?:的)?)${noun}`;
  const recommended = value.match(new RegExp(`^${prefix}${amount}(?:${unit})?(?:${upper}的?)?[,，:：]?${recommendation}$`, 'u'))
    ?? value.match(new RegExp(`^${amount}${unit}(?:${upper}的?)?[,，:：]?${recommendation}$`, 'u'))
    ?? value.match(new RegExp(`^请?(?:给我|帮我)?推荐(?:一下|几款|一些|几个|几种)?${amount}${unit}${upper}的?${noun}$`, 'u'));
  const pure = recommended ? null : value.match(new RegExp(`^${prefix}${amount}(?:${unit})?(?:${upper})?$`, 'u'))
    ?? value.match(new RegExp(`^(?:不超过|最多)${amount}${unit}$`, 'u'))
    ?? value.match(new RegExp(`^${amount}${unit}(?:${upper}|的预算)$`, 'u'));
  const matched = recommended ?? pure;
  if (!matched) return null;
  const numeric = Number(matched[1].replaceAll(',', ''));
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return { amount: numeric, scope: recommended ? matched[2]?.startsWith('服务') ? 'service' : 'product' : null, recommendation: !!recommended };
}

/** @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {'source' | 'reply' | 'customer'} mode */
function bareKuaiIsMoney(text, start, end, mode) {
  const before = text.slice(0, start);
  const boundary = Math.max(...['，', ',', '。', '!', '！', '?', '？', ';', '；', '\n'].map(character => before.lastIndexOf(character)));
  const prefix = before.slice(boundary + 1);
  // 资料中的裸“块”需有明确价格引导，避免包装数量变成可引用的商品金额。
  if (/(?:售价|单价|价格|标价|定价|报价|价钱|收费|费用|服务费|运费|总价)(?:(?:为|是|有|约|大约|只需|只要|需要|共计|合计)|[\s:：])*$/u.test(prefix)) return true;
  if (mode === 'source') return false;
  // 回复保守检查裸“块”报价；明确的数量句和常见实物计量不按金额处理。
  if (/(?:有|含|包含|装有|内装|库存|存量|数量)(?:(?:为|是|有|约|大约)|[\s:：])*$/u.test(prefix)) return false;
  const after = text.slice(end).trimStart();
  if (/^(?:饼干|曲奇|巧克力|蛋糕|面包|香皂|肥皂|手工皂|积木|砖|石头|木头|豆腐|布料|牛肉|猪肉|鱼肉|肉|方糖|糖果|糖|冰块|冰)/u.test(after)) return false;
  return true;
}

/** @param {string} text
 * @param {'source' | 'reply' | 'customer'} [mode]
 * @returns {Amount[]} */
function amounts(text, mode = 'source') {
  const unit = '(元|块钱|块)';
  const pattern = new RegExp(String.raw`(?<![\d.])(?:[¥￥]\s*(${numberPart})(?![\d.])\s*(?:${unit})?|(${numberPart})\s*${unit})`, 'gu');
  return Array.from(text.matchAll(pattern)).flatMap(match => {
    const raw = match[1] ?? match[3];
    const suffix = match[2] ?? match[4];
    const end = match.index + match[0].length;
    if (match[1] === undefined && suffix === '块' && !bareKuaiIsMoney(text, match.index, end, mode)) return [];
    const valid = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw) || /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw);
    return [{ value: valid ? Number(raw.replaceAll(',', '')) : NaN, start: match.index, end }];
  });
}

/** @param {string} text
 * @param {Amount} amount
 * @returns {boolean} */
function budgetOccurrence(text, amount) {
  if (!Number.isFinite(amount.value) || amount.value < 0) return false;
  const before = text.slice(0, amount.start);
  const boundary = Math.max(...['，', ',', '。', '!', '！', '?', '？', ';', '；', '\n'].map(character => before.lastIndexOf(character)));
  const prefix = before.slice(boundary + 1).replace(/[\s:：]/gu, '');
  const suffix = text.slice(amount.end).replace(/^\s+/u, '');
  const subject = '(?:(?:按|按照|根据|以)?(?:您|你|我|客户|本次|这次)?的?)';
  if (new RegExp(`^${subject}预算(?:只有|是|为|在|不超过|最多|上限(?:是|为)?)?$`, 'u').test(prefix)) return true;
  if (new RegExp(`^${subject}(?:不超过|最多|至多|上限(?:是|为)?|控制在)$`, 'u').test(prefix)) return true;
  if (!/^(?:以内|以下|之内|的预算|预算)/u.test(suffix)) return false;
  // 上限数字前只允许明确的预算引导语，不能把“面包20元以内”当成预算引用。
  return /^(?:|按|按照|以|根据|在|您|你|我|您的|你的|我的|客户的|按您|按您的|按照您|按照您的|根据您|根据您的|在您|在您的|您提到的|按您提到的|只看|只要|想要|想找|推荐|推荐一些|推荐几款|可选)$/u.test(prefix);
}

/** @param {string} text
 * @param {Amount} amount
 * @returns {boolean} */
function customerBudgetOccurrence(text, amount) {
  if (budgetOccurrence(text, amount)) return true;
  if (!Number.isFinite(amount.value) || amount.value < 0) return false;
  // 客户以金额开头询问可推荐或可购买的产品，视为预算；商品报价不能套用此句式。
  const prefix = text.slice(0, amount.start).replace(/\s+/gu, '');
  const suffix = text.slice(amount.end).replace(/\s+/gu, '');
  if (!/^(?:请问|请|麻烦|想问(?:一下|下)?|我想问(?:一下|下)?)?$/u.test(prefix)) return false;
  return /^(?:钱)?(?:(?:以内|以下|之内)的?)?(?:(?:可以|能)?推荐(?:什么|哪些|几款|几种)(?:商品|产品|饮品|服务)?|(?:可以|能)(?:买|选)(?:什么|哪些)(?:商品|产品|饮品|服务)?)(?:呢|吗|呀|啊)?[。！？?!]*$/u.test(suffix);
}

/** @param {string} reply
 * @param {string[]} sourceTexts
 * @param {string[]} customerTexts
 * @param {string[]} [currentTexts]
 * @returns {number[]} */
export function unverifiedReplyAmounts(reply, sourceTexts, customerTexts, currentTexts = []) {
  // 扫描和预算定位使用同一份规范化文本，保证全角字符转换后的下标一致。
  reply = reply.normalize('NFKC');
  sourceTexts = sourceTexts.map(text => text.normalize('NFKC'));
  customerTexts = customerTexts.map(text => text.normalize('NFKC'));
  currentTexts = currentTexts.map(text => text.normalize('NFKC'));
  const allowed = new Set(sourceTexts.flatMap(text => amounts(text).map(item => item.value)).filter(Number.isFinite));
  const budgets = new Set();
  for (const text of customerTexts) {
    // 报价、退款、已发生付款等金额不能变成给新报价放行的预算依据。
    if (/报价|标价|售价|单价|退款|退货|退钱|赔偿|转账|收款|已付|付款|支付|改价/u.test(text)) continue;
    const simple = parseCustomerBudget(text);
    if (simple) budgets.add(simple.amount);
    for (const amount of amounts(text, 'customer')) if (customerBudgetOccurrence(text, amount)) budgets.add(amount.value);
  }
  // 调用方单独提供原始当前批次，避免把历史数组中较后的旧预算误当成最新要求。
  const current = currentTexts.map(parseCustomerBudget).filter(Boolean);
  const currentAmounts = new Set(current.map(item => item.amount));
  const currentScopes = new Set(current.map(item => item.scope).filter(Boolean));
  const currentValues = new Set(currentTexts);
  const historyScopes = new Set(customerTexts.filter(text => !currentValues.has(text)).map(parseCustomerBudget).filter(Boolean).map(item => item.scope).filter(Boolean));
  const hasUnparsedCurrentBudget = currentTexts.some(text => /预算|[¥￥]|\d\s*(?:元|块)/u.test(text) && !parseCustomerBudget(text));
  const sameScope = currentScopes.size <= 1 && (currentScopes.size === 0 || [...historyScopes].every(scope => currentScopes.has(scope)));
  const explicitCurrent = currentAmounts.size === 1 && !hasUnparsedCurrentBudget && sameScope ? [...currentAmounts][0] : undefined;
  // 当前批次有冲突或未识别的新预算时先确认，不能退回旧预算继续推荐。
  const ambiguousCurrent = currentAmounts.size > 1 || hasUnparsedCurrentBudget || !sameScope;
  const budget = ambiguousCurrent ? undefined : explicitCurrent ?? (budgets.size === 1 ? [...budgets][0] : undefined);
  return amounts(reply, 'reply').filter(amount => !allowed.has(amount.value) && !(budget !== undefined && amount.value === budget && budgetOccurrence(reply, amount))).map(amount => amount.value);
}
