import { describe, expect, it, vi } from "vitest";

import { buildBridge } from "../src/app.js";
import type { BridgeConfig } from "../src/config.js";

const config: BridgeConfig = {
  host: "127.0.0.1",
  port: 4320,
  upstreamBaseUrl: "https://upstream.example/v1",
  upstreamApiKey: "UPSTREAM-SECRET",
  model: "example-model",
  sharedSecret: "bridge-secret-at-least-24-characters",
  maxConcurrency: 1,
  upstreamTimeoutMs: 10_000,
};

describe("local provider bridge", () => {
  it("reports health without exposing credentials", async () => {
    const app = buildBridge({ config, logger: false });
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "narralume-bridge",
      activeRequests: 0,
      maxConcurrency: 1,
    });
    expect(response.body).not.toContain("UPSTREAM-SECRET");
    await app.close();
  });

  it("rejects callers without the local bridge secret", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const app = buildBridge({ config, fetch: fetchMock, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "anything", messages: [] },
    });

    expect(response.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("forces the configured model, injects the local API key and streams", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("data: hello\n\ndata: [DONE]\n\n", {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-request-id": "upstream-42",
          "x-internal-header": "must-not-leak",
        },
      }),
    );
    const app = buildBridge({ config, fetch: fetchMock, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "x-narrative-bridge-token": config.sharedSecret,
      },
      payload: {
        model: "attacker-model",
        stream: true,
        messages: [{ role: "user", content: "继续" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["x-request-id"]).toBe("upstream-42");
    expect(response.headers["x-internal-header"]).toBeUndefined();
    expect(response.body).toContain("data: hello");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://upstream.example/v1/chat/completions");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer UPSTREAM-SECRET",
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "example-model",
      stream: true,
      max_tokens: 32_000,
    });
    await app.close();
  });

  it("rejects cost-amplifying fields and clamps the output limit", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok"));
    const app = buildBridge({ config, fetch: fetchMock, logger: false });
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-narrative-bridge-token": config.sharedSecret },
      payload: {
        messages: [{ role: "user", content: "继续" }],
        n: 128,
        max_completion_tokens: 100_000,
      },
    });

    expect(rejected.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-narrative-bridge-token": config.sharedSecret },
      payload: {
        messages: [{ role: "user", content: "继续" }],
        max_tokens: 100_000,
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      max_tokens: 32_000,
    });
    await app.close();
  });

  it("cuts off oversized non-streaming model responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("x".repeat(8 * 1024 * 1024 + 1), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const app = buildBridge({ config, fetch: fetchMock, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-narrative-bridge-token": config.sharedSecret },
      payload: { messages: [] },
    });

    expect(response.body.length).toBeLessThan(8 * 1024 * 1024 + 1);
    await app.close();
  });

  it("rejects excess concurrent requests instead of queueing them", async () => {
    let releaseFetch!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = resolve;
          markStarted();
        }),
    );
    const app = buildBridge({ config, fetch: fetchMock, logger: false });
    const first = app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-narrative-bridge-token": config.sharedSecret },
      payload: { messages: [] },
    });
    await started;

    const second = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-narrative-bridge-token": config.sharedSecret },
      payload: { messages: [] },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({
      error: { code: "bridge.busy" },
    });

    releaseFetch(new Response("ok"));
    expect((await first).statusCode).toBe(200);
    await app.close();
  });
});
