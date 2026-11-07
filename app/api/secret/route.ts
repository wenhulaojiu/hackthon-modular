import { z } from "zod";
import { ApiError, apiResponse, json, parseInput, readJson, removeKey, requireSameOrigin, requireUserId, storeKey } from "@/lib/server";

export async function POST(request: Request) {
  return apiResponse(async () => {
    const userId = await requireUserId();
    requireSameOrigin(request);
    const input = parseInput(z.object({ apiKey: z.string().max(512).optional(), remove: z.boolean().optional() }).strict(), await readJson(request, 2048));
    if (input.remove) { await removeKey(userId); return json({ hasApiKey: false }); }
    const apiKey = input.apiKey?.trim() ?? "";
    if (apiKey.length < 12 || apiKey.length > 512 || !/^[\x21-\x7E]+$/.test(apiKey)) throw new ApiError(400, "API Key 需要为 12–512 个有效字符；留空不会覆盖已保存的密钥。");
    await storeKey(userId, apiKey);
    return json({ hasApiKey: true });
  });
}
