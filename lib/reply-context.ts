type Turn = { sender: 'customer' | 'merchant'; text: string; date: string };
type Incoming = { text: string; date: string };
export const CLARIFY_REPLY = '您想了解哪一款？告诉我商品或服务的名称，我来为您介绍。';
const compact = (text: string) => text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
const acknowledgements = new Set(['你好','您好','hi','hello','哈喽','嗨','嗯','嗯嗯','好','好的','行','收到','知道了','谢谢','谢谢你','谢谢您','ok','okay']);
const lowInformation = (text: string) => !compact(text) || acknowledgements.has(compact(text)) || /^(?:好(?:的)?|谢谢(?:你|您)?|嗯+|收到|知道了)+$/.test(compact(text));
const question = (text: string) => !lowInformation(text) && /[?？]|多少钱|价格|怎么|如何|什么|哪|有没有|有货|能否|可以.*吗|预约|营业|地址|电话|几点/.test(text);

// 结合待答问题、最近商家回复和商品指代决定是否需要AI，不用单个标点猜商品。
export function assessReplyContext(messages: Incoming[], history: Turn[], productNames: string[]): 'answer' | 'ignore' | 'clarify' {
  const currentKeys = new Set(messages.map(message => `${message.date}\0${message.text}`));
  const preceding = history.filter(turn => turn.sender !== 'customer' || !currentKeys.has(`${turn.date}\0${turn.text}`));
  const lastMerchant = preceding.findLastIndex(turn => turn.sender === 'merchant');
  const unanswered = preceding.slice(lastMerchant + 1).some(turn => turn.sender === 'customer' && question(turn.text));
  if (messages.every(message => lowInformation(message.text))) return unanswered ? 'answer' : lastMerchant >= 0 ? 'ignore' : 'clarify';
  const text = compact(messages.map(message => message.text).join(' '));
  const genericReference = /^(?:(?:这个|那个|这款|那款|它|这|那)(?:呢|怎么样|多少钱|什么价格|有货吗|还有吗|怎么预约|可以预约吗)?|多少钱|什么价格|价格多少|有货吗|还有吗|怎么预约|可以预约吗)[呀啊呢吧嘛]?$/.test(text);
  if (!genericReference) return 'answer';
  // 从最近提及商品的那一轮判断指代；列出多个商品时不能任挑一个报价。
  for (const turn of preceding.slice(-8).reverse()) {
    const mentioned = productNames.filter(name => compact(turn.text).includes(compact(name)));
    if (mentioned.length) return mentioned.length === 1 ? 'answer' : 'clarify';
  }
  return 'clarify';
}
