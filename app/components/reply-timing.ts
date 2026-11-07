export type ReplyWaitUnit = 'seconds' | 'minutes';

export function replyWaitSeconds(value: string, unit: ReplyWaitUnit): number | null {
  const text = value.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0 || amount > (unit === 'minutes' ? 60 : 3600)) return null;
  if (unit === 'seconds') return Number.isInteger(amount) ? amount : null;
  const seconds = amount * (unit === 'minutes' ? 60 : 1);
  const rounded = Math.round(seconds);
  // 单位切换可能产生循环小数，仅容纳浮点表示误差，不截断非整秒输入。
  if (Math.abs(seconds - rounded) > 1e-9 || rounded < 0 || rounded > 3600) return null;
  return rounded;
}

export function replyWaitValue(seconds: number, unit: ReplyWaitUnit): string {
  return String(unit === 'minutes' ? seconds / 60 : seconds);
}

export function replyWaitLabel(seconds: number): string {
  if (seconds === 0) return '不额外等待';
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? remainder ? `${minutes}分${remainder}秒` : `${minutes}分钟` : `${seconds}秒`;
}
