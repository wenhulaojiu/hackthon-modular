import type { AppState, Customer, Order, Product, ReplySettings, Task } from './types.ts';

const PREFIX = 'competition-';
export const DEMO_WELCOME = '你好，欢迎来到青禾生活馆！这里提供现磨咖啡、每日烘焙、鲜花与生活礼品，也有咖啡体验、花艺体验和礼品包装服务。营业时间为每天09:00–21:00，欢迎直接留言咨询商品或服务。';
const LEGACY_DEMO_WELCOME = '你好，欢迎来到青禾生活馆！这是比赛演示店铺，提供现磨咖啡、每日烘焙、鲜花与生活礼品，也有咖啡体验、花艺体验和礼品包装服务。演示营业时间为每天09:00–21:00，欢迎直接留言咨询商品或服务。';
const STORE_SERVICE_CONTENT = '现磨咖啡、每日烘焙、鲜花与生活礼品；提供咖啡体验、花艺体验和礼品包装。';
const CATALOG_STOCK = [80, 60, 45, 38, 30, 28, 18, 24, 40, 2, 22, 0, 16, 35, 3, 12];
const CATALOG_NAMES = ['美式咖啡', '燕麦拿铁', '桂花拿铁', '柠檬冷萃', '原味可颂', '海盐贝果', '巴斯克蛋糕', '燕麦曲奇', '季节水果茶', '花草茶包', '手冲咖啡豆', '挂耳咖啡礼盒', '手作香氛蜡烛', '帆布手提袋', '鲜花小束', '生活礼品套装'];

type CatalogDetails = Pick<Product, 'description' | 'faq'>;
// 本组为比赛店铺的虚拟经营资料；人工商品只由用户明确选定后采用。
export const DEMO_BREAD_DETAILS: CatalogDetails = {
  description: '原味奶香软面包，10元/个，每个约80g；轻甜奶香与麦香、口感松软，无夹心。主要原料为小麦面粉、牛奶、鸡蛋、黄油及酵母，含小麦（麸质）、奶和蛋。独立食品袋包装；未开封常温密封保质期2天，避免高温和日晒；开封后建议当天食用。生产日期、当前批次标签及当日余量由店员核对，不自动承诺留货。',
  faq: [
    { question: '面包什么口味、多少钱？', answer: '这款是原味奶香软面包，轻甜奶香与麦香、无夹心，约80g/个，10元/个。' },
    { question: '面包有哪些原料和过敏原？', answer: '主要原料为小麦面粉、牛奶、鸡蛋、黄油及酵母，含小麦（麸质）、奶和蛋；其他交叉接触信息请向店员核对。' },
    { question: '面包怎么保存、能放多久？', answer: '未开封常温密封保质期2天，避免高温和日晒；开封后建议当天食用。生产日期和当前批次包装标示请店员核对。' },
    { question: '可以帮我留一个或配送吗？', answer: '留货、配送、到店时间及订单需由店员确认，咨询不会自动成立订单。' },
  ],
};

