import assert from 'node:assert/strict';
import test from 'node:test';
import { unverifiedReplyAmounts } from '../lib/reply-money.ts';

const sources = ['商品：面包；目录标价：10元', '商品：美式咖啡；目录标价：18元'];

test('目录金额照常核对，不把预算加入通用报价金额集合', () => {
  assert.deepEqual(unverifiedReplyAmounts('面包10元，美式咖啡18元。', sources, []), []);
  assert.deepEqual(unverifiedReplyAmounts('面包20元。', sources, ['预算20元。']), [20]);
  assert.deepEqual(unverifiedReplyAmounts('预算20元，面包20元。', sources, ['预算20元。']), [20]);
  assert.deepEqual(unverifiedReplyAmounts('预算20元，面包20元，咖啡20元。', sources, ['预算20元。']), [20, 20]);
  assert.deepEqual(unverifiedReplyAmounts('面包最多20元。', sources, ['预算20元。']), [20]);
});

test('真实两个预算句式可通过，商品价格仍逐项按资料核验', () => {
  assert.deepEqual(unverifiedReplyAmounts('在20元以内，可以了解美式咖啡18元。', sources, ['只看20块以内的饮品。']), []);
  assert.deepEqual(unverifiedReplyAmounts('您的预算20元，可以看看面包10元。', sources, ['我的预算只有20元。']), []);
});

test('预算标签、上限与后置预算语法只豁免客户真实提供的同一数字', () => {
  for (const reply of ['预算20元。', '您的预算只有20元。', '20元以内。', '20元以下。', '不超过20元。', '最多20元。', '20元的预算。', '按照您的预算20元，可以了解商品。']) assert.deepEqual(unverifiedReplyAmounts(reply, sources, ['预算只有20元。']), [], reply);
  for (const reply of ['20元以内。', '预算20元。', '最多20元。']) assert.deepEqual(unverifiedReplyAmounts(reply, sources, []), [20], reply);
  assert.deepEqual(unverifiedReplyAmounts('预算25元。', sources, ['预算20元。']), [25]);
});

test('商品金额即使写成上限或挨着预算也不能被错误豁免', () => {
  for (const reply of ['面包20元以内。', '面包不超过20元。', '面包20元的预算。', '预算20元对应面包20元。']) assert.deepEqual(unverifiedReplyAmounts(reply, sources, ['预算20元。']), [20], reply);
});

test('客户报价、退款与已付款金额不作为预算', () => {
  for (const customer of ['这款报价1元。', '1元报价。', '退款1元。', '退款不超过1元。', '已经付款1元。', '我支付了1元。', '报价1元，预算1元。']) assert.deepEqual(unverifiedReplyAmounts('预算1元，1元以内可以考虑。', sources, [customer]), [1, 1], customer);
});

test('零预算、零标价和小数不因真假判断或截尾而改变', () => {
  assert.deepEqual(unverifiedReplyAmounts('预算0元。', [], ['预算只有0元。']), []);
  assert.deepEqual(unverifiedReplyAmounts('体验0元。', ['体验标价0元'], []), []);
  assert.deepEqual(unverifiedReplyAmounts('面包0元。', sources, ['预算0元。']), [0]);
  assert.deepEqual(unverifiedReplyAmounts('预算20.5元，商品18元。', sources, ['预算只有20.50元。']), []);
  assert.deepEqual(unverifiedReplyAmounts('预算20.05元。', sources, ['预算20.5元。']), [20.05]);
  assert.deepEqual(unverifiedReplyAmounts('商品1.005元。', ['商品1.005元。'], []), []);
  assert.deepEqual(unverifiedReplyAmounts('商品1.005元。', [], []), [1.005]);
});

test('元和￥¥均核对完整数字，不把120或小数尾部当成20或5', () => {
  assert.deepEqual(unverifiedReplyAmounts('预算￥20元，面包¥10。', sources, ['预算￥20。']), []);
  assert.deepEqual(unverifiedReplyAmounts('预算120元。', sources, ['预算20元。']), [120]);
  assert.deepEqual(unverifiedReplyAmounts('商品￥120元。', ['商品20元。'], ['预算20元。']), [120]);
  assert.deepEqual(unverifiedReplyAmounts('预算0.5元。', sources, ['预算5元。']), [0.5]);
  assert.deepEqual(unverifiedReplyAmounts('商品￥1,200元。', ['商品1200元。'], []), []);
});

test('编号、重量和数量不是金额，也不能充当预算', () => {
  assert.deepEqual(unverifiedReplyAmounts('编号120，净重200克，每盒20片。', [], []), []);
  assert.deepEqual(unverifiedReplyAmounts('20元以内。', sources, ['只看20克以内的产品。']), [20]);
  assert.deepEqual(unverifiedReplyAmounts('20元以内。', sources, ['编号20。']), [20]);
});

test('没有预算标记或多种预算适用关系不确定时保守拒绝', () => {
  assert.deepEqual(unverifiedReplyAmounts('预算20元。', sources, ['20元。']), [20]);
  assert.deepEqual(unverifiedReplyAmounts('预算20元。', sources, ['预算20元。', '预算30元。']), [20]);
  assert.deepEqual(unverifiedReplyAmounts('商品20元。', ['商品20元。'], ['预算30元。']), []);
});

test('畸形货币数字保留为未核实值，不从尾部另取一个可放行金额', () => {
  const bad = unverifiedReplyAmounts('商品￥1.2.3元。', ['商品3元。'], ['预算3元。']);
  assert.equal(bad.length, 1); assert.equal(Number.isNaN(bad[0]), true);
});


test('金额后紧邻数量仍核验完整金额，不把数量接入金额', () => {
  for (const reply of ['面包20元2个。', '面包￥20元2个。', '面包20.50元2个。']) assert.deepEqual(unverifiedReplyAmounts(reply, sources, []), [reply.includes('20.50') ? 20.5 : 20], reply);
  assert.deepEqual(unverifiedReplyAmounts('面包10元2个，咖啡18元1杯。', sources, []), []);
  const bad = unverifiedReplyAmounts('商品￥1.2.3元2个。', ['商品3元。'], []);
  assert.equal(bad.length, 1); assert.equal(Number.isNaN(bad[0]), true);
});


test('客户口语金额推荐与购买询问可提供预算，回复报价仍逐处核验', () => {
  for (const customer of ['20元推荐什么产品', '20元推荐什么产品呢', '20元推荐什么产品？', '20元推荐什么产品呀？', '20块推荐几款', '20元能买什么', '推荐20元以内的产品', '请问20元可以推荐哪些饮品？']) {
    assert.deepEqual(unverifiedReplyAmounts('您的预算20元，可以看看面包10元和美式咖啡18元。', sources, [customer]), [], customer);
    assert.deepEqual(unverifiedReplyAmounts('预算20元，面包20元。', sources, [customer]), [20], customer);
    assert.deepEqual(unverifiedReplyAmounts('面包20元。', sources, [customer]), [20], customer);
  }
});

test('商品报价与不完整推荐句式不能误作客户预算', () => {
  for (const customer of ['面包20元', '报价20元', '退款20元', '面包20元推荐什么产品', '20元推荐面包', '20元推荐什么产品，面包要30元', '报价20元推荐什么产品', '退款20元能买什么']) {
    assert.deepEqual(unverifiedReplyAmounts('预算20元。', sources, [customer]), [20], customer);
  }
});
