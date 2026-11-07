import assert from 'node:assert/strict';
import test from 'node:test';
import { localPort } from '../scripts/local-wechat/local-port.mjs';

test('本地预览默认5173，可从环境变量读取独立端口', () => {
  const previous = process.env.KEXU_LOCAL_PORT;
  try {
    delete process.env.KEXU_LOCAL_PORT;
    assert.equal(localPort(), 5173);
    process.env.KEXU_LOCAL_PORT = '5183';
    assert.equal(localPort(), 5183);
  } finally {
    if (previous === undefined) delete process.env.KEXU_LOCAL_PORT;
    else process.env.KEXU_LOCAL_PORT = previous;
  }
});

test('本地端口接受空值默认值及1024至65535的边界', () => {
  assert.equal(localPort(''), 5173);
  assert.equal(localPort('1024'), 1024);
  assert.equal(localPort('65535'), 65535);
  assert.equal(localPort('5183'), 5183);
});

test('本地端口拒绝范围外、非整数及非字符串值', () => {
  for (const value of ['0', '80', '1023', '65536', '99999', '005183', ' 5183', '5183 ', '5183.5', '-5183', '1e4', 'port', null, 5183, {}, []]) {
    assert.throws(() => localPort(value), /1024至65535/, String(value));
  }
});
