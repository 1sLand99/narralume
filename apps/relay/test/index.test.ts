import { describe, expect, it, vi } from "vitest";

import relay from "../src/index.js";
import { issueSession } from "../src/session.js";

const SECRET = "0123456789abcdef".repeat(4);

function env(
  input: {
    quota?: {
      allowed: boolean;
      limit: number;
      remaining: number;
      resetAt: number;
    };
    globalQuota?: {
      allowed: boolean;
      limit: number;
      remaining: number;
      resetAt: number;
    };
    sessionSigningKey?: string;
    rateLimitKeys?: string[];
    relayEnabled?: string;
  } = {},
) {
  return {
    UPSTREAM_BASE_URL: "https://bridge.example/v1",
    RELAY_MODEL: "example-model",
    WEB_ORIGIN: "https://demo.example.com",
    BRIDGE_ACCESS_CLIENT_ID: "access-client-id",
    BRIDGE_ACCESS_CLIENT_SECRET: "access-client-secret",
    BRIDGE_SHARED_SECRET: "bridge-shared-secret",
    SESSION_SIGNING_KEY: input.sessionSigningKey ?? SECRET,
    TURNSTILE_SECRET_KEY: "turnstile-secret-key",
    GLOBAL_DAILY_REQUEST_LIMIT: "1000",
    RELAY_ENABLED: input.relayEnabled,
    RATE_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        input.rateLimitKeys?.push(key);
        return { success: true };
      },
    },
    SESSION_QUOTAS: {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({
        fetch: async () =>
          Response.json(
            String(id).startsWith("global:")
              ? (input.globalQuota ?? {
                  allowed: true,
                  limit: 1_000,
                  remaining: 999,
                  resetAt: 1_800_000_000,
                })
              : (input.quota ?? {
                  allowed: true,
                  limit: 60,
                  remaining: 59,
                  resetAt: 1_800_000_000,
                }),
          ),
      }),
    } as unknown as DurableObjectNamespace,
  };
}

