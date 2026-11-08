import assert from 'node:assert/strict';
import test from 'node:test';
import { replyWaitLabel, replyWaitSeconds, replyWaitValue } from '../features/auto-reply/reply-timing.ts';

test('秒与分钟转换保留整秒，支持1.5分钟及上限60分钟', () => {
  assert.equal(replyWaitSeconds('1.5', 'minutes'), 90);
  assert.equal(replyWaitSeconds('0.1', 'minutes'), 6);
  assert.equal(replyWaitSeconds('60', 'minutes'), 3600);
  assert.equal(replyWaitSeconds('3600', 'seconds'), 3600);
  assert.equal(replyWaitSeconds('0', 'seconds'), 0);
  assert.equal(replyWaitSeconds('0', 'minutes'), 0);
});

test('无效输入、非整秒和超出范围不被静默截断', () => {
  for (const value of ['', ' ', '-1', 'NaN', 'Infinity', '1e2', '3601', '1.5', '1.0000000001']) assert.equal(replyWaitSeconds(value, 'seconds'), null, value);
  for (const value of ['60.1', '-0.1', '0.01', '1.001']) assert.equal(replyWaitSeconds(value, 'minutes'), null, value);
});

test('反复切换单位不丢失秒数，也不把90秒改成整分钟', () => {
  for (const seconds of [0, 1, 29, 30, 59, 60, 90, 120, 300, 3599, 3600]) {
    assert.equal(replyWaitSeconds(replyWaitValue(seconds, 'minutes'), 'minutes'), seconds);
    assert.equal(replyWaitSeconds(replyWaitValue(seconds, 'seconds'), 'seconds'), seconds);
  }
});

test('状态标签说明0秒为不额外等待', () => {
  assert.equal(replyWaitLabel(0), '不额外等待');
  assert.equal(replyWaitLabel(30), '30秒');
  assert.equal(replyWaitLabel(60), '1分钟');
  assert.equal(replyWaitLabel(90), '1分30秒');
  assert.equal(replyWaitLabel(3600), '60分钟');
});
