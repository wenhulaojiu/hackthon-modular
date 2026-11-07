import assert from 'node:assert/strict';
import test from 'node:test';
import { assessReplyContext } from '../lib/reply-context.ts';
const products = ['面包', '美式咖啡', '燕麦拿铁'];
const incoming = (text: string) => [{ text, date: '2026-11-07T09:01:00Z' }];
const turn = (sender: 'customer' | 'merchant', text: string, date = '2026-11-07T09:00:00Z') => ({ sender, text, date });

test('已回答价格后的句号和致谢不再任意报价或重复介绍', () => {
  const history = [turn('customer','美式咖啡多少钱？'),turn('merchant','美式咖啡18元。')];
  for (const text of ['。','...','？','👍','好的，谢谢','谢谢','你好']) {
    assert.equal(assessReplyContext(incoming(text),history,products),'ignore',text);
  }
});

test('同一个句号在有待答问题时承接上下文，首次无上下文时先澄清', () => {
  assert.equal(assessReplyContext(incoming('。'),[turn('customer','美式咖啡多少钱？')],products),'answer');
  assert.equal(assessReplyContext(incoming('。'),[],products),'clarify');
});

test('当前消息自身在历史中时不被当作另一条待答问题', () => {
  const current = incoming('。');
  assert.equal(assessReplyContext(current,[turn('merchant','欢迎来到本店。'),turn('customer','。',current[0].date)],products),'ignore');
});

test('省略商品指代只有最近一轮能唯一确定时才允许回答', () => {
  assert.equal(assessReplyContext(incoming('这个多少钱？'),[],products),'clarify');
  assert.equal(assessReplyContext(incoming('那多少钱？'),[],products),'clarify');
  assert.equal(assessReplyContext(incoming('多少钱啊？'),[turn('merchant','我们有面包、美式咖啡和燕麦拿铁。')],products),'clarify');
  assert.equal(assessReplyContext(incoming('这个多少钱？'),[turn('customer','我想了解美式咖啡。')],products),'answer');
  assert.equal(assessReplyContext(incoming('那个有货吗'),[turn('merchant','面包和燕麦拿铁都可以咨询。'),turn('customer','先看看美式咖啡。')],products),'answer');
});

test('含明确问题的招呼与真实后续咨询不被硬过滤', () => {
  for(const text of ['你好，美式多少钱？','燕麦拿铁可以做热的吗？','牛角包多少钱？','退款找谁？'])assert.equal(assessReplyContext(incoming(text),[],products),'answer',text);
});
