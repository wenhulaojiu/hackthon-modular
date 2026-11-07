// 只保留程序约定的错误分类，供应商正文、错误消息和调用栈不能进入接待队列。
export const GENERATION_FAILURES = Object.freeze({
  AI_KEY_MISSING: '尚未保存模型密钥，已转人工，请在设置中保存密钥。',
  AI_KEY_DECRYPT_FAILED: '已保存的模型密钥无法读取，已转人工，请重新保存密钥。',
  AI_KEY_ENCRYPTION_CONFIG: '本机密钥保存服务尚未就绪，已转人工，请检查本地服务。',
  AI_ENDPOINT_INVALID: '模型接口地址不正确，已转人工，请检查接口地址。',
  AI_AUTH_REJECTED: '模型服务拒绝了访问凭证，已转人工，请检查密钥和账户权限。',
  AI_RATE_LIMITED: '模型服务请求受限或额度不足，已转人工，请检查账户额度。',
  AI_TIMEOUT: '模型回复生成超时，已转人工，请稍后检查服务状态。',
  AI_NETWORK_UNREACHABLE: '暂时无法连接模型服务，已转人工，请检查网络和服务状态。',
  AI_PROXY_UNREACHABLE: '本机模型代理无法连接，已转人工，请检查代理程序和端口。',
  AI_TLS_ERROR: '模型服务的安全连接校验失败，已转人工，请检查网络证书。',
  AI_TRANSPORT_CONFIG: '本机模型连接服务尚未就绪，已转人工，请检查本地服务。',
  AI_RESPONSE_FORMAT: '模型回复格式不正确，已转人工，本条未自动发送。',
  AI_RESPONSE_EMPTY: '模型服务返回了空回复，已转人工，本条未自动发送。',
  AI_UPSTREAM_ERROR: '模型服务暂时无法完成请求，已转人工，请检查服务状态。',
  AI_INPUT_CREDENTIAL_BLOCKED: '消息可能包含密钥，已停止自动处理，请人工核对。',
  AI_UNKNOWN: '回复生成未完成，具体原因尚未确认，已转人工，本条未自动发送。',
});

export function normalizeGenerationFailure(value) {
  let suppliedCode, suppliedStatus;
  try { suppliedCode = value?.code; suppliedStatus = value?.status; } catch { /* 异常对象本身不可安全读取时也只使用固定提示。 */ }
  const code = typeof suppliedCode === 'string' && Object.hasOwn(GENERATION_FAILURES, suppliedCode) ? suppliedCode : 'AI_UNKNOWN';
  return { code, reason: GENERATION_FAILURES[code], ...(Number.isInteger(suppliedStatus) && suppliedStatus >= 400 && suppliedStatus <= 599 ? { status: suppliedStatus } : {}) };
}

export class GenerationError extends Error {
  constructor(code, status) {
    const failure = normalizeGenerationFailure({ code, status });
    super(failure.reason);
    this.name = 'GenerationError';
    this.code = failure.code;
    if (failure.status !== undefined) this.status = failure.status;
  }
}