const CATALOG_DETAILS: Record<string, CatalogDetails> = {
  '美式咖啡': {
    description: '18元/杯，标准杯约300ml，浓缩咖啡加水制作，咖啡风味清爽并带烘焙香；含咖啡因。可选热饮或冰饮，原配方不加奶、不另加糖；加糖或其他配料需提前沟通。使用外带杯，可到店自取；现制现饮，不作跨日储存，建议当天饮用；当前库存和配送安排需店员确认。',
    faq: [{ question: '美式多少钱、有什么口味？', answer: '美式咖啡18元/杯，约300ml，是浓缩咖啡加水，原配方不加奶、不另加糖，有咖啡烘焙香。' }, { question: '可以选冷热或加奶吗？', answer: '可以选热饮或冰饮；加奶、加糖等改配方及是否另计费用需在下单前确认，不按标准价自动承诺。' }, { question: '有过敏原或咖啡因吗？', answer: '美式含咖啡因，原配方不加奶；制作环境和器具的交叉接触信息需要店员核对。' }],
  },
  '燕麦拿铁': {
    description: '28元/杯，约350ml，浓缩咖啡搭配燕麦饮品，风味偏麦香、口感顺滑；含咖啡因。可选热饮或冰饮，标准配方不额外加糖，但燕麦饮品本身成分以当批标签为准。与奶饮共用制作环境，不能承诺无奶或无麸质；外带杯包装，现制后建议当天及时饮用；定制配方和当日供应需确认。',
    faq: [{ question: '燕麦拿铁的价格、规格和味道？', answer: '28元/杯，约350ml，浓缩咖啡加燕麦饮品，偏麦香、口感顺滑，可选热饮或冰饮。' }, { question: '是无糖、无奶或无麸质的吗？', answer: '标准配方不额外加糖，但不能承诺无糖、无奶或无麸质；燕麦饮品标签与制作器具的交叉接触情况需店员核对。' }, { question: '可以替换原料吗？', answer: '替换燕麦饮品或其他配料需提前确认可用原料和最终价格。' }],
  },
  '桂花拿铁': {
    description: '30元/杯，约350ml，浓缩咖啡、牛奶与桂花风味糖浆调制，带桂花香和奶香；含奶及咖啡因。可选热饮或冰饮，糖浆含糖，少糖需求请下单前沟通，不能保证完全去糖。外带杯包装；现制后建议当天及时饮用，奶品、糖浆当批配料及交叉接触信息可请店员核对。',
    faq: [{ question: '桂花拿铁多少钱、是什么味道？', answer: '30元/杯，约350ml，牛奶与咖啡搭配桂花风味糖浆，带桂花香和奶香。' }, { question: '可以选冷热、少糖吗？', answer: '可选热饮或冰饮，少糖可以下单前沟通；桂花糖浆含糖，不能保证完全去糖。' }, { question: '含奶和咖啡因吗？', answer: '含牛奶和咖啡因；更换奶品以及其他过敏原情况需店员确认。' }],
  },
  '柠檬冷萃': {
    description: '26元/杯，约350ml，仅提供冰饮，冷萃咖啡搭配柠檬片与柠檬风味调味，口味酸甜并有咖啡香；含咖啡因。原配方不加奶，冰量和甜度调整可提前沟通。使用外带冷饮杯，现制后建议当天及时饮用；柑橘成分和当批配料信息需按实际标签核对。',
    faq: [{ question: '柠檬冷萃的价格和味道？', answer: '26元/杯，约350ml，是柠檬风味的酸甜冷萃咖啡，含咖啡因。' }, { question: '能做热的或调整甜度吗？', answer: '这款仅提供冰饮，冰量和甜度调整可在下单前沟通，具体可调整范围需确认。' }, { question: '有奶或柑橘成分吗？', answer: '原配方不加奶，含柠檬等柑橘成分；其他配料和交叉接触情况请店员核对。' }],
  },
  '原味可颂': {
    description: '12元/个，每个约70g，原味黄油可颂，无夹心，外层酥松、内部柔软，带黄油香。主要原料为小麦面粉、黄油、牛奶、鸡蛋及酵母，含小麦（麸质）、奶和蛋。独立食品袋包装；未开封常温密封保质期2天，避高温日晒，开封后建议当天食用；复热方式和当前批次日期请按包装说明或由店员确认。',
    faq: [{ question: '可颂什么口味、多少钱？', answer: '原味黄油可颂12元/个，约70g，无夹心，外层酥松、带黄油香。' }, { question: '有奶、蛋或小麦吗？', answer: '含小麦（麸质）、奶和蛋；制作环境的其他交叉接触信息请店员确认。' }, { question: '如何包装和保存？', answer: '独立食品袋包装，未开封常温密封保质期2天，避高温日晒，开封后建议当天食用；复热方法和生产日期请核对当前包装。' }],
  },
  '海盐贝果': {
    description: '15元/个，每个约90g，原味海盐贝果，无夹心，轻咸麦香、口感有嚼劲。主要原料为小麦面粉、水、酵母与海盐，含小麦（麸质）；同区域制作其他含奶、蛋和坚果的食品。独立袋装；夹馅、切片或复热需求请下单前确认，未开封常温密封保质期2天，避高温日晒，开封后建议当天食用；生产日期和当批标签需核对。',
    faq: [{ question: '贝果是什么口味和规格？', answer: '海盐原味、无夹心，轻咸麦香且有嚼劲，约90g/个，15元/个。' }, { question: '含什么过敏原？', answer: '配方含小麦（麸质），同区域还制作含奶、蛋和坚果的食品，具体交叉接触信息需核对。' }, { question: '可以加夹馅吗？', answer: '夹馅、切片、复热及可能产生的额外费用需下单前确认，标准价格对应无夹心贝果。' }],
  },
  '巴斯克蛋糕': {
    description: '28元/份，每份约90g，为原味巴斯克芝士蛋糕切块，奶香浓郁、表面有烘焙焦香。主要原料为奶油奶酪、淡奶油、鸡蛋、糖和少量小麦面粉，含奶、蛋与小麦（麸质）。单份食品盒包装；按0–4℃冷藏保存、保质期2天，开盒后建议当天食用；生产日期、当前批次标签和运输安排由店员核对，不提供整蛋糕定制的自动承诺。',
    faq: [{ question: '蛋糕多少钱、是什么味道？', answer: '原味巴斯克芝士蛋糕28元/份，约90g切块，带浓郁奶香和表面烘焙焦香。' }, { question: '含奶、蛋或小麦吗？', answer: '含奶、蛋和小麦（麸质），其他交叉接触信息请店员确认。' }, { question: '如何保存、能订整只吗？', answer: '切块装盒，0–4℃冷藏保质期2天，开盒后建议当天食用；生产日期、运输和整蛋糕定制需店员确认。' }],
  },
  '燕麦曲奇': {
    description: '22元/袋，每袋6片、净含量约150g，原味燕麦黄油曲奇，口味轻甜、口感酥脆。主要原料为燕麦、小麦面粉、黄油、鸡蛋和糖，含燕麦、小麦（麸质）、奶和蛋；同区域可能接触坚果。食品袋密封包装，未开封常温阴凉干燥密封保质期30天，开封后建议7天内食用并及时密封；生产日期与当批标签需核对。',
    faq: [{ question: '曲奇多少钱、一袋多少？', answer: '22元/袋，每袋6片，约150g，是轻甜酥脆的原味燕麦黄油曲奇。' }, { question: '含哪些过敏原？', answer: '含燕麦、小麦（麸质）、奶和蛋，同区域可能接触坚果。' }, { question: '怎么保存？', answer: '未开封常温阴凉干燥密封保质期30天，开封后建议7天内食用并及时密封；当前批次日期请店员核对。' }],
  },
  '季节水果茶': {
    description: '24元/杯，约500ml，标准为冰饮红茶水果茶，基础组合为苹果、橙子与柠檬，风味清甜微酸；含茶叶咖啡因和柑橘成分。水果可能随季节替换，具体组合须下单前确认；甜度和冰量可沟通。外带冷饮杯包装，现制后建议当天及时饮用，不作跨日储存，不承诺固定季节花果或无咖啡因。',
    faq: [{ question: '水果茶多少钱、有哪些水果？', answer: '24元/杯，约500ml，基础搭配苹果、橙子、柠檬和红茶；季节替换请下单前确认。' }, { question: '可以少糖、少冰或热饮吗？', answer: '标准提供冰饮，少糖、冰量或其他调整需下单前沟通，是否能做热饮需确认。' }, { question: '含咖啡因或柑橘吗？', answer: '基础配方含红茶咖啡因及橙子、柠檬等柑橘成分，不按无咖啡因饮品承诺。' }],
  },
  '花草茶包': {
    description: '39元/盒，每盒10袋、每袋约2g，玫瑰、洋甘菊与薄荷搭配的花草冲泡饮品，花香清淡并带薄荷风味。独立袋装，可按包装说明用热水冲泡；作为普通饮品销售。具体原料及交叉接触信息以当批配料标签为准，未开封常温阴凉干燥密封保质期12个月，避光防潮；单袋开封后尽快冲泡，生产日期与当批标签需核对；待补货时可售数量需店员核对。',
    faq: [{ question: '茶包什么口味、一盒多少？', answer: '39元/盒，10袋装、每袋约2g，玫瑰、洋甘菊与薄荷风味的普通花草饮品。' }, { question: '怎么泡和保存？', answer: '每袋独立包装，按包装方法热水冲泡；未开封阴凉干燥密封保质期12个月、避光防潮，单袋开封后尽快冲泡，生产日期请核对标签。' }, { question: '是否有具体健康功效？', answer: '这是普通饮品，当前资料不提供治疗、保健或其他健康功效承诺；特殊饮食需求请先核对配料。' }],
  },
  '手冲咖啡豆': {
    description: '68元/袋，净含量200g，中度烘焙纯咖啡豆，风味描述偏坚果香与巧克力香；这些是品饮风味，不表示添加坚果或巧克力。含咖啡因，标准交付整豆，可提前沟通是否研磨及所用器具。密封袋包装，未开封常温阴凉干燥密封保质期6个月，避光防潮；开封后建议30天内使用并及时密封，烘焙日期与当批标签需核对。',
    faq: [{ question: '咖啡豆价格、规格和风味？', answer: '68元/袋，200g，中度烘焙，偏坚果与巧克力的品饮风味。' }, { question: '是添加坚果或巧克力的吗？', answer: '标准为纯咖啡豆，坚果香、巧克力香是风味描述，不表示添加这些原料；交叉接触情况需核对。' }, { question: '可以磨粉吗？', answer: '标准交付整豆，需磨粉请提前说明冲煮器具，由店员确认研磨安排及当批烘焙信息。' }],
  },
  '挂耳咖啡礼盒': {
    description: '89元/盒，10袋装，每袋咖啡粉净含量10g，采用中度烘焙咖啡制作，风味偏烘焙坚果香，含咖啡因。单袋独立密封、附挂耳滤袋，用热水按包装说明冲泡；外层为纸质礼盒，不含杯具。未开封常温阴凉干燥密封保质期12个月，避光防潮；单袋开封后一次冲泡使用，生产日期按当批标签核对；库存为0或待补货时不能直接承诺有货。',
    faq: [{ question: '礼盒多少钱、有几袋？', answer: '89元/盒，10袋装，每袋10g咖啡粉，独立挂耳滤袋，附纸质礼盒，不含杯具。' }, { question: '是什么风味、怎么泡？', answer: '中度烘焙、偏烘焙坚果风味，含咖啡因；热水冲泡步骤请按包装说明操作。' }, { question: '待补货还能买或预订吗？', answer: '待补货或库存为0时，具体补货日期、预订和到货安排须由店员确认，咨询不自动锁货。' }],
  },
  '手作香氛蜡烛': {
    description: '79元/只，蜡体净含量120g，白茶风味香氛，大豆混合蜡搭配香料与棉芯，玻璃容器包装。放在平稳耐热表面使用，远离易燃物、儿童和宠物；燃烧时需有人照看，通风情况、单次燃烧和熄灭方式按包装说明。香味感受因人而异，不能保证适合对香料敏感的人群。',
    faq: [{ question: '蜡烛多少钱、什么香味？', answer: '79元/只，蜡体120g，白茶风味香氛，玻璃容器装，大豆混合蜡搭配香料和棉芯。' }, { question: '怎么使用？', answer: '置于平稳耐热表面，远离易燃物、儿童及宠物，燃烧时需有人照看，具体燃烧与熄灭方法按包装说明。' }, { question: '对香料敏感可以用吗？', answer: '不能保证适合香料敏感者；请先核对当批成分和使用说明，再决定是否选购。' }],
  },
  '帆布手提袋': {
    description: '49元/只，原色棉帆布，袋身约35×40cm，不含提手长度；单层开放式袋口，配内侧小袋，适合日常轻便随身物品。单只装、不含展示道具。建议按洗护标签冷水轻柔清洗并通风晾干；印字、其他颜色、加急和大批量定制需另行确认。',
    faq: [{ question: '手提袋多少钱、尺寸和材质？', answer: '49元/只，原色棉帆布，袋身约35×40cm，不含提手长度，开放式袋口、带内侧小袋。' }, { question: '可以定制印字或换颜色吗？', answer: '标准款为原色无定制印字；印字、其他颜色及批量定制的可行性、费用和交付时间需店员确认。' }, { question: '怎么清洗？', answer: '请按洗护标签冷水轻柔清洗并通风晾干，具体洗护条件以当前商品标签为准。' }],
  },
  '鲜花小束': {
    description: '99元/束，示例为5枝主花搭配叶材的小花束，约25cm宽，附基础包装纸和丝带，不含花瓶。主花可随季节在玫瑰、康乃馨等可用花材中搭配；颜色、花材及实际大小下单前确认。收到后按店员提供的养护说明剪枝换水，开花状态和可观赏时间受环境影响，不作固定天数承诺。',
    faq: [{ question: '小花束多少钱、包括什么？', answer: '99元/束，示例含5枝主花及叶材，约25cm宽，附基础包装纸和丝带，不含花瓶。' }, { question: '可以指定颜色和花材吗？', answer: '可以先说明用途和色系，具体花材随季节供应，指定品种、改配费用和取花时间需店员确认。' }, { question: '怎么养护、能放多久？', answer: '请按店员提供的剪枝、换水与摆放说明养护；开花状态和观赏时间受花材及环境影响，不承诺固定天数。' }],
  },
  '生活礼品套装': {
    description: '159元/套，包含10袋装挂耳咖啡礼盒1盒（每袋10g）及原色帆布手提袋1只（袋身约35×40cm），附基础礼品包装，不含杯具。咖啡为中度烘焙、含咖啡因；挂耳咖啡未开封阴凉干燥密封保质期12个月、避光防潮，单袋开封后一次冲泡使用；帆布袋按洗护标签清洗。改换商品、贺卡定制、批量购买及配送安排需要提前确认。',
    faq: [{ question: '套装多少钱、里面有什么？', answer: '159元/套，含10袋挂耳咖啡礼盒（每袋10g）、原色帆布手提袋1只及基础礼品包装，不含杯具。' }, { question: '可以换商品或加贺卡吗？', answer: '替换商品、贺卡定制或批量购买需提前说明需求，由店员确认最终组合、费用和交付时间。' }, { question: '咖啡和袋子怎样保存使用？', answer: '挂耳咖啡未开封阴凉干燥密封保质期12个月、避光防潮，单袋开封后一次冲泡使用；帆布袋按洗护标签清洗，生产日期与特殊饮食需求请先核对。' }],
  },
  '咖啡手冲体验': {
    description: '128元/人，单人约60分钟，门店内进行基础手冲教学，包含器具现场使用、体验咖啡豆及一杯约150ml体验手冲咖啡，不赠送器具。内容包括研磨、注水和风味交流；饮品含咖啡因。至少提前一天通过微信提出预约，日期、人数、空位及改期取消规则需店员确认，留言不代表预约成功。',
    faq: [{ question: '手冲体验多少钱、包含什么？', answer: '128元/人，约60分钟，包含门店基础教学、器具现场使用、体验咖啡豆及一杯约150ml手冲咖啡，不赠送器具。' }, { question: '怎么预约、能直接到店吗？', answer: '请至少提前一天留言说明日期、人数与时段，空位及最终预约由店员确认，留言不会自动预留。' }, { question: '适合零基础吗、能改期吗？', answer: '课程为基础手冲体验，可以零基础咨询；具体参与要求、改期及取消规则需要店员确认。' }],
  },
  '花艺体验': {
    description: '168元/人，单人约90分钟，门店内基础花束搭配体验，包含基础花材、包装材料及工具现场使用，可带走本人完成的一份小花束，工具不外带。花材和颜色按当日可用资料确认，特殊花材可能另行报价。至少提前一天微信预约，人数、时段、是否成行及改期取消规则由店员确认。',
    faq: [{ question: '花艺体验价格、时长和包含内容？', answer: '168元/人，约90分钟，含基础花材、包装材料和工具现场使用，可带走本人完成的一份小花束，工具不外带。' }, { question: '可以选花材或颜色吗？', answer: '可以先说明色系，花材和颜色按当日供应确认，指定特殊花材及额外费用需店员确认。' }, { question: '如何预约、几个人能参加？', answer: '请至少提前一天微信说明人数、日期和时段，可接待人数、空位及改期取消规则需店员确认。' }],
  },
  '礼品包装': {
    description: '15元/份，基础款包装服务，适用于一件外形规整、外尺寸不超过约20×20×10cm的礼品，含基础包装纸、丝带和手提纸袋，不含礼品本身。由客户先说明或提供礼品尺寸；异形、易碎、超尺寸、多件组合和定制贺卡需另行确认可行性与费用。服务时间及取件安排须店员确认。',
    faq: [{ question: '包装15元包含什么？', answer: '基础款15元/份，含包装纸、丝带和手提纸袋，不含礼品；适用单件规整礼品，外尺寸约20×20×10cm以内。' }, { question: '大件、易碎或多件礼品能包吗？', answer: '请先提供尺寸和物品情况，超尺寸、异形、易碎或多件组合需店员确认可行性、方案和费用。' }, { question: '多久能取、可以加贺卡吗？', answer: '取件时间及贺卡定制需要店员核对当前安排与费用，咨询不自动确认完成时间。' }],
  },
  '鲜花定制': {
    description: '基础方案199元起/束，示例为9枝主花搭配叶材、约30cm宽的花束，附基础包装，不含花瓶。可先说明赠送场景、预算、色系和取花时间，主花及配花随季节供应；指定花材、尺寸升级、贺卡或配送可能影响总价。请至少提前一天咨询，最终花材、价格及交付时间由店员确认。',
    faq: [{ question: '定制花束多少钱、基础方案是什么？', answer: '199元起/束，基础示例为9枝主花搭配叶材、约30cm宽、附基础包装，不含花瓶；最终方案需人工确认。' }, { question: '可以指定预算、花材和配送吗？', answer: '请先提供场景、预算、色系及取花时间；指定花材、升级尺寸、贺卡和配送由店员确认可行性及最终报价。' }, { question: '需要提前多久预约？', answer: '请至少提前一天咨询，是否能按所需时间提供、临时加急与改期取消规则均需店员确认。' }],
  },
  '小型茶歇布置': {
    description: '基础方案599元/场，按10人份设计，含10杯约300ml美式咖啡、10份单人份点心，以及门店内一张茶歇桌的基础摆台。饮品含咖啡因，点心可能含小麦、奶和蛋，当场菜单及过敏原需确认。不含场外配送、额外桌椅及专属装饰；请提前沟通人数、日期和地点，最终方案及费用由店员确认。',
    faq: [{ question: '茶歇599元包含多少人份？', answer: '基础为10人份，含10杯约300ml美式、10份单人份点心及门店一张茶歇桌的基础摆台；最终菜单需确认。' }, { question: '可以外送或增加人数吗？', answer: '基础价不含场外配送、额外桌椅和专属装饰；增加人数、外场服务或调整菜单需要店员重新确认方案及报价。' }, { question: '如何预约、有哪些过敏原？', answer: '请提前提供日期、人数、地点和饮食需求；饮品含咖啡因，点心可能含小麦、奶和蛋，具体菜单及交叉接触情况需店员核对。' }],
  },
  '门店空间体验': {
    description: '88元/组，双人两小时的门店公共区域座位体验，包含两杯约300ml美式咖啡，可选热饮或冰饮；饮品含咖啡因，不含额外餐点。不是独立包场，活动、拍摄或商业使用需另行沟通。请提前说明日期、人数和时段，空位、超时及改期取消规则由店员确认，留言不会自动订位。',
    faq: [{ question: '空间体验多少钱、含哪些内容？', answer: '88元/组，双人两小时，使用门店公共区域座位，含两杯约300ml美式，可选冷热，不含额外餐点。' }, { question: '是包场吗、可以拍摄吗？', answer: '基础方案不是独立包场；活动、拍摄或商业使用的可行性与费用需另行确认。' }, { question: '如何订位、超时怎么收费？', answer: '请提前说明日期、人数及时段，空位、超时费用及改期取消规则由店员确认，当前咨询不自动订位。' }],
  },
};

