import type { GuideKnowledge, GuideTopic, Product, ReplyResult } from './types';

export type GuideIntent = 'medical' | 'refund-request' | 'refund-policy' | 'subjective' | 'comfort' | 'topic' | 'competitor' | 'store' | null;
export type GuideMatch = { intent: GuideIntent; topic: GuideTopic | null };

const compact = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');

// 目录、预算与饮食禁忌类咨询交回原有可核验流程，避免知识规则抢答或丢掉客户限制。
const CATALOG_LIKE = /有哪些(?:商品|产品|服务|项目)|卖什么|卖哪些|推荐几款|推荐什么|多少钱|预算|\d+(?:元|块)|忌口|过敏|乳糖|不耐受|不吃|只要|不要|帮我留|预留/u;
const MEDICAL = /发烧|发热|高烧|头晕|呕吐|抽搐|惊厥|便血|腹痛|腹泻|拉肚子|咳嗽|气喘|用药|吃药|剂量|诊断|病情|体温|看医生|去医院|急诊/u;
const REFUND_REQUEST = /我要退款|帮我退款|帮我退|退钱|退货|申请退款|把钱退|退款给我|退掉|退单/u;
const REFUND_POLICY = /退款政策|退货政策|退换|能退吗|可以退吗|能不能退|拆封|开封|小罐|罐装|包装.*退|退.*规定/u;
const SUBJECTIVE = /哪个最好|哪款最好|哪个更好|哪款更好|哪个更划算|哪款更划算|更划算|买哪个|选哪个|值不值|最好的是|最好的|最有效|最管用|最划算|性价比最高|最好用|最靠谱|排名|排第几|第一名|哪家强|谁更好|最畅销|最受欢迎|秒杀|无敌/u;
const COMFORT = /担心|害怕|不敢|不放心|焦虑|有点慌|着急|纠结|顾虑|忧心|怕副作用|怕不适合/u;
const COMPETITOR = /竞品|别的牌子|其他牌子|比别家|哪个牌子好|和.{0,10}比|跟.{0,10}比|对比一下|对比/u;
const STORE = /最近门店|最近的店|门店地址|地址在哪|店在哪|在哪里|怎么走|门店电话|营业时间|几点开门/u;

export function defaultGuideKnowledge(): GuideKnowledge {
  return {
    topics: [
      {
        id: 'dha-fish-oil', title: 'DHA 与鱼油的区别', enabled: true,
        keywords: ['dha', '鱼油', '藻油'],
        answer: '简单说，家长常说的 DHA 更像“专门关注宝宝成长阶段的那类营养”，鱼油则更像日常综合补充，来源和适合的人群也不太一样，不用去记成分名词。每个宝宝月龄、饮食和医生建议都不同，我这边只能按店里登记的资料介绍，具体怎么选还是以您和医生的判断为准。',
      },
      {
        id: 'hair-yellow', title: '宝宝头发偏黄', enabled: true,
        keywords: ['头发黄', '发黄', '头发偏黄', '头发稀'],
        answer: '宝宝头发偏黄挺常见，通常和遗传、月龄、日晒、日常饮食都有关系，不一定是缺了什么。日常可以留意均衡辅食和适当户外活动；如果同时有生长、精神状态的变化，还是建议先请儿科医生看一看。',
      },
      {
        id: 'sun-calcium', title: '晒太阳与日常营养', enabled: true,
        keywords: ['晒太阳', '补钙', '钙片', '维生素d'],
        answer: '适当户外晒太阳、规律作息和均衡饮食，是家长常说的日常照护方式。是否需要额外补充、补多少，建议听儿科医生或营养师的，我们不替您判断用量。店里登记了相关营养资料，需要的话我可以按资料发您看看。',
      },
    ],
    policy: {
      openedRefund: '产品拆封后不予退款',
      smallCanRefund: '只有小罐装产品适用特殊退款政策',
      medicalBoundary: '宝宝出现发烧、头晕、腹泻等身体不适时涉及医疗判断，不在我们能提供的服务范围内。建议直接咨询儿科医生或到医院检查，我们不提供诊断、用药和剂量建议。',
      competitorPolicy: '别的牌子我不方便替您评价，也不做优劣比较。我们只能依据店里已登记的资料介绍自己的商品，具体选择还是以您和医生的判断为准。',
      storeAddress: '',
      revisitScript: '您好，想跟您了解一下宝宝最近的情况：吃睡和状态还好吗？有没有觉得和之前不一样的地方？如果医生有新的补充建议，也方便跟我说一声，我帮您记到档案里。这次不做产品推荐，您有需要随时找我。',
    },
  };
}

