import { z } from "zod";
import { apiResponse, appStateSchema, hasSavedKey, json, loadState, parseInput, readJson, requireSameOrigin, requireUserId, saveState } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return apiResponse(async () => {
    const userId = await requireUserId();
    const data = await loadState(userId);
    return json({ ...data, hasApiKey: await hasSavedKey(userId) });
  });
}

export async function POST(request: Request) {
  return apiResponse(async () => {
    const userId = await requireUserId();
    requireSameOrigin(request);
    const input = parseInput(z.object({ state: appStateSchema, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1) }).strict(), await readJson(request));
    return json({ revision: await saveState(userId, input.state, input.revision) });
  });
}
