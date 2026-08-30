import { describe, expect, it } from "vitest";

import { hasJsonContentType, readJsonWithLimit } from "../src/request-json.js";

describe("Relay 有界 JSON 读取", () => {
  it("接受带 charset 的 JSON 并拒绝其它媒体类型", () => {
    expect(
      hasJsonContentType(
        new Request("https://relay.example", {
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
      ),
    ).toBe(true);
    expect(
      hasJsonContentType(
        new Request("https://relay.example", {
          headers: { "content-type": "text/plain" },
        }),
      ),
    ).toBe(false);
  });

  it("在 JSON 解析前执行实际流字节上限", async () => {
    const request = new Request("https://relay.example", {
      method: "POST",
      body: JSON.stringify({ value: "x".repeat(64) }),
    });

    await expect(readJsonWithLimit(request, 32)).resolves.toEqual({
      ok: false,
      reason: "request_too_large",
    });
  });

  it("区分合法 JSON 与解析失败", async () => {
    await expect(
      readJsonWithLimit(
        new Request("https://relay.example", {
          method: "POST",
          body: '{"ok":true}',
        }),
        128,
      ),
    ).resolves.toEqual({ ok: true, value: { ok: true } });
    await expect(
      readJsonWithLimit(
        new Request("https://relay.example", {
          method: "POST",
          body: "{",
        }),
        128,
      ),
    ).resolves.toEqual({ ok: false, reason: "invalid_json" });
  });
});
