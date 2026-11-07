import { apiResponse, json, parseInput, readJson, replyRequestSchema, requireSameOrigin, requireUserId, runReplyAI } from "@/lib/server";

export async function POST(request: Request) {
  return apiResponse(async () => {
    const userId = await requireUserId();
    requireSameOrigin(request);
    return json(await runReplyAI(userId, parseInput(replyRequestSchema, await readJson(request, 180_000))));
  });
}
