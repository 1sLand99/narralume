import { describe, expect, it } from "vitest";

import {
  ModelExecutionPolicySchema,
  extractPolicyUnknownFields,
  resolveEffectivePolicy,
} from "../src/index.js";

describe("B1 execution policy", () => {
  it("resolves safeguards without creative token ceilings", () => {
    const { effectivePolicy } = resolveEffectivePolicy();
    expect(effectivePolicy).toMatchObject({
      maxRevisionCycles: 2,
      semanticReview: true,
    });
    expect(effectivePolicy).not.toHaveProperty("contextWindow");
    expect(effectivePolicy).not.toHaveProperty("draftMaxOutputTokens");
  });

  it.each([
    "qualityPreset",
    "contextWindow",
    "draftMaxOutputTokens",
    "reviewMaxOutputTokens",
    "planningMaxOutputTokens",
    "settlementMaxOutputTokens",
    "modelRoutingMode",
    "maxPhysicalCalls",
    "outputReserve",
    "embeddingModelId",
    "modelRequestTimeoutMs",
    "embeddingModel",
  ])("rejects removed legacy field %s", (field) => {
    const parsed = ModelExecutionPolicySchema.safeParse({ [field]: 1 });
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(extractPolicyUnknownFields(parsed.error)).toEqual([field]);
  });

  it("preserves independent timeout scopes", () => {
    expect(
      resolveEffectivePolicy({
        requestStartTimeoutMs: 90_000,
        streamIdleTimeoutMs: 180_000,
        logicalCallDeadlineMs: 900_000,
        stepDeadlineMs: 1_200_000,
        runDeadlineMs: 3_600_000,
      }).effectivePolicy,
    ).toMatchObject({
      requestStartTimeoutMs: 90_000,
      streamIdleTimeoutMs: 180_000,
      logicalCallDeadlineMs: 900_000,
      stepDeadlineMs: 1_200_000,
      runDeadlineMs: 3_600_000,
    });
  });
});
