import { aiRequestSchema, apiResponse, json, parseInput, readJson, requestWorkspace, requireSameOrigin, requireUserId, runAI } from "@/lib/server";

export async function POST(request: Request) {
  return apiResponse(async () => {
    const userId = await requireUserId();
    requireSameOrigin(request);
    const workspace = requestWorkspace(request, true);
    const input = parseInput(aiRequestSchema, await readJson(request, 40_000));
    return json(await runAI(userId, input, workspace));
  });
}