const LEGACY_PRODUCT_FAQ = [{ question: '现在有货吗？', answer: '当日余量请通过微信咨询；标记待补货的商品需人工确认。' }];
const LEGACY_SERVICE_FAQ = [{ question: '如何预约？', answer: '请至少提前一天通过微信留言预约，具体时段以人工确认为准。' }];

const LEGACY_CATALOG: Array<[string, number, Product['type'], string]> = [
  ['美式咖啡',18,'product','现磨咖啡，可选热饮或冰饮。'],['燕麦拿铁',28,'product','以燕麦饮品调制，可选热饮或冰饮。'],
  ['桂花拿铁',30,'product','咖啡搭配桂花风味，甜度可在下单前沟通。'],['柠檬冷萃',26,'product','冷萃咖啡搭配柠檬风味，提供冰饮。'],
  ['原味可颂',12,'product','每日烘焙，含小麦、奶及蛋；过敏信息请先咨询。'],['海盐贝果',15,'product','每日烘焙，含小麦；口味与当日余量请在下单前确认。'],
  ['巴斯克蛋糕',28,'product','单份切块，含奶、蛋及小麦。'],['燕麦曲奇',22,'product','一袋六片，含燕麦、小麦及奶。'],
  ['季节水果茶',24,'product','使用当季水果调制，具体水果请咨询。'],['花草茶包',39,'product','一盒十袋，作为普通饮品销售。'],
  ['手冲咖啡豆',68,'product','每袋200克，可在下单前沟通研磨需求。'],['挂耳咖啡礼盒',89,'product','每盒十袋，适合日常饮用或作为礼品。'],
  ['手作香氛蜡烛',79,'product','一只120克，使用时请按包装说明操作。'],['帆布手提袋',49,'product','原色帆布，一只装。'],
  ['鲜花小束',99,'product','季节鲜花搭配，花材与颜色需提前沟通。'],['生活礼品套装',159,'product','包含挂耳咖啡与帆布袋，可选择普通礼品包装。'],
  ['咖啡手冲体验',128,'service','单人约60分钟，提供器具及体验用咖啡豆。'],['花艺体验',168,'service','单人约90分钟，包含基础花材及工具使用。'],
  ['礼品包装',15,'service','每份基础礼品包装，不含礼品本身。'],['鲜花定制',199,'service','基础方案199元起；改配花材和最终金额需人工确认。'],
  ['小型茶歇布置',599,'service','基础方案含十人份饮品与点心；额外需求需人工确认。'],['门店空间体验',88,'service','双人两小时，含两杯美式咖啡，需提前确认空位。'],
];