describe("Relay 请求入口", () => {
  const validBody = {
    messages: [{ role: "user", content: "继续" }],
    stream: true,
  };

  it("配置了弱会话签名密钥时 fail closed", async () => {
    const response = await relay.fetch(
      new Request("https://relay.example/session", { method: "GET" }),
      env({ sessionSigningKey: "secret" }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "relay_not_configured",
    });
  });

  it("在解析请求体前拒绝非 POST 请求", async () => {
    const response = await relay.fetch(
      new Request("https://relay.example/v1/chat/completions"),
      env(),
    );

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({
      code: "method_not_allowed",
    });
  });

  it("在限流和解析请求体前拒绝白名单外路径", async () => {
    const response = await relay.fetch(
      new Request("https://relay.example/v1/models", { method: "POST" }),
      env(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: "path_not_allowed",
    });
  });

  it("为允许的来源返回带凭据的 CORS 预检", async () => {
    const response = await relay.fetch(
      new Request("https://relay.example/session", {
        method: "OPTIONS",
        headers: { origin: "https://demo.example.com" },
      }),
      env(),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
  });

  it("未验证会话时拒绝模型请求", async () => {
    const response = await relay.fetch(
      new Request("https://relay.example/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      }),
      env(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "session_required",
    });
  });

  it("验证 Turnstile 后签发 HttpOnly 会话 Cookie", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          success: true,
          hostname: "demo.example.com",
          action: "trial-session",
        }),
      ),
    );
    const response = await relay.fetch(
      new Request("https://relay.example/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://demo.example.com",
        },
        body: JSON.stringify({ token: "turnstile-token" }),
      }),
      env(),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toMatch(
      /^__Host-narralume_session=.*HttpOnly; Secure; SameSite=Strict$/u,
    );
  });

  it("为中国大陆来源直接签发会话而不请求 Turnstile", async () => {
    const turnstileFetch = vi.fn();
    vi.stubGlobal("fetch", turnstileFetch);
    const request = new Request("https://relay.example/session", {
      method: "GET",
      headers: {
        origin: "https://demo.example.com",
        "cf-connecting-ip": "203.0.113.1",
      },
    });
    Object.defineProperty(request, "cf", { value: { country: "CN" } });
    const rateLimitKeys: string[] = [];

    const response = await relay.fetch(request, env({ rateLimitKeys }));

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toMatch(
      /^__Host-narralume_session=.*; Path=\/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict$/u,
    );
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://demo.example.com",
    );
    expect(rateLimitKeys).toEqual(["challenge:203.0.113.1"]);
    expect(turnstileFetch).not.toHaveBeenCalled();
  });

  it("非中国大陆来源仍要求完成人机验证", async () => {
    const request = new Request("https://relay.example/session", {
      method: "GET",
    });
    Object.defineProperty(request, "cf", { value: { country: "US" } });

    const response = await relay.fetch(request, env());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "session_required",
    });
  });

  it("携带有效会话时转发模型流", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("data: [DONE]\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
    const session = await issueSession(SECRET, "unknown-client");
    const rateLimitKeys: string[] = [];
    const response = await relay.fetch(
      new Request("https://relay.example/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `__Host-narralume_session=${session}`,
          origin: "https://demo.example.com",
        },
        body: JSON.stringify(validBody),
      }),
      env({ rateLimitKeys }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(response.headers.get("x-trial-quota-remaining")).toBe("59");
    expect(response.headers.get("x-trial-global-quota-remaining")).toBe("999");
    expect(rateLimitKeys).toHaveLength(1);
    expect(rateLimitKeys[0]).toMatch(/^model:[A-Za-z0-9_-]+$/u);
    expect(rateLimitKeys[0]).not.toContain("unknown-client");
  });

  it("实际模型 POST 拒绝带未知 Origin 的请求", async () => {
    const upstreamFetch = vi.fn();
    vi.stubGlobal("fetch", upstreamFetch);
    const session = await issueSession(SECRET, "unknown-client");
    const response = await relay.fetch(
      new Request("https://relay.example/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `__Host-narralume_session=${session}`,
          origin: "https://evil.example.com",
        },
        body: JSON.stringify(validBody),
      }),
      env(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "origin_not_allowed",
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("将 Bridge 网络失败映射为带 CORS 的 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("bridge offline");
      }),
    );
    const session = await issueSession(SECRET, "unknown-client");
    const response = await relay.fetch(
      new Request("https://relay.example/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `__Host-narralume_session=${session}`,
          origin: "https://demo.example.com",
        },
        body: JSON.stringify(validBody),
      }),
      env(),
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://demo.example.com",
    );
    await expect(response.json()).resolves.toMatchObject({
      code: "bridge_unavailable",
    });
  });

  it("会话额度耗尽后不再请求 Bridge", async () => {
    const upstreamFetch = vi.fn();
    vi.stubGlobal("fetch", upstreamFetch);
    const session = await issueSession(SECRET, "unknown-client");
    const response = await relay.fetch(
      new Request("https://relay.example/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `__Host-narralume_session=${session}`,
        },
        body: JSON.stringify(validBody),
      }),
      env({
        quota: {
          allowed: false,
          limit: 60,
          remaining: 0,
          resetAt: Math.floor(Date.now() / 1_000) + 60,
        },
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("x-trial-quota-limit")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({
      code: "session_quota_exhausted",
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("紧急熔断关闭后不签发会话或调用模型", async () => {
    const response = await relay.fetch(
      new Request("https://relay.example/session", { method: "GET" }),
      env({ relayEnabled: "0" }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "relay_disabled",
    });
  });

  it("全局日额度耗尽后不再请求 Bridge", async () => {
    const upstreamFetch = vi.fn();
    vi.stubGlobal("fetch", upstreamFetch);
    const session = await issueSession(SECRET, "unknown-client");
    const resetAt = Math.floor(Date.now() / 1_000) + 60;
    const response = await relay.fetch(
      new Request("https://relay.example/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `__Host-narralume_session=${session}`,
        },
        body: JSON.stringify(validBody),
      }),
      env({
        globalQuota: {
          allowed: false,
          limit: 1_000,
          remaining: 0,
          resetAt,
        },
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("x-trial-global-quota-limit")).toBe("1000");
    await expect(response.json()).resolves.toMatchObject({
      code: "global_quota_exhausted",
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});
