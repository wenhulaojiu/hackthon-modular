'use client';

import { Wallet } from 'lucide-react';
import type { AppState } from '../../lib/types';
import { computeValueTier, recommendationForTier, VALUE_TIER_LABELS } from '../../lib/customer-profile';

/** 推荐只依据已确认消费与目录标价，不推断购买力、不承诺适用或效果。 */
export default function ValueTierCard({ state, customerId }: { state: AppState; customerId: string }) {
  const customer = state.customers.find(item => item.id === customerId);
  if (!customer) return null;
  const tier = computeValueTier(state.orders, customerId);
  const recommendation = recommendationForTier(tier, state.products ?? []);
  return <section className="detail-section">
    <div className="detail-section-heading"><h3><Wallet size={17} />消费档次与推荐参考</h3></div>
    <div className="profile-facts">
      <div><span>会员卡 / 电话</span><p>{[customer.memberId, customer.phone].filter(Boolean).join(' / ') || '未绑定'}</p></div>
      <div><span>消费档次</span><p>{VALUE_TIER_LABELS[tier]}（仅统计已确认记录）</p></div>
    </div>
    <p className="muted small">推荐参考：{recommendation.names.length ? recommendation.names.join('、') : '暂无'}</p>
  </section>;
}
