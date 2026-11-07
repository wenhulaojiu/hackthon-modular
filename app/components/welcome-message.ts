export const DEFAULT_WELCOME_MESSAGE = '您好，欢迎添加本店！这里可以咨询商品和服务，欢迎告诉我们您的需求。';
export const MAX_WELCOME_LENGTH = 300;
type WelcomeSettings = { welcomeEnabled?: boolean; welcomeMessage?: string };
type ShopDetails = { storeName?: string; serviceContent?: string; phone?: string; address?: string; businessHours?: { enabled: boolean; start: string; end: string; days: number[] } };

export function welcomeSettingsFor(settings?: WelcomeSettings) {
  return { enabled: settings?.welcomeEnabled ?? true, message: settings?.welcomeMessage ?? DEFAULT_WELCOME_MESSAGE };
}

export function welcomeMessageError(enabled: boolean, message: string): string | null {
  if (message.length > MAX_WELCOME_LENGTH || message.includes('\0')) return '欢迎语最多300个字符，且不能包含空字符。';
  if (enabled && !message.trim()) return '启用首次添加欢迎语时，请填写欢迎语内容；空白不会自动补回默认文字。';
  return null;
}

const clean = (value?: string) => (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
function shorten(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let result = '';
  // 截短时保留完整Unicode字符，并用省略号标明资料未全文展示。
  for (const character of value) { if (result.length + character.length > limit - 1) break; result += character; }
  return limit > 0 ? `${result}…` : '';
}

function hoursText(hours: ShopDetails['businessHours']): string {
  if (!hours?.enabled || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(hours.start) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(hours.end) || hours.start >= hours.end) return '';
  const days = [1, 2, 3, 4, 5, 6, 0].filter(day => hours.days.includes(day));
  return days.length ? `营业时间：${days.map(day => `周${['日', '一', '二', '三', '四', '五', '六'][day]}`).join('、')} ${hours.start}–${hours.end}。` : '';
}

export function buildWelcomeMessage(details: ShopDetails): string {
  const name = clean(details.storeName), service = clean(details.serviceContent), address = clean(details.address), phone = clean(details.phone), hours = hoursText(details.businessHours);
  if (!name && !service && !address && !phone && !hours) return DEFAULT_WELCOME_MESSAGE;
  const opening = `您好，欢迎添加${name ? shorten(name, 60) : '本店'}！`, ending = '欢迎告诉我们您的需求。';
  // 电话必须完整保留；过长且未经校验的联系方式整项省略，不能截成错误号码。
  const fixed = `${phone && phone.length <= 80 ? `联系电话：${phone}。` : ''}${hours}`;
  const fields = [{ label: '服务内容：', value: service }, { label: '地址：', value: address }].filter(field => field.value);
  let remaining = MAX_WELCOME_LENGTH - opening.length - ending.length - fixed.length;
  const introductions = fields.map((field, index) => {
    const available = Math.floor(remaining / (fields.length - index)) - field.label.length - 1;
    if (available < 1) return '';
    const section = `${field.label}${shorten(field.value, available)}。`;
    remaining -= section.length;
    return section;
  }).join('');
  return `${opening}${introductions}${fixed}${ending}`;
}
