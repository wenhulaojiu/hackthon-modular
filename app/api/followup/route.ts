import { z } from 'zod';
import { ApiError, apiResponse, json, loadState, parseInput, readJson, requestWorkspace, requireSameOrigin, requireUserId } from '@/lib/server';
import { prepareSavedFollowup } from '@/lib/followup';

export const dynamic = 'force-dynamic';
const inputSchema = z.object({ taskId: z.string().min(1).max(160).regex(/^[^\u0000-\u001f]+$/) }).strict();

export async function POST(request: Request) {
  return apiResponse(async () => {
    const userId = await requireUserId();
    requireSameOrigin(request);
    const workspace = requestWorkspace(request, true);
    if (!workspace || request.headers.get('x-kexu-local') !== '1') throw new ApiError(403, '一键跟进仅在当前微信工作区的本地版可用。');
    const input = parseInput(inputSchema, await readJson(request, 8192));
    const { state } = await loadState(userId, workspace);
    try { return json(prepareSavedFollowup(state, input.taskId)); }
    catch (error) { throw new ApiError(409, error instanceof Error ? error.message : '该跟进尚不满足发送条件。'); }
  });
}
