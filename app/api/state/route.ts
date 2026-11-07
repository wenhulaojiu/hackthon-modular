import { z } from "zod";
import { apiResponse, appStateSchema, hasSavedKey, json, loadState, parseInput, readJson, requestWorkspace, requireSameOrigin, requireUserId, saveState } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(request?: Request) {
  return apiResponse(async () => {
    const userId = await requireUserId();
    const workspace = requestWorkspace(request);
    const data = await loadState(userId, workspace);
    return json({ ...data, hasApiKey: await hasSavedKey(userId), ...(workspace ? { workspaceToken: `${workspace.id}@${workspace.revision}` } : {}) });
  });
}

export async function POST(request: Request) {
  return apiResponse(async () => {
    const userId = await requireUserId();
    requireSameOrigin(request);
    const workspace = requestWorkspace(request, true);
    const input = parseInput(z.object({ state: appStateSchema, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1) }).strict(), await readJson(request));
    return json({ revision: await saveState(userId, input.state, input.revision, workspace) });
  });
}
