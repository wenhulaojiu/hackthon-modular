export function uid() { return crypto.randomUUID(); }
export function day(value: string) { return value.slice(0,10); }
export function humanDate(value: string) { return value ? value.slice(5,10).replace('-','月')+'日' : '未设置'; }
export async function copy(text: string) { await navigator.clipboard.writeText(text); }
export function download(name: string, content: string) { const url=URL.createObjectURL(new Blob([content],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }
