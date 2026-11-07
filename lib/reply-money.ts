type Amount = { value: number; start: number; end: number };
const numberPart = String.raw`[+-]?(?:\d(?:[\d,.]*\d)?|\.\d+)`;

function amounts(text: string, allowKuai = false): Amount[] {
  const unit = allowKuai ? '(?:元|块)' : '元';
  const pattern = new RegExp(String.raw`(?<![\d.])(?:[¥￥]\s*(${numberPart})(?![\d.])\s*(?:${unit})?|(${numberPart})\s*${unit})`, 'gu');
  return Array.from(text.matchAll(pattern), match => {
    const raw = match[1] ?? match[2];
    const valid = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw) || /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw);
    return { value: valid ? Number(raw.replaceAll(',', '')) : NaN, start: match.index!, end: match.index! + match[0].length };
  });
}

function budgetOccurrence(text: string, amount: Amount): boolean {
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

export function unverifiedReplyAmounts(reply: string, sourceTexts: string[], customerTexts: string[]): number[] {
  const allowed = new Set(sourceTexts.flatMap(text => amounts(text).map(item => item.value)).filter(Number.isFinite));
  const budgets = new Set<number>();
  for (const text of customerTexts) {
    // 报价、退款、已发生付款等金额不能变成给新报价放行的预算依据。
    if (/报价|标价|售价|单价|退款|退货|退钱|赔偿|转账|收款|已付|付款|支付|改价/u.test(text)) continue;
    for (const amount of amounts(text, true)) if (budgetOccurrence(text, amount)) budgets.add(amount.value);
  }
  // 多个不同预算的适用关系不明确时，不自行选择其中一个。
  const budget = budgets.size === 1 ? [...budgets][0] : undefined;
  return amounts(reply).filter(amount => !allowed.has(amount.value) && !(budget !== undefined && amount.value === budget && budgetOccurrence(reply, amount))).map(amount => amount.value);
}
