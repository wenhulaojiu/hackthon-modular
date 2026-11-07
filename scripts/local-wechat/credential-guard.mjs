// 只判断是否疑似凭据，不提取、记录或返回原文中的密钥。
const CREDENTIAL_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/iu,
  /\b(?:API[\s_-]*Key|Secret[\s_-]*Key)\b[\s"'`:=：]*(?:是|为)?[\s"'`]*[A-Za-z0-9._~+/=-]{20,}/iu,
];

export function containsCredentialLikeText(value) {
  return typeof value === 'string' && CREDENTIAL_PATTERNS.some(pattern => pattern.test(value));
}
