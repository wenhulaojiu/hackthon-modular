export type CustomerStage = '新客户' | '潜在客户' | '活跃客户' | '重点维护' | '待唤醒';
export type Evidence = { id: string; text: string; date: string; source: string };
export type ChatMessage = { id: string; sender: 'customer' | 'merchant'; text: string; date: string };
export type Customer = {
  id: string; name: string; wechatId: string; color: string; stage: CustomerStage;
  tags: string[]; manualTags: string[]; summary: string; preferences: string; budget: string;
  note: string; createdAt: string; lastContactAt: string; nextFollowUpAt: string;
  source: 'demo' | 'manual' | 'wechat'; evidence: Evidence[]; messages: ChatMessage[];
};
export type Order = {
  id: string; customerId: string; description: string; amount: number; date: string;
  status: 'pending' | 'confirmed' | 'rejected'; type: 'sale' | 'refund'; evidence: string;
};
export type Task = {
  id: string; customerId: string; title: string; date: string;
  kind: 'followup' | 'marketing' | 'reminder'; status: 'todo' | 'done'; priority: 'high' | 'normal'; script: string;
};
export type Settings = {
  storeName: string; industry: string; followupDays: number;
  ai: { baseUrl: string; model: string; temperature: number; profilePrompt: string; marketingPrompt: string; extractionPrompt: string };
};
export type ImportRecord = { id: string; fileName: string; date: string; customerCount: number; messageCount: number };
export type AppState = { schemaVersion: 1; customers: Customer[]; orders: Order[]; tasks: Task[]; settings: Settings; imports: ImportRecord[]; demo: boolean };
export type PageId = 'overview' | 'customers' | 'marketing' | 'inbox' | 'settings';
export type AIResult = { summary?: string; tags?: string[]; preferences?: string; budget?: string; script?: string; nextFollowUpAt?: string; orders?: Array<{description:string;amount:number;date:string;type:'sale'|'refund';evidence:string}> };
export type AiAction = 'profile' | 'marketing' | 'extract' | 'test';
export type SharedProps = {
  state: AppState; onChange: (next: AppState) => Promise<boolean>; notify: (text: string, error?: boolean) => void;
  onAI: (action: AiAction, customerId?: string) => Promise<AIResult>;
};
export type CustomersProps = SharedProps & { selectedId: string | null; onSelect: (id: string | null) => void };
export type SettingsProps = SharedProps & { hasApiKey: boolean; onSaveKey: (apiKey: string, remove?: boolean) => Promise<void> };
