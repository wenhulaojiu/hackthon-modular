import { aiRequestSchema, apiResponse, json, parseInput, readJson, requireSameOrigin, requireUserId, runAI } from "@/lib/server";

export async function POST(request: Request) {
  return apiResponse(async () => {
    const userId = await requireUserId();
    requireSameOrigin(request);
    const input = parseInput(aiRequestSchema, await readJson(request, 40_000));
    return json(await runAI(userId, input));
  });
}
