import { describe, expect, it } from "vitest";
import {
  selectedManuscriptArtifact,
  sha256Hex,
  type RunSnapshot,
} from "@narralume/domain";
import { selectReviewedCandidate } from "../src/revision-progress.js";

function prior(content: string, issues: unknown[] = []): RunSnapshot {
  return {
    steps: [
      {
        kind: "semantic.review",
        status: "succeeded",
        outputArtifact: {
          verdict: issues.length ? "revise" : "pass",
          issues,
          verifiedContent: content,
          reviewedContentHash: sha256Hex(content),
          reportId: "prior-report",
        },
      },
    ],
  } as unknown as RunSnapshot;
}
const conflict = {
  category: "continuity",
  severity: "major",
  hardConflict: true,
  grounding: {
    citations: [
      { sourceId: "author", quote: "Only six people", version: "v1" },
    ],
  },
};

describe("verified manuscript selection", () => {
  it("rejects a revision introducing a confirmed contradiction and keeps the matching report", () => {
    const result = selectReviewedCandidate(
      prior("six people"),
      "seven people",
      { verdict: "revise", issues: [conflict], reportId: "new-report" },
    );
    expect(result).toMatchObject({
      verifiedContent: "six people",
      reportId: "prior-report",
      selectionReason: "rejected_regression",
      stopEditing: true,
      verdict: "pass",
    });
    expect(result.candidateReview).toMatchObject({ reportId: "new-report" });
  });
  it("stops repeated grounded errors without declaring the manuscript passed", () => {
    const result = selectReviewedCandidate(
      prior("old", [conflict]),
      "new wording",
      { verdict: "revise", issues: [conflict] },
    );
    expect(result).toMatchObject({
      verdict: "revise",
      stopEditing: true,
      selectionReason: "unresolved_same_evidence",
    });
  });
  it("does not restore an older review after its authoritative sources change", () => {
    const snapshot = prior("six people");
    snapshot.steps[0]!.outputArtifact!.sourceFingerprint = "old";
    const result = selectReviewedCandidate(snapshot, "new candidate", {
      verdict: "revise",
      issues: [conflict],
      sourceFingerprint: "new",
    });
    expect(result.verifiedContent).toBe("new candidate");
    expect(result.selectionReason).toBe("reviewed_candidate");
  });
  it("detects returning to a previously reviewed version", () => {
    const snapshot = prior("version A");
    const result = selectReviewedCandidate(snapshot, "version A", {
      verdict: "revise",
      issues: [],
    });
    expect(result).toMatchObject({
      stopEditing: true,
      selectionReason: "repeated_content",
    });
  });
  it("shares selection between presentation, further revision and settlement", () => {
    const snapshot = prior("accepted");
    expect(selectedManuscriptArtifact(snapshot)).toMatchObject({
      content: "accepted",
      contentHash: sha256Hex("accepted"),
    });
    snapshot.steps.push({
      kind: "revision.generate",
      status: "succeeded",
      outputArtifact: { content: "candidate" },
    } as RunSnapshot["steps"][number]);
    expect(selectedManuscriptArtifact(snapshot)?.content).toBe("candidate");
    snapshot.steps.push({
      kind: "semantic.review",
      status: "succeeded",
      outputArtifact: {
        verifiedContent: "accepted",
        reviewedContentHash: sha256Hex("accepted"),
      },
    } as RunSnapshot["steps"][number]);
    expect(selectedManuscriptArtifact(snapshot)?.content).toBe("accepted");
  });
});
