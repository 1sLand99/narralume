import { describe, expect, it } from "vitest";

import { REVIEW_CONTRACT, ReviewResultSchema } from "../src/schemas.js";

const scores = {
  continuity: 90,
  pacing: 90,
  character: 90,
  prose: 90,
  goal: 90,
};

describe("derived semantic review verdict", () => {
  it("rejects model verdicts and normalizes minor author flags", () => {
    const withModelVerdict = ReviewResultSchema.safeParse({
      summary: "有一处轻微文句问题。",
      scores,
      issues: [
        {
          category: "prose",
          severity: "minor",
          message: "可以更凝练",
          evidenceParagraphs: [1],
          suggestedDirection: null,
          requiresAuthorDecision: true,
        },
      ],
      verdict: "block",
    });
    expect(withModelVerdict.success).toBe(false);
    const parsed = ReviewResultSchema.parse({
      summary: "有一处轻微文句问题。",
      scores,
      issues: [
        {
          category: "prose",
          severity: "minor",
          message: "可以更凝练",
          evidenceParagraphs: [1],
          suggestedDirection: null,
          requiresAuthorDecision: true,
        },
      ],
    });
    expect(parsed.issues[0]?.requiresAuthorDecision).toBe(true);
    // A model flag is a proposal; evidence verification determines routing.
  });

  it("allows minor deviations from generated chapter goals", () => {
    const parsed = ReviewResultSchema.safeParse({
      summary: "目标没有完成。",
      scores: { ...scores, goal: 30 },
      issues: [
        {
          category: "goal",
          severity: "minor",
          message: "目标只完成一半",
          evidenceParagraphs: [1],
          suggestedDirection: "补足结果",
          requiresAuthorDecision: false,
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("removes verdict from the model contract", () => {
    expect(REVIEW_CONTRACT.schema.required).not.toContain("verdict");
    expect(REVIEW_CONTRACT.schema.properties).not.toHaveProperty("verdict");
  });
});
