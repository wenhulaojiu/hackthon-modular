import assert from 'node:assert/strict';
import test from 'node:test';
import { invocationSchema, driverMessageSchema } from '../scripts/connector-preview/protocol.mjs';

test('升级校验库后保留工具参数中的任意 JSON 值', () => {
  const argumentsValue = { query: '测试', limit: 3, nested: { enabled: true }, list: [1, null] };
  assert.deepEqual(invocationSchema.parse({ connectorId: 'github', actionName: 'search', arguments: argumentsValue }).arguments, argumentsValue);
  assert.equal(invocationSchema.safeParse({ connectorId: 'github', actionName: 'search', arguments: {}, accountId: 'unexpected' }).success, false);
  for (const value of [[], 'bad', null]) {
    assert.equal(invocationSchema.safeParse({ connectorId: 'github', actionName: 'search', arguments: value }).success, false);
  }
});

test('升级校验库后仍严格校验驱动消息并保留嵌套结果', () => {
  const message = { jsonrpc: '2.0', id: '00000000-0000-4000-8000-000000000001', result: { content: [{ type: 'text', text: '测试' }], isError: false } };
  assert.deepEqual(driverMessageSchema.parse(message), message);
  assert.equal(driverMessageSchema.safeParse({ ...message, result: [] }).success, false);
  assert.equal(driverMessageSchema.safeParse({ ...message, unexpected: true }).success, false);
});
