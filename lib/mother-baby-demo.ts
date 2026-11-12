import type { AppState, BabyProfile, Customer, Product, Task } from './types';
import { createCompetitionDemo } from './competition-demo.ts';

export const MOTHER_BABY_STORE = '芽芽母婴生活馆';
export const MOTHER_BABY_INDUSTRY = '母婴用品与喂养咨询';
export const MOTHER_BABY_WELCOME = '你好，欢迎来到芽芽母婴生活馆！这里提供婴幼儿配方奶粉分段、辅食、纸尿裤、DHA营养品与婴儿洗护，也有儿保与喂养咨询服务。营业时间为每天09:00–21:00，月龄、段位与转奶安排请按包装说明与儿科医生建议核对，欢迎直接留言咨询。';
const SERVICE_CONTENT = '婴幼儿配方奶粉分段、辅食、纸尿裤、DHA营养品与婴儿洗护；提供儿保与喂养咨询。';

type DemoItem = { name: string; detail: string };
/** 顺序与比赛演示目录的 22 项一一对应：前 16 项为商品，后 6 项为服务。 */
const ITEMS: DemoItem[] = [
  { name: '1段婴儿配方奶粉', detail: '0–6月龄适用，密封罐装，冲调比例与喂哺量按包装说明核对。' },
  { name: '2段婴儿配方奶粉', detail: '6–12月龄适用，密封罐装，换段时间需结合宝宝适应情况核对。' },
  { name: '3段幼儿配方奶粉', detail: '12月龄以上适用，密封罐装，日常饮奶量按包装说明核对。' },
  { name: '有机米粉辅食', detail: '辅食初期常见品类，配料与冲调方式以当批包装标签为准。' },
  { name: '婴幼儿果泥辅食', detail: '独立小袋装，适用月龄与食用方式按包装标示核对。' },
  { name: '婴幼儿磨牙饼干', detail: '出牙期常见零食，配料与过敏原以当批包装标签为准。' },
  { name: '婴儿纸尿裤S码', detail: '小尺码纸尿裤，适用体重与更换频率请按包装说明核对。' },
  { name: '婴儿纸尿裤M码', detail: '中尺码纸尿裤，尺码选择请结合宝宝体重核对。' },
  { name: '婴儿拉拉裤L码', detail: '大尺码拉拉裤，适用体重与穿脱方式按包装说明核对。' },
  { name: 'DHA藻油营养品', detail: '母婴店登记的营养品资料，是否适用与食用量请咨询儿科医生。' },
  { name: '婴幼儿营养补充品', detail: '普通营养品资料，配料与适用月龄以包装标签为准，不承诺保健功效。' },
  { name: '婴儿沐浴露', detail: '婴儿洗护用品，成分与使用方式以当批包装说明为准。' },
  { name: '婴儿润肤霜', detail: '婴儿洗护用品，敏感肌肤使用前请先核对成分并咨询医生。' },
  { name: '婴儿隔尿垫', detail: '可重复使用护理用品，尺寸与清洗方式按包装说明核对。' },
  { name: '婴儿棉柔巾', detail: '干湿两用护理用品，材质与用途以包装标示为准。' },
  { name: '新生儿用品礼盒', detail: '组合装礼品，实际内容与数量请店员按当批清单核对。' },
  { name: '儿保与喂养咨询', detail: '门店提供的喂养与儿保时间咨询服务，不提供医疗诊断。' },
  { name: '奶粉分段与转奶咨询', detail: '按包装说明与月龄核对段位，换段节奏请咨询儿科医生。' },
  { name: '新生儿礼品包装', detail: '基础包装服务，具体包装内容与费用需店员确认。' },
  { name: '辅食添加咨询', detail: '介绍常见辅食添加顺序，具体安排请咨询儿科医生。' },
  { name: '婴儿洗护体验课', detail: '门店内基础洗护演示，时间与人数需店员确认。' },
  { name: '亲子喂养沙龙', detail: '门店内交流活动，日期、名额与费用需店员确认。' },
];

const BABY_MONTHS = [1, 3, 5, 6, 6, 7, 8, 9, 11, 12, 13, 15, 18, 20, 24, 2, 4, 6, 6, 6, 10, 14, 16, 17, 19, 21, 22, 23, 2, 6];
const FEEDINGS: Array<BabyProfile['feeding']> = ['breast', 'mixed', 'formula', ''];
const stageFor = (months: number): BabyProfile['formulaStage'] => months < 6 ? '1段' : months < 12 ? '2段' : '3段';

const describe = (item: DemoItem, price: number | null, isService: boolean) =>
  `${item.name}，登记标价${price ?? '面议'}元，属于${isService ? '门店服务' : '母婴商品'}资料。${item.detail}涉及月龄、段位、转奶、辅食或喂哺量时，一律按包装说明与儿科医生建议核对；不承诺医疗、保健或发育效果，不提供诊断与用药建议。当前批次、库存及${isService ? '可预约时段' : '配送安排'}请店员核对，咨询不自动成立订单。`;

