import type { VerifiedSession } from "./session.js";

export const SESSION_REQUEST_LIMIT = 60;
export const DEFAULT_GLOBAL_DAILY_REQUEST_LIMIT = 1_000;

interface StoredQuota {
  count: number;
  expiresAt: number;
}

export interface QuotaResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

export class SessionQuota {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });

    const expiresAt = Number(request.headers.get("x-quota-expires-at"));
    const limit = Number(request.headers.get("x-quota-limit"));
    const now = Math.floor(Date.now() / 1_000);
    if (
      !Number.isInteger(expiresAt) ||
      expiresAt <= now ||
      !Number.isInteger(limit) ||
      limit < 1
    ) {
      return Response.json({ code: "invalid_quota" }, { status: 400 });
    }

    const result = await this.state.storage.transaction(async (transaction) => {
      const stored = await transaction.get<StoredQuota>("quota");
      const count = stored?.expiresAt === expiresAt ? stored.count : 0;
      if (count >= limit) {
        return {
          allowed: false,
          limit,
          remaining: 0,
          resetAt: expiresAt,
        } satisfies QuotaResult;
      }

      const nextCount = count + 1;
      await transaction.put("quota", { count: nextCount, expiresAt });
      await this.state.storage.setAlarm(expiresAt * 1_000);
      return {
        allowed: true,
        limit,
        remaining: limit - nextCount,
        resetAt: expiresAt,
      } satisfies QuotaResult;
    });

    return Response.json(result);
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

export async function consumeSessionQuota(
  namespace: DurableObjectNamespace,
  session: VerifiedSession,
): Promise<QuotaResult> {
  return consumeQuota(
    namespace,
    `session:${session.id}`,
    SESSION_REQUEST_LIMIT,
    session.exp,
  );
}

export async function consumeGlobalQuota(
  namespace: DurableObjectNamespace,
  limit: number,
  nowMs = Date.now(),
): Promise<QuotaResult> {
  const nowSeconds = Math.floor(nowMs / 1_000);
  const windowStart = Math.floor(nowSeconds / 86_400) * 86_400;
  return consumeQuota(
    namespace,
    `global:${windowStart}`,
    limit,
    windowStart + 86_400,
  );
}

async function consumeQuota(
  namespace: DurableObjectNamespace,
  name: string,
  limit: number,
  expiresAt: number,
): Promise<QuotaResult> {
  const id = namespace.idFromName(name);
  const response = await namespace
    .get(id)
    .fetch("https://quota.internal/consume", {
      method: "POST",
      headers: {
        "x-quota-expires-at": String(expiresAt),
        "x-quota-limit": String(limit),
      },
    });
  if (!response.ok)
    throw new Error(`Quota service failed with ${response.status}`);
  return (await response.json()) as QuotaResult;
}