/** 只做意图分类，不生成回复；命中 refund-request 时交回原有售后转人工流程。 */
export function classifyGuideIntent(text: string, knowledge: GuideKnowledge = defaultGuideKnowledge()): GuideMatch {
  const value = compact(text);
  if (!value) return { intent: null, topic: null };
  if (MEDICAL.test(value)) return { intent: 'medical', topic: null };
  if (CATALOG_LIKE.test(value)) return { intent: null, topic: null };
  if (REFUND_REQUEST.test(value)) return { intent: 'refund-request', topic: null };
  if (REFUND_POLICY.test(value)) return { intent: 'refund-policy', topic: null };
  if (SUBJECTIVE.test(value)) return { intent: 'subjective', topic: null };
  if (COMFORT.test(value)) return { intent: 'comfort', topic: null };
  const topic = knowledge.topics.find(item => item.enabled && item.keywords.some(keyword => value.includes(compact(keyword)))) ?? null;
  if (topic) return { intent: 'topic', topic };
  if (COMPETITOR.test(value)) return { intent: 'competitor', topic: null };
  if (STORE.test(value)) return { intent: 'store', topic: null };
  return { intent: null, topic: null };
}

export type GuideReplyOptions = {
  knowledge?: GuideKnowledge;
  products?: Product[];
  storeAddress?: string;
  maxReplyChars: number;
  customerName?: string;
};

/** 依据已登记知识生成确定性回复；无匹配、资料不足或超长时返回 null，由原有流程继续处理。 */
export function guideReply(text: string, options: GuideReplyOptions): ReplyResult | null {
  const knowledge = options.knowledge ?? defaultGuideKnowledge();
  const { intent, topic } = classifyGuideIntent(text, knowledge);
  if (!intent || intent === 'refund-request') return null;
  const policy = knowledge.policy;
  const enabledNames = (options.products ?? []).filter(product => product.enabled && product.name.trim()).slice(0, 2).map(product => product.name.trim());
  const bridge = enabledNames.length ? `店里登记了${enabledNames.join('、')}的资料，需要的话我按资料发您看看。` : '需要的话我把店里已登记的资料发您看看，由您再对照决定。';
  let action: ReplyResult['action'] = 'reply';
  let reply = '';
  let reason = '';

  if (intent === 'medical') {
    reply = policy.medicalBoundary.trim();
    reason = '命中医疗症状意图，仅提示就医与说明服务边界，不提供诊断、用药或产品推荐。';
  } else if (intent === 'refund-policy') {
    action = 'clarify';
    reply = `跟您说明一下店里的退款规则：${policy.openedRefund.trim()}；${policy.smallCanRefund.trim()}。具体能否办理、怎么处理，需要店员核实后答复您。`;
    reason = '仅复述门店已登记的退款政策，不代为办理退款，涉及售后的请求仍转人工。';
  } else if (intent === 'subjective') {
    action = 'clarify';
    reply = '“最好”要看宝宝的月龄和实际情况，我不太适合直接给排名。您方便说说主要想解决什么、或者更在意哪一点吗？我按店里已登记的资料帮您对照看看。';
    reason = '主观排名类提问不做优劣结论，先询问真实需求，避免编造比较结果。';
  } else if (intent === 'comfort') {
    const who = options.customerName?.trim() ? `${options.customerName.trim()}，`.replace(/^您$/, '') : '';
    reply = `别着急，${who}慢慢说就好。给宝宝挑东西多想一层很正常，我理解这份担心。我们可以先按您最在意的点，对照店里已登记的资料一起看看，合适再决定。${bridge}`;
    reason = '按先安抚、再共情、最后自然衔接资料的顺序生成，不承诺效果、不催促成交。';
  } else if (intent === 'topic' && topic) {
    const answer = topic.answer.trim();
    if (answer.length + bridge.length > options.maxReplyChars) {
      // 门店可能录入长篇资料：不截断、不改写已登记原文，改为明确澄清，避免规则静默失效。
      action = 'clarify';
      reply = '这条资料比较长，我请店员核对一下再给您完整说明，您也可以先告诉我最想了解哪一点。';
      reason = '知识条目超出已配置的回复长度，按原文引用原则不截断、不改写，先澄清并请店员核对。';
    } else {
      reply = `${answer}${bridge}`;
      reason = `引用知识库条目「${topic.title}」的通俗解答，衔接已启用商品资料，不作功效或适用承诺。`;
    }
  } else if (intent === 'competitor') {
    reply = policy.competitorPolicy.trim();
    reason = '竞品对比只说明本店资料范围，不评价或贬低其他品牌。';
  } else if (intent === 'store') {
    const address = (policy.storeAddress || options.storeAddress || '').trim();
    if (!address) {
      action = 'clarify';
      reply = '门店地址还没登记完整，我请店员核对一下再回复您。';
      reason = '门店地址缺少可核验资料，不编造位置或路线。';
    } else {
      reply = `我们登记的地址是：${address}。出发前建议再和店员确认营业时间和路线。`;
      reason = '仅引用门店已登记的地址，不承诺路线、营业状态或到店服务。';
    }
  }

  if (!reply.trim() || reply.length > options.maxReplyChars || !reply.isWellFormed() || reply.includes('\0')) return null;
  return { action, reply, reason, productIds: [] };
}
