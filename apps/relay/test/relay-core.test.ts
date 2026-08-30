import { describe, expect, it } from "vitest";

import {
  decideRelay,
  RELAY_MAX_OUTPUT_TOKENS,
  RELAY_REQUEST_BODY_MAX_BYTES,
  responseHeadersForRelay,
  type RelayEnv,
  type RelayRequestContext,
} from "../src/relay-core.js";

const env: RelayEnv = {
  upstreamBaseUrl: "https://bridge.example/v1",
  model: "example-model",
  bridgeAccessClientId: "access-client-id",
  bridgeAccessClientSecret: "access-client-secret",
  bridgeSharedSecret: "bridge-shared-secret",
};

function request(
  overrides: Partial<RelayRequestContext> = {},
): RelayRequestContext {
  return {
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: "client-selected-model",
      stream: true,
      messages: [{ role: "user", content: "继续" }],
    },
    ...overrides,
  };
}

describe("公网 Relay 白名单", () => {
  it("只放行 Chat Completions", () => {
    expect(decideRelay(env, request()).action).toBe("forward");
    for (const url of [
      "/v1/responses",
      "/v1/messages",
      "/v1/embeddings",
      "/v1/models",
      "/admin",
    ]) {
      expect(decideRelay(env, request({ url }))).toMatchObject({
        action: "reject",
        status: 404,
        code: "path_not_allowed",
      });
    }
  });

  it("拒绝非 POST 与非对象请求体", () => {
    expect(decideRelay(env, request({ method: "GET" }))).toMatchObject({
      action: "reject",
      status: 405,
      code: "method_not_allowed",
    });
    expect(decideRelay(env, request({ body: [] }))).toMatchObject({
      action: "reject",
      status: 400,
      code: "invalid_body",
    });
  });

  it("强制模型并只注入 Bridge 凭据", () => {
    const decision = decideRelay(env, request());
    expect(decision.action).toBe("forward");
    if (decision.action !== "forward") return;

    expect(decision.upstreamUrl).toBe(
      "https://bridge.example/v1/chat/completions",
    );
    expect(decision.body).toMatchObject({
      model: "example-model",
      stream: true,
    });
    expect(decision.headers).toEqual({
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "cf-access-client-id": "access-client-id",
      "cf-access-client-secret": "access-client-secret",
      "x-narrative-bridge-token": "bridge-shared-secret",
    });
    expect(decision.headers.authorization).toBeUndefined();
    expect(JSON.stringify(decision)).not.toContain("client-selected-model");
  });

  it("拒绝可放大候选数、绕过输出上限和其它未知字段", () => {
    const base = {
      model: "client-selected-model",
      stream: true,
      messages: [{ role: "user", content: "继续" }],
    };
    for (const body of [
      { ...base, n: 128 },
      { ...base, max_completion_tokens: 100_000 },
      { ...base, user: "anonymous" },
    ]) {
      expect(decideRelay(env, request({ body }))).toMatchObject({
        action: "reject",
        status: 400,
        code: "field_not_allowed",
      });
    }
  });

  it("重建白名单请求并钳制单次输出上限", () => {
    const decision = decideRelay(
      env,
      request({
        body: {
          model: "ignored",
          messages: [{ role: "user", content: "生成 JSON" }],
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: 100_000,
          response_format: { type: "json_object" },
          tools: [
            {
              type: "function",
              function: {
                name: "story_query",
                description: "查询故事资料",
                parameters: { type: "object", properties: {} },
                strict: true,
              },
            },
          ],
          tool_choice: "auto",
        },
      }),
    );

    expect(decision.action).toBe("forward");
    if (decision.action !== "forward") return;
    expect(decision.body).toMatchObject({
      model: "example-model",
      max_tokens: RELAY_MAX_OUTPUT_TOKENS,
      response_format: { type: "json_object" },
      tools: [{ function: { name: "story_query" } }],
    });
    expect(decision.body.n).toBeUndefined();
  });

  it("拒绝超过字节上限和消息数量上限的请求", () => {
    expect(
      decideRelay(
        env,
        request({
          body: {
            messages: [
              {
                role: "user",
                content: "x".repeat(RELAY_REQUEST_BODY_MAX_BYTES),
              },
            ],
          },
        }),
      ),
    ).toMatchObject({
      action: "reject",
      status: 413,
      code: "request_too_large",
    });
    expect(
      decideRelay(
        env,
        request({
          body: {
            messages: Array.from({ length: 129 }, () => ({
              role: "user",
              content: "x",
            })),
          },
        }),
      ),
    ).toMatchObject({
      action: "reject",
      status: 400,
      code: "invalid_body",
    });
  });
});

describe("Relay 响应头", () => {
  it("只保留内容类型、请求 ID 和允许站点的 CORS", () => {
    const headers = responseHeadersForRelay(
      [
        ["content-type", "text/event-stream"],
        ["x-request-id", "req-42"],
        ["x-internal-provider", "must-not-leak"],
        ["set-cookie", "must-not-leak"],
      ],
      "https://demo.example.com",
    );

    expect(headers).toMatchObject({
      "content-type": "text/event-stream",
      "x-request-id": "req-42",
      "access-control-allow-origin": "https://demo.example.com",
      "access-control-allow-credentials": "true",
      "cache-control": "no-store",
    });
    expect(headers["x-internal-provider"]).toBeUndefined();
    expect(headers["set-cookie"]).toBeUndefined();
  });
});