const faqFor = (item: DemoItem, price: number | null, isService: boolean) => [
  { question: `${item.name}的标价和适用情况？`, answer: `登记标价${price ?? '面议'}元。${item.detail}具体适用月龄与段位请按包装说明与儿科医生建议核对。` },
  { question: isService ? '怎么预约、需要提前多久？' : '怎么核对配料、段位与保质期？', answer: isService ? '请提前说明日期与人数，空位、费用与改期规则由店员确认，留言不代表预约成功。' : '以当批包装标签为准；涉及过敏、月龄、段位与转奶的问题请按包装说明与儿科医生建议核对。' },
  { question: isService ? '能调整内容吗？' : '能留货或配送吗？', answer: '具体安排需要店员确认，咨询不自动成立订单，也不作功效或效果承诺。' },
];

const replaceNames = (text: string, names: Map<string, string>): string => {
  let value = text;
  for (const [before, after] of names) value = value.split(before).join(after);
  return value;
};

/** 在比赛演示骨架上替换成母婴行业资料，并给每位演示客户登记宝宝档案。 */
export function createMotherBabyDemo(previous: AppState, now = new Date()): AppState {
  const base = createCompetitionDemo(previous, now);
  const demoProducts = (base.products ?? []).filter(product => product.source === 'demo');
  const names = new Map<string, string>();
  const products: Product[] = (base.products ?? []).map(product => {
    const index = demoProducts.indexOf(product);
    if (index < 0 || index >= ITEMS.length) return product;
    const item = ITEMS[index];
    const isService = product.type === 'service';
    names.set(product.name, item.name);
    return { ...product, name: item.name, description: describe(item, product.price, isService), faq: faqFor(item, product.price, isService) };
  });

  const demoCustomers = base.customers.filter(customer => customer.source === 'demo');
  const customerIndex = new Map(demoCustomers.map((customer, index) => [customer.id, index]));
  const customers: Customer[] = base.customers.map(customer => {
    const index = customerIndex.get(customer.id);
    if (index === undefined) return customer;
    const months = BABY_MONTHS[index % BABY_MONTHS.length];
    const item = ITEMS[index % ITEMS.length];
    const baby: BabyProfile = {
      name: '宝宝', ageMonths: months, birthDate: '', feeding: FEEDINGS[index % FEEDINGS.length],
      formulaStage: stageFor(months),
      allergies: index === 2 ? '家长提及乳蛋白敏感，具体请按包装说明与儿科医生建议核对' : '',
      notes: index === 5 ? '家长转述儿保时建议核对喂哺量，详情按包装说明与儿科医生建议核对' : '',
    };
    const messageText = (message: Customer['messages'][number]) => message.sender === 'customer'
      ? `想了解一下${item.name}，宝宝${months}个月，适合吗？`
      : `演示资料：${item.name}标价${demoProducts[index % demoProducts.length]?.price ?? ''}元，月龄、段位与转奶请按包装说明与儿科医生建议核对。`;
    return {
      ...customer, baby,
      tags: ['演示客户', `${months}个月宝宝`],
      manualTags: index % 4 === 0 ? ['需核对段位'] : [],
      summary: `虚拟演示客户，宝宝约${months}个月，曾咨询${item.name}，用于展示宝宝档案与经营数据。`,
      preferences: `关注${item.name}；所有画像均为虚拟样例。`,
      budget: replaceNames(customer.budget, names),
      note: '母婴演示数据，不对应真实微信联系人，不参与自动发送。',
      messages: customer.messages.map(message => ({ ...message, text: messageText(message) })),
      evidence: customer.evidence.map(evidence => ({ ...evidence, text: replaceNames(evidence.text, names) })),
    };
  });

  const tasks: Task[] = base.tasks.map(task => {
    if (!customerIndex.has(task.customerId)) return task;
    const index = customerIndex.get(task.customerId)!;
    const months = BABY_MONTHS[index % BABY_MONTHS.length];
    return {
      ...task,
      title: ['核对宝宝月龄与奶粉段位', '确认纸尿裤尺码', '提醒儿保咨询时间'][index % 3],
      script: `您好，想了解一下宝宝（约${months}个月）最近的吃睡情况，医生有没有新的补充建议？这次不做产品推荐；月龄、段位与辅食安排请按包装说明与儿科医生建议核对。`,
    };
  });

  const replySettings = base.replySettings
    ? { ...base.replySettings, welcomeMessage: MOTHER_BABY_WELCOME, storeInfo: { contactName: '林芽', phone: '', address: '禾安市春芽路18号', serviceContent: SERVICE_CONTENT }, prompt: '只根据母婴店已保存的资料回复；涉及月龄、段位、转奶、辅食与身体状况的问题，按包装说明与儿科医生建议核对，不提供医疗判断。' }
    : base.replySettings;

  return {
    ...base, customers, products, tasks, replySettings,
    orders: base.orders.map(order => ({ ...order, description: replaceNames(order.description, names) })),
    settings: { ...base.settings, storeName: MOTHER_BABY_STORE, industry: MOTHER_BABY_INDUSTRY },
  };
}
