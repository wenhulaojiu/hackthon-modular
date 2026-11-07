import { z } from 'zod';
import { ApiError, apiResponse, appStateSchema, json, loadState, parseInput, readJson, requestWorkspace, requireSameOrigin, requireUserId, saveState } from '@/lib/server';
import { enrollReplyContacts, isReplyPrivateContact } from '@/lib/reply-enrollment';

export const dynamic = 'force-dynamic';
const inputSchema = z.object({ contacts: z.array(z.object({ wechatId: z.string().min(1).max(200).refine(isReplyPrivateContact), name: z.string().min(1).max(160), date: z.string().datetime({ offset: true }).optional() }).strict()).min(1).max(20) }).strict();

export async function POST(request: Request) {
  return apiResponse(async () => {
    const userId = await requireUserId();
    requireSameOrigin(request);
    const workspace = requestWorkspace(request, true);
    if (!workspace || workspace.id === 'legacy' || request.headers.get('x-kexu-local') !== '1') throw new ApiError(403, '自动建立微信客户档案仅在已绑定账号的本地版可用。');
    const input = parseInput(inputSchema, await readJson(request, 32_000));
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await loadState(userId, workspace);
      if (!current.state.replySettings?.enabled || current.state.replySettings.autoEnrollNewContacts === false) throw new ApiError(409, '自动接待新私聊已关闭，未扩大回复范围。');
      let enrolled;
      try { enrolled = enrollReplyContacts(current.state, input.contacts); }
      catch (error) { throw new ApiError(409, (error as Error).message); }
      const state = parseInput(appStateSchema, enrolled.state);
      let revision = current.revision;
      try { if (enrolled.addedCustomerIds.length) revision = await saveState(userId, state, revision, workspace); }
      catch (error) { if (error instanceof ApiError && error.status === 409 && attempt < 2) continue; throw error; }
      return json({ config: { settings: state.replySettings, customers: state.customers.filter(customer => customer.source !== 'demo' && customer.wechatId).map(({ id, wechatId, name, autoReplyEnabled, humanTakeover }) => ({ id, wechatId, name, autoReplyEnabled, humanTakeover })), products: state.products || [], storeName: state.settings.storeName, industry: state.settings.industry }, addedCustomerIds: enrolled.addedCustomerIds, revision });
    }
    throw new ApiError(409, '客户资料正在更新，请稍后重新读取新私聊。');
  });
}
