export type CustomerStage = '新客户' | '潜在客户' | '活跃客户' | '重点维护' | '待唤醒';
export type Evidence = { id: string; text: string; date: string; source: string };
export type ChatMessage = { id: string; sender: 'customer' | 'merchant'; text: string; date: string };
export type Customer = {
  id: string; name: string; wechatId: string; color: string; stage: CustomerStage;
  tags: string[]; manualTags: string[]; summary: string; preferences: string; budget: string;
  note: string; createdAt: string; lastContactAt: string; nextFollowUpAt: string;
  source: 'demo' | 'manual' | 'wechat'; evidence: Evidence[]; messages: ChatMessage[];
  autoReplyEnabled?: boolean; humanTakeover?: boolean;
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
export type ExportRecord = { id: string; fileName: string; date: string; kind: 'json' | 'customers' | 'orders' | 'tasks'; customerCount: number; messageCount: number };
export type FAQ = { question: string; answer: string };
export type Product = { id: string; name: string; type: 'product' | 'service'; price: number | null; stock?: number | null; restockThreshold?: number; description: string; faq: FAQ[]; enabled: boolean; needsRestock?: boolean; source?: 'demo' | 'manual' };
export type ReplySettings = {
  enabled: boolean; mode: 'review' | 'auto'; selectedCustomerIds: string[]; autoEnrollNewContacts?: boolean;
  businessHours: { enabled: boolean; start: string; end: string; days: number[] };
  storeInfo?: { contactName?: string; phone: string; address: string; serviceContent: string };
  welcomeEnabled?: boolean; welcomeMessage?: string;
  faq: FAQ[]; handoffKeywords: string[]; maxReplyChars: number; cooldownSeconds: number; debounceSeconds?: number; prompt: string;
};
export type ReplyResult = { action: 'reply' | 'handoff' | 'ignore' | 'clarify'; reply: string; reason: string; productIds?: string[] };
export type NativeSenderStatus = {
  available: boolean; installed: boolean; enabled: boolean; ready: boolean; compatible: boolean;
  requiresForeground: false; message: string; componentVersion?: string | null;
  source: 'helper'; setupState: 'idle' | 'installing' | 'failed' | 'ready';
};
export type ReplyMessage = { id: string; text: string; date: string; nativeMessageId?: string };
export type ReplyContextMessage = { sender: 'customer' | 'merchant'; text: string; date: string };
export type ReplyJobStatus = 'queued' | 'generating' | 'draft' | 'ready' | 'sending' | 'sent' | 'handoff' | 'failed' | 'unknown' | 'ignored' | 'cancelled';
export type ReplyJobView = { id: string; customerId: string; chatId: string; kind?: 'welcome' | 'reply' | 'followup'; taskId?: string; message: ReplyMessage; messages?: ReplyMessage[]; quietUntil?: string; status: ReplyJobStatus; reply?: string; reason?: string; createdAt: string; updatedAt: string; sendMessageId?: string };
export type ReplyWork = { id: string; leaseId: string; customerId: string; message: ReplyMessage; messages?: ReplyMessage[]; context: ReplyContextMessage[] };
export type AppState = { schemaVersion: 1; customers: Customer[]; orders: Order[]; tasks: Task[]; settings: Settings; imports: ImportRecord[]; exports?: ExportRecord[]; demo: boolean; products?: Product[]; replySettings?: ReplySettings };
export type PageId = 'overview' | 'customers' | 'marketing' | 'inbox' | 'settings' | 'auto-reply' | 'products';
export type AIResult = { summary?: string; tags?: string[]; preferences?: string; budget?: string; script?: string; nextFollowUpAt?: string; orders?: Array<{description:string;amount:number;date:string;type:'sale'|'refund';evidence:string}> };
export type AiAction = 'profile' | 'marketing' | 'extract' | 'test';
export type SharedProps = {
  state: AppState; onChange: (next: AppState, options?: { clearBusinessData?: boolean }) => Promise<boolean>; notify: (text: string, error?: boolean) => void;
  onAI: (action: AiAction, customerId?: string) => Promise<AIResult>;
};
export type CustomersProps = SharedProps & { selectedId: string | null; onSelect: (id: string | null) => void };
export type SettingsProps = SharedProps & { hasApiKey: boolean; onSaveKey: (apiKey: string, remove?: boolean) => Promise<void> };