// 仅整理已知虚拟资料；保留来源标记、人工修改及所有历史消息。
export function migrateCompetitionCatalog(previous: AppState): AppState {
  const products = previous.products?.map(product => {
    if (product.source !== 'demo') return product;
    const legacy = LEGACY_CATALOG.find(([name, , type]) => product.name === name && product.type === type);
    const details = legacy ? CATALOG_DETAILS[legacy[0]] : undefined;
    // 只补齐完整匹配旧模板的字段；改过的说明、FAQ、价格及库存分别保留。
    const plainDescription = product.description.replace(/^【比赛演示资料】\s*/, '');
    const knownDescription = details && (plainDescription === legacy![3] || plainDescription === details.description);
    const description = knownDescription ? details.description : product.description;
    const legacyFaq = product.type === 'service' ? LEGACY_SERVICE_FAQ : LEGACY_PRODUCT_FAQ;
    const faq = details && JSON.stringify(product.faq) === JSON.stringify(legacyFaq) ? details.faq.map(item => ({ ...item })) : product.faq;
    const index = CATALOG_NAMES.indexOf(product.name);
    const stock = product.type === 'product' && index >= 0 && product.stock === undefined ? CATALOG_STOCK[index] : product.stock;
    const restockThreshold = product.type === 'product' && index >= 0 && product.restockThreshold === undefined ? 5 : product.restockThreshold;
    if (description === product.description && faq === product.faq && stock === product.stock && restockThreshold === product.restockThreshold) return product;
    return { ...product, description, faq, ...(stock !== undefined ? { stock } : {}), ...(restockThreshold !== undefined ? { restockThreshold } : {}) };
  });
  const settings = previous.replySettings;
  let replySettings = settings;
  if (settings) {
    const info = settings.storeInfo;
    // 店铺字段只替换完整旧模板，不清洗任意商家的自填文本。
    const isKnownStore = previous.settings.storeName === '青禾生活馆' && previous.products?.some(product => product.source === 'demo');
    const storeInfo = info && isKnownStore ? {
      ...info,
      ...(info.phone === '演示电话（未开放）' ? { phone: '' } : {}),
      ...(info.address === '青禾市拾光路18号（虚构地址）' ? { address: '青禾市拾光路18号' } : {}),
      ...(info.serviceContent === `比赛演示店铺：${STORE_SERVICE_CONTENT}` ? { serviceContent: STORE_SERVICE_CONTENT } : {}),
      ...(info.contactName === undefined && (info.phone === '演示电话（未开放）' || info.address === '青禾市拾光路18号（虚构地址）' || info.serviceContent === `比赛演示店铺：${STORE_SERVICE_CONTENT}`) ? { contactName: '林青禾' } : {}),
    } : info;
    const welcomeMessage = isKnownStore && settings.welcomeMessage === LEGACY_DEMO_WELCOME ? DEMO_WELCOME : settings.welcomeMessage;
    if (welcomeMessage !== settings.welcomeMessage || (storeInfo && JSON.stringify(storeInfo) !== JSON.stringify(info))) replySettings = { ...settings, storeInfo, welcomeMessage };
  }
  if (replySettings === settings && (!products || products.every((product, index) => product === previous.products![index]))) return previous;
  return { ...previous, ...(products ? { products } : {}), ...(replySettings ? { replySettings } : {}) };
}

