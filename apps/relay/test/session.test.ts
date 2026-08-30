import { describe, expect, it } from "vitest";

import {
  issueSession,
  sessionCookie,
  sessionFromCookie,
  verifySession,
} from "../src/session.js";

const SECRET = "0123456789abcdef".repeat(4);

describe("Relay 匿名会话", () => {
  it("只接受 32 字节十六进制签名密钥", async () => {
    const { isValidSessionSigningKey } = await import("../src/session.js");
    expect(isValidSessionSigningKey(SECRET)).toBe(true);
    expect(isValidSessionSigningKey("secret")).toBe(false);
    expect(isValidSessionSigningKey("g".repeat(64))).toBe(false);
    expect(isValidSessionSigningKey("0".repeat(63))).toBe(false);
  });

  it("签发并验证未过期的签名会话", async () => {
    const now = Date.UTC(2026, 7, 17);
    const token = await issueSession(SECRET, "203.0.113.1", now);

    await expect(
      verifySession(token, SECRET, "203.0.113.1", now + 1_000),
    ).resolves.toMatchObject({
      exp: expect.any(Number),
      id: expect.any(String),
      v: 1,
    });
    await expect(
      verifySession(token, "f".repeat(64), "203.0.113.1", now),
    ).resolves.toBeNull();
    await expect(
      verifySession(token, SECRET, "203.0.113.2", now),
    ).resolves.toBeNull();
  });

  it("拒绝篡改与过期会话", async () => {
    const now = Date.UTC(2026, 7, 17);
    const token = await issueSession(SECRET, "203.0.113.1", now);

    await expect(
      verifySession(`${token}x`, SECRET, "203.0.113.1", now),
    ).resolves.toBeNull();
    await expect(
      verifySession(token, SECRET, "203.0.113.1", now + 24 * 60 * 60 * 1_000),
    ).resolves.toBeNull();
  });

  it("同一风险主体在同一额度窗口重复验证不会重置会话 ID", async () => {
    const now = Date.UTC(2026, 7, 17, 6);
    const first = await issueSession(SECRET, "203.0.113.1", now);
    const second = await issueSession(SECRET, "203.0.113.1", now + 3_600_000);
    const nextWindow = await issueSession(
      SECRET,
      "203.0.113.1",
      Date.UTC(2026, 7, 18),
    );
    const firstSession = await verifySession(first, SECRET, "203.0.113.1", now);
    const secondSession = await verifySession(
      second,
      SECRET,
      "203.0.113.1",
      now,
    );
    const nextSession = await verifySession(
      nextWindow,
      SECRET,
      "203.0.113.1",
      Date.UTC(2026, 7, 18),
    );

    expect(firstSession).toMatchObject({
      id: secondSession?.id,
      exp: secondSession?.exp,
    });
    expect(nextSession?.id).not.toBe(firstSession?.id);
  });

  it("读取并生成安全 Cookie", async () => {
    const token = await issueSession(SECRET, "203.0.113.1");
    expect(
      sessionFromCookie(`other=1; __Host-narralume_session=${token}`),
    ).toBe(token);
    expect(sessionCookie(token)).toContain("HttpOnly; Secure; SameSite=Strict");
    expect(sessionCookie(token)).toContain("Max-Age=86400");
  });
});
