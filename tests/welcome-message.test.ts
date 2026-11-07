import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWelcomeMessage, DEFAULT_WELCOME_MESSAGE, welcomeMessageError, welcomeSettingsFor } from '../app/components/welcome-message.ts';

test('未配置时使用固定默认，明确空串和停用保持商家选择', () => {
  assert.deepEqual(welcomeSettingsFor(), { enabled: true, message: '您好，欢迎添加本店！这里可以咨询商品和服务，欢迎告诉我们您的需求。' });
  assert.deepEqual(welcomeSettingsFor({ welcomeEnabled: false, welcomeMessage: '' }), { enabled: false, message: '' });
  assert.equal(welcomeSettingsFor({ welcomeMessage: '' }).message, '');
  assert.equal(welcomeSettingsFor({ welcomeMessage: '   ' }).message, '   ');
  assert.equal(buildWelcomeMessage({}), DEFAULT_WELCOME_MESSAGE);
});

test('启用且空白不能保存，停用且明确留空不会偷偷补文字', () => {
  assert.match(welcomeMessageError(true, '')!, /请填写/);
  assert.match(welcomeMessageError(true, '  \n ')!, /请填写/);
  assert.equal(welcomeMessageError(false, ''), null);
  assert.match(welcomeMessageError(false, '文'.repeat(301))!, /300/);
  assert.match(welcomeMessageError(true, '欢迎\0内容')!, /空字符/);
});

test('生成内容只引用填写资料，电话号码完整且营业时段准确', () => {
  const details = { storeName: '合成门店', serviceContent: '提供预约咨询服务', phone: '010-00000000', address: '合成街道1号', businessHours: { enabled: true, start: '09:30', end: '18:00', days: [1, 3, 5] } };
  const before = structuredClone(details);
  const text = buildWelcomeMessage(details);
  for (const fact of [details.storeName, details.serviceContent, details.phone, details.address, '周一、周三、周五', '09:30–18:00']) assert.ok(text.includes(fact), fact);
  assert.equal(/优惠|折扣|24小时|免费|保证/.test(text), false);
  assert.ok(text.length <= 300);
  assert.deepEqual(details, before);
});

test('未填写的地址电话和未启用时段不加入欢迎语', () => {
  const text = buildWelcomeMessage({ storeName: '只有店名', businessHours: { enabled: false, start: '09:00', end: '18:00', days: [1] } });
  assert.ok(text.includes('只有店名'));
  assert.equal(/联系电话|地址：|营业时间|09:00/.test(text), false);
  const invalid = buildWelcomeMessage({ serviceContent: '合成服务', businessHours: { enabled: true, start: '25:00', end: '26:00', days: [1] } });
  assert.equal(invalid.includes('营业时间'), false);
});

test('长资料按300字符收束，不截断电话号码或Unicode字符', () => {
  const text = buildWelcomeMessage({ storeName: '合成🌿店名'.repeat(30), serviceContent: '合成服务🌿'.repeat(300), phone: '010-00000000', address: '合成地址🌿'.repeat(100), businessHours: { enabled: true, start: '08:00', end: '20:00', days: [0, 1, 2, 3, 4, 5, 6] } });
  assert.ok(text.length <= 300);
  assert.ok(text.isWellFormed());
  assert.ok(text.includes('010-00000000'));
  assert.ok(text.includes('…'));
  assert.ok(text.endsWith('欢迎告诉我们您的需求。'));
});