export function createCompetitionDemo(previous: AppState, now = new Date()): AppState {
  const removedDemoIds = new Set(previous.customers.filter(customer => customer.source === 'demo').map(customer => customer.id));
  const retainedCustomers = previous.customers.filter(customer => customer.source !== 'demo');
  const retainedProducts = (previous.products || []).filter(product => product.source !== 'demo');
  const retainedOrders = previous.orders.filter(order => !removedDemoIds.has(order.customerId));
  const retainedTasks = previous.tasks.filter(task => !removedDemoIds.has(task.customerId));
  const customerIds = new Set(retainedCustomers.map(customer => customer.id)), productIds = new Set(retainedProducts.map(product => product.id));
  const orderIds = new Set(retainedOrders.map(order => order.id)), taskIds = new Set(retainedTasks.map(task => task.id));
  // 显式来源标记决定演示归属；名称前缀不能作为删除真实资料的依据。
  const takeId = (base: string, used: Set<string>) => { let id = base, suffix = 1; while (used.has(id)) id = `${base}-demo-${suffix++}`; used.add(id); return id; };
  if (retainedCustomers.length + 30 > 500 || retainedProducts.length + 22 > 200 || retainedOrders.length + 94 > 5000 || retainedTasks.length + 18 > 5000) throw new Error('演示数据会超出当前工作区容量，请先整理已有演示资料。');
  const timestamp = (days: number, hour = 10) => {
    const date = new Date(now);date.setDate(date.getDate() - days);date.setHours(hour, 0, 0, 0);return date.toISOString();
  };
  const products: Product[] = LEGACY_CATALOG.map(([name, price, type], index) => ({ id: takeId(`${PREFIX}product-${index+1}`,productIds), source: 'demo', name, price, type, description: CATALOG_DETAILS[name].description, enabled: true, needsRestock: type === 'product' && [9, 11, 14].includes(index), ...(type === 'product' ? { stock: CATALOG_STOCK[index], restockThreshold: 5 } : {}), faq: CATALOG_DETAILS[name].faq.map(item => ({ ...item })) }));
  const names = ['林悦','陈可','周晴','许安','沈宁','李沐','顾南','苏禾','王嘉','程雨','孟夏','叶青','孙然','赵一','宋溪','韩星','郑初','陆遥','何微','陶白','吴悠','冯乐','邵月','梁简','温栩','蒋宁','唐禾','夏可','方青','白露'];
  const colors = ['#6a8f38','#8a709c','#c38b45','#4a8b92','#6878a8'];
  const customers: Customer[] = names.map((name,index) => {
    const product = products[index%products.length], createdAt = timestamp(index < 4 ? 0 : index%20+1,9), lastContactAt = timestamp(index<4?0:index%8,10);
    return { id: takeId(`${PREFIX}customer-${index+1}`,customerIds), name, wechatId: `demo_customer_${index+1}`, color: colors[index%colors.length], stage: (['新客户','潜在客户','活跃客户','重点维护','待唤醒'] as const)[index%5], tags: ['演示客户', product.type === 'service' ? '体验服务' : '日常选购'], manualTags: index%4===0?['礼品需求']:[], summary: `虚拟演示客户，曾咨询${product.name}，用于展示客户画像与经营数据。`, preferences: `偏好${product.name}；所有画像均为虚拟样例。`, budget: `演示预算${Math.max(30,product.price!)}–${Math.max(100,product.price!+80)}元`, note: '比赛演示数据，不对应真实微信联系人，不参与自动发送。', createdAt, lastContactAt, nextFollowUpAt: timestamp(-(index%6),11), source: 'demo', evidence: [], autoReplyEnabled: false, humanTakeover: false, messages: [{id:`${PREFIX}message-${index}-1`,sender:'customer',text:`想了解一下${product.name}。`,date:lastContactAt},{id:`${PREFIX}message-${index}-2`,sender:'merchant',text:`演示资料：${product.name}标价${product.price}元，${product.description}`,date:lastContactAt}] };
  });
  const orders: Order[] = customers.flatMap((customer,index) => Array.from({length:3},(_,visit) => {
    const product=products[(index+visit)%products.length];
    return {id:takeId(`${PREFIX}order-${index}-${visit}`,orderIds),customerId:customer.id,description:product.name,amount:product.price!,date:timestamp((index%8)+visit*7,12),status:'confirmed' as const,type:'sale' as const,evidence:'虚拟比赛演示交易，不代表真实收款。'};
  }));
  for(let index=0;index<4;index++)orders.push({id:takeId(`${PREFIX}refund-${index}`,orderIds),customerId:customers[index].id,description:'演示退款',amount:products[index].price!,date:timestamp(index,14),status:'confirmed',type:'refund',evidence:'虚拟比赛演示退款，不代表真实交易。'});
  const tasks: Task[] = customers.slice(0,18).map((customer,index) => ({id:takeId(`${PREFIX}task-${index}`,taskIds),customerId:customer.id,title:['了解体验感受','确认礼品偏好','提醒预约安排'][index%3],date:timestamp(2-index%7,11),kind:(['followup','marketing','reminder'] as const)[index%3],status:'todo',priority:index%4===0?'high':'normal',script:`您好，上次您咨询了${products[index%products.length].name}，这次需要我继续为您介绍吗？` }));
  const base: ReplySettings = previous.replySettings || { enabled:false,mode:'review',selectedCustomerIds:[],businessHours:{enabled:false,start:'09:00',end:'21:00',days:[0,1,2,3,4,5,6]},faq:[],handoffKeywords:['退款','投诉','人工客服'],maxReplyChars:300,cooldownSeconds:30,debounceSeconds:10,prompt:'只根据已保存的店铺资料回复，不清楚时转人工。' };
  const next: AppState = {...previous,demo:false,customers:[...retainedCustomers,...customers],orders:[...retainedOrders,...orders],tasks:[...retainedTasks,...tasks],settings:{...previous.settings,storeName:'青禾生活馆',industry:'生活方式零售'},products:[...retainedProducts,...products],replySettings:{...base,debounceSeconds:base.debounceSeconds??10,selectedCustomerIds:base.selectedCustomerIds.filter(id=>retainedCustomers.some(customer=>customer.id===id)),autoEnrollNewContacts:true,welcomeEnabled:true,welcomeMessage:DEMO_WELCOME,businessHours:{enabled:false,start:'09:00',end:'21:00',days:[0,1,2,3,4,5,6]},storeInfo:{contactName:'林青禾',phone:'',address:'青禾市拾光路18号',serviceContent:STORE_SERVICE_CONTENT}}};
  if (next.customers.reduce((sum,customer)=>sum+customer.messages.length,0) > 12000 || new TextEncoder().encode(JSON.stringify(next)).length > 1_450_000) throw new Error('加入演示资料后会超过消息或数据容量，现有资料未修改。');
  return next;
}
