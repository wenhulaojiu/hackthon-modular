import type { AppState, Customer, Order, Product, ReplySettings, Task } from './types.ts';

const PREFIX = 'competition-';
export const DEMO_WELCOME = '你好，欢迎来到青禾生活馆！这里提供现磨咖啡、每日烘焙、鲜花与生活礼品，也有咖啡体验、花艺体验和礼品包装服务。营业时间为每天09:00–21:00，欢迎直接留言咨询商品或服务。';
const LEGACY_DEMO_WELCOME = '你好，欢迎来到青禾生活馆！这是比赛演示店铺，提供现磨咖啡、每日烘焙、鲜花与生活礼品，也有咖啡体验、花艺体验和礼品包装服务。演示营业时间为每天09:00–21:00，欢迎直接留言咨询商品或服务。';
const STORE_SERVICE_CONTENT = '现磨咖啡、每日烘焙、鲜花与生活礼品；提供咖啡体验、花艺体验和礼品包装。';
const CATALOG_STOCK = [80, 60, 45, 38, 30, 28, 18, 24, 40, 2, 22, 0, 16, 35, 3, 12];
const CATALOG_NAMES = ['美式咖啡', '燕麦拿铁', '桂花拿铁', '柠檬冷萃', '原味可颂', '海盐贝果', '巴斯克蛋糕', '燕麦曲奇', '季节水果茶', '花草茶包', '手冲咖啡豆', '挂耳咖啡礼盒', '手作香氛蜡烛', '帆布手提袋', '鲜花小束', '生活礼品套装'];

// 仅整理已知虚拟资料；保留来源标记、人工修改及所有历史消息。
export function migrateCompetitionCatalog(previous: AppState): AppState {
  const products = previous.products?.map(product => {
    if (product.source !== 'demo') return product;
    const description = product.description.replace(/^【比赛演示资料】\s*/, '');
    const index = CATALOG_NAMES.indexOf(product.name);
    const stock = product.type === 'product' && index >= 0 && product.stock === undefined ? CATALOG_STOCK[index] : product.stock;
    const restockThreshold = product.type === 'product' && index >= 0 && product.restockThreshold === undefined ? 5 : product.restockThreshold;
    if (description === product.description && stock === product.stock && restockThreshold === product.restockThreshold) return product;
    return { ...product, description, ...(stock !== undefined ? { stock } : {}), ...(restockThreshold !== undefined ? { restockThreshold } : {}) };
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
  const catalog: Array<[string, number, Product['type'], string]> = [
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
  const products: Product[] = catalog.map(([name, price, type, description], index) => ({ id: takeId(`${PREFIX}product-${index+1}`,productIds), source: 'demo', name, price, type, description, enabled: true, needsRestock: type === 'product' && [9, 11, 14].includes(index), ...(type === 'product' ? { stock: CATALOG_STOCK[index], restockThreshold: 5 } : {}), faq: type === 'service' ? [{ question: '如何预约？', answer: '请至少提前一天通过微信留言预约，具体时段以人工确认为准。' }] : [{ question: '现在有货吗？', answer: '当日余量请通过微信咨询；标记待补货的商品需人工确认。' }] }));
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
