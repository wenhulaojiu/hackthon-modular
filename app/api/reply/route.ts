import { apiResponse, json, parseInput, readJson, replyRequestSchema, requestWorkspace, requireSameOrigin, requireUserId, runReplyAI } from "@/lib/server";

export async function POST(request: Request) {
  return apiResponse(async () => {
    const userId = await requireUserId();
    requireSameOrigin(request);
    const workspace = requestWorkspace(request, true);
    return json(await runReplyAI(userId, parseInput(replyRequestSchema, await readJson(request, 180_000)), workspace));
  });
}
