import { describe, expect, it } from "vitest";
import {
  applyEditorialCheck,
  selectEditorialSources,
  validateEditorialCheck,
  type EditorialCheck,
  type EditorialSource,
} from "../src/editorial-grounding.js";
import type { ReviewResult } from "../src/schemas.js";

const sources: EditorialSource[] = [
  {
    id: "author",
    kind: "author",
    content:
      "Only six people appear. Do not reveal the culprit before chapter seven.",
    version: "v1",
  },
  {
    id: "chapter1",
    kind: "manuscript",
    content: "罗川说：那年出事的时候我——。他摇头：算了，这雪。",
    version: "chapter1-v2",
  },
];
const manuscript = "孟禾看着手术刀片。罗川说：我之前说过送人上山。";
const review: ReviewResult = {
  summary: "review",
  scores: { continuity: 80, pacing: 80, character: 80, prose: 80, goal: 80 },
  issues: [
    {
      category: "information",
      severity: "major",
      message: "The scalpel reveals the nurse",
      evidenceParagraphs: [1],
      suggestedDirection: "Remove clue",
      requiresAuthorDecision: true,
    },
  ],
};
const finding: EditorialCheck["findings"][number] = {
  issueIndex: 0,
  disposition: "advisory",
  explanation: "Suspicion is not identity confirmation",
  currentQuote: "孟禾看着手术刀片",
  citations: [],
  repairDirection: null,
  cannotRepairLocally: null,
  alternatives: [],
};

describe("grounded editorial routing", () => {
  it("does not turn a legitimate clue into an author decision", () => {
    const check = { findings: [finding] };
    expect(validateEditorialCheck(check, [0], sources, manuscript)).toEqual([]);
    const result = applyEditorialCheck(review, check, sources);
    expect(result.verdict).toBe("pass");
    expect(result.issues[0]).toMatchObject({
      requiresAuthorDecision: false,
      hardConflict: false,
    });
  });

  it("rejects fabricated history and requires exact source and current quotes", () => {
    const check = {
      findings: [
        {
          ...finding,
          disposition: "repair" as const,
          citations: [{ sourceId: "chapter1", quote: "送人上山" }],
          repairDirection: "Correct the claimed quote",
        },
      ],
    };
    expect(validateEditorialCheck(check, [0], sources, manuscript)).toContain(
      "Issue 0: citation must quote a supplied source exactly",
    );
    check.findings[0]!.citations[0]!.quote = sources[1]!.content;
    expect(validateEditorialCheck(check, [0], sources, manuscript)).toEqual([]);
    expect(applyEditorialCheck(review, check, sources).issues[0]).toMatchObject(
      { hardConflict: true, requiresAuthorDecision: false },
    );
  });

  it("rejects author decisions based only on severity or one commitment", () => {
    const check = {
      findings: [
        {
          ...finding,
          disposition: "author_decision" as const,
          citations: [{ sourceId: "author", quote: "Only six people appear." }],
          cannotRepairLocally: "Too obvious",
          alternatives: ["Change culprit", "Remove clue"],
        },
      ],
    };
    expect(
      validateEditorialCheck(check, [0], sources, manuscript),
    ).toHaveLength(1);
  });

  it("does not silently omit or duplicate requested findings", () => {
    expect(
      validateEditorialCheck({ findings: [] }, [0], sources, manuscript),
    ).not.toEqual([]);
    expect(
      validateEditorialCheck(
        { findings: [finding, finding] },
        [0, 1],
        sources,
        manuscript,
      ),
    ).not.toEqual([]);
  });

  it("keeps uncertain allegations non-blocking and preserves source versions", () => {
    const result = applyEditorialCheck(
      review,
      {
        findings: [
          {
            ...finding,
            disposition: "uncertain",
            citations: [{ sourceId: "chapter1", quote: "算了，这雪" }],
          },
        ],
      },
      sources,
    );
    expect(result.verdict).toBe("pass");
    expect(result.issues[0]?.grounding?.citations[0]?.version).toBe(
      "chapter1-v2",
    );
  });

  it("selects relevant original passages without turning absent search results into facts", () => {
    const selected = selectEditorialSources(sources, "罗川说过", 1000);
    expect(selected[0]?.kind).toBe("author");
    expect(
      selected.some(
        (s) => s.kind === "manuscript" && s.content === sources[1]!.content,
      ),
    ).toBe(true);
    expect(selectEditorialSources(sources, "unrelated", 1000)).toEqual([
      sources[0],
    ]);
  });

  it("retains relevant history when required canon exceeds the history allowance", () => {
    const expandedSources = [
      { ...sources[0]!, content: "Required canon. ".repeat(1000) },
      sources[1]!,
    ];
    const selected = selectEditorialSources(expandedSources, "罗川说过", 1000);
    expect(selected[0]).toEqual(expandedSources[0]);
    expect(selected[1]).toMatchObject({
      content: expandedSources[1]!.content,
      kind: "manuscript",
      version: expandedSources[1]!.version,
    });
  });
});
