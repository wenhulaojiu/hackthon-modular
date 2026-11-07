import { unverifiedReplyAmounts as verifyAmounts } from './reply-money-core.mjs';

// 保持原有类型接口，网页与本机队列复用相同规则。
export function unverifiedReplyAmounts(reply: string, sourceTexts: string[], customerTexts: string[]): number[] {
  return verifyAmounts(reply, sourceTexts, customerTexts);
}
