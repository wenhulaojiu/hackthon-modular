import { ApiError, apiResponse, json, manualResumeRequestSchema, parseInput, readJson, requestWorkspace, requireSameOrigin, requireUserId, resumeManualCustomer } from '@/lib/server';

export async function POST(request: Request) {
  return apiResponse(async () => {
    const userId = await requireUserId();
    requireSameOrigin(request);
    const workspace = requestWorkspace(request, true);
    if (!workspace || workspace.id === 'legacy' || request.headers.get('x-kexu-local') !== '1') throw new ApiError(403, '恢复微信托管仅支持已绑定账号的本地版。');
    return json(await resumeManualCustomer(userId, parseInput(manualResumeRequestSchema, await readJson(request, 8_000)), workspace));
  });
}
