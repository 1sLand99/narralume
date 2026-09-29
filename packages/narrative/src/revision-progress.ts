import { sha256Hex, type RunSnapshot } from "@narralume/domain";

type Review = Record<string, unknown> & {
  verdict: string;
  issues: readonly unknown[];
};
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function hardKeys(review: Review): string[] {
  return review.issues
    .filter(record)
    .filter((issue) => issue.hardConflict === true)
    .map((issue) => {
      const grounding = record(issue.grounding) ? issue.grounding : {};
      return JSON.stringify([
        issue.category,
        Array.isArray(grounding.citations)
          ? grounding.citations
              .filter(record)
              .map((c) => [c.sourceId, c.quote])
              .sort((a, b) =>
                JSON.stringify(a).localeCompare(JSON.stringify(b)),
              )
          : [],
      ]);
    })
    .sort();
}

/** Keep immutable candidate artifacts; select only among versions actually reviewed. */
export function selectReviewedCandidate(
  snapshot: RunSnapshot,
  content: string,
  review: Review,
): Review {
  const hash = sha256Hex(content);
  const previous = [...snapshot.steps]
    .reverse()
    .find(
      (step) =>
        step.kind === "semantic.review" &&
        step.status === "succeeded" &&
        step.outputArtifact?.sourceFingerprint === review.sourceFingerprint &&
        typeof step.outputArtifact?.verifiedContent === "string",
    )?.outputArtifact as Review | undefined;
  const priorKeys = previous ? hardKeys(previous) : [];
  const keys = hardKeys(review);
  const repeatedText = snapshot.steps.some(
    (step) =>
      step.status === "succeeded" &&
      step.kind === "semantic.review" &&
      step.outputArtifact?.sourceFingerprint === review.sourceFingerprint &&
      step.outputArtifact?.reviewedContentHash === hash,
  );
  const sameConflict =
    keys.length > 0 && JSON.stringify(keys) === JSON.stringify(priorKeys);
  // More confirmed contradictions is a conservative regression signal. Do not compare
  // subjective model scores or silently edit the older candidate.
  const regressed =
    previous && previous.verdict !== "block" && keys.length > priorKeys.length;
  const selected = regressed ? previous : review;
  const selectedContent = regressed
    ? String(previous.verifiedContent)
    : content;
  return {
    ...selected,
    verifiedContent: selectedContent,
    reviewedContentHash: sha256Hex(selectedContent),
    candidateContentHash: hash,
    candidateReview: regressed ? review : null,
    stopEditing: repeatedText || sameConflict || Boolean(regressed),
    selectionReason: regressed
      ? "rejected_regression"
      : repeatedText
        ? "repeated_content"
        : sameConflict
          ? "unresolved_same_evidence"
          : "reviewed_candidate",
  };
}
