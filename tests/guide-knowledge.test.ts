import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyGuideIntent, defaultGuideKnowledge, guideReply } from '../lib/guide-knowledge.ts';
import type { Product } from '../lib/types.ts';

const product = (name: string): Product => ({ id: name, name, type: 'product', price: 100, description: '门店登记资料', faq: [], enabled: true });
const options = (extra: Partial<Parameters<typeof guideReply>[1]> = {}) => ({
  knowledge: defaultGuideKnowledge(), products: [], storeAddress: '', maxReplyChars: 300, ...extra,
});

test('主观或无意义的排名提问被过滤，不给出优劣结论', () => {
  for (const text of ['哪个最好', '你们家哪款最有效', '排名第一的是哪个', '最畅销的是哪款', '哪个更好', '买哪个合适', '哪款更划算', '选哪个值不值']) {
    assert.equal(classifyGuideIntent(text).intent, 'subjective', text);
    const result = guideReply(text, options());
    assert.equal(result?.action, 'clarify', text);
    assert.doesNotMatch(result?.reply ?? '', /第一名|最推荐|保证最好/u, text);
    assert.match(result?.reply ?? '', /月龄|实际情况|需求/u, text);
  }
});

test('发烧头晕腹泻等医疗症状只提示就医，不提供诊断或产品推荐', () => {
  for (const text of ['宝宝发烧了怎么办', '有点头晕', '腹泻两天了']) {
    const result = guideReply(text, options({ products: [product('营养包')] }));
    assert.equal(result?.action, 'reply', text);
    assert.match(result?.reply ?? '', /医生|就医/u, text);
    assert.ok(!(result?.reply ?? '').includes('营养包'), text);
  }
  assert.equal(guideReply('宝宝头发偏黄', options())?.reason.includes('医疗'), false);
});

test('退款政策只复述已登记规则，退款办理请求交回人工', () => {
  const policy = guideReply('拆封了能退吗', options());
  assert.equal(policy?.action, 'clarify');
  assert.match(policy?.reply ?? '', /拆封后不予退款/u);
  assert.match(policy?.reply ?? '', /小罐装/u);
  assert.match(policy?.reply ?? '', /店员核实/u);
  assert.equal(guideReply('我要退款', options()), null);
  assert.equal(guideReply('帮我退掉这单', options()), null);
});

test('DHA 与鱼油使用通俗解答，不用化学式，也不承诺功效', () => {
  const result = guideReply('DHA和鱼油有什么区别', options({ products: [product('婴幼儿营养包')] }));
  assert.equal(result?.action, 'reply');
  assert.match(result?.reply ?? '', /简单说/u);
  assert.doesNotMatch(result?.reply ?? '', /二十二碳六烯酸|EPA|ω-3|化学式|含量比/u);
  assert.match(result?.reply ?? '', /婴幼儿营养包/u);
  assert.match(result?.reply ?? '', /医生|判断为准/u);
});

test('头发偏黄与晒太阳补钙给出基础照护常识，具体判断交回医生', () => {
  for (const text of ['宝宝头发黄是怎么回事', '晒太阳能补钙吗']) {
    const result = guideReply(text, options());
    assert.equal(result?.action, 'reply', text);
    assert.match(result?.reply ?? '', /医生|营养师/u, text);
    assert.doesNotMatch(result?.reply ?? '', /一定能|保证有效|必须买/u, text);
  }
});

test('客户担忧按先安抚、再共情、最后自然衔接资料的顺序回复', () => {
  const result = guideReply('我有点担心宝宝不适应', options({ products: [product('营养包')] }));
  assert.equal(result?.action, 'reply');
  const reply = result?.reply ?? '';
  assert.ok(reply.startsWith('别着急'));
  assert.ok(reply.indexOf('理解') > reply.indexOf('别着急'));
  assert.ok(reply.indexOf('资料') > reply.indexOf('理解'));
  assert.ok(reply.includes('营养包'));
  assert.doesNotMatch(reply, /保证|一定有效|立刻下单/u);
});

test('竞品对比不评价优劣，门店地址只引用已登记资料', () => {
  const competitor = guideReply('和别的牌子比怎么样', options());
  assert.match(competitor?.reply ?? '', /不方便替您评价|依据店里已登记的资料/u);
  assert.doesNotMatch(competitor?.reply ?? '', /别家不如|比不上|最差/u);
  const missing = guideReply('最近门店在哪', options());
  assert.equal(missing?.action, 'clarify');
  assert.match(missing?.reply ?? '', /请店员核对/u);
  const known = guideReply('最近门店在哪', options({ storeAddress: '上海市静安区示例路 1 号' }));
  assert.equal(known?.action, 'reply');
  assert.match(known?.reply ?? '', /上海市静安区示例路 1 号/u);
});

test('目录、预算与饮食禁忌咨询继续交回原有可核验流程', () => {
  for (const text of ['有哪些商品', '推荐几款', '50元推荐什么', '我对花生过敏，推荐几款', '面包多少钱']) {
    assert.equal(guideReply(text, options()), null, text);
  }
});

test('门店录入超长知识时不改写或截断原文，改为澄清并请店员核对', () => {
  const knowledge = defaultGuideKnowledge();
  knowledge.topics[0].answer = '合成资料，需按原文引用。'.repeat(80);
  const result = guideReply('DHA和鱼油有什么区别', options({ knowledge }));
  assert.equal(result?.action, 'clarify');
  assert.match(result?.reply ?? '', /店员核对/u);
  assert.ok(!(result?.reply ?? '').includes('合成资料'));
});

test('资料停用、缺失或回复超长时不抢答', () => {
  const knowledge = defaultGuideKnowledge();
  knowledge.topics[0].enabled = false;
  assert.equal(guideReply('DHA和鱼油有什么区别', options({ knowledge })), null);
  const tight = guideReply('DHA和鱼油有什么区别', options({ maxReplyChars: 40 }));
  assert.equal(tight?.action, 'clarify');
  assert.ok((tight?.reply ?? '').length <= 40);
  assert.equal(guideReply('', options()), null);
});
