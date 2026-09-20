import type { RunStepKind } from "@narralume/domain";

import type { RunStepSeed } from "./recipe.js";

export interface AutomationRecipe {
  name:
    | "book-foundation"
    | "rolling-outline"
    | "steer-classification"
    | "closing-review";
  version: 1;
  steps: readonly RunStepSeed[];
}

export function buildFoundationRecipe(runId: string): AutomationRecipe {
  return recipe(runId, "book-foundation", [
    ["generate", "foundation.generate", 5],
    ["stage", "foundation.stage", 1],
  ]);
}

export function buildRollingOutlineRecipe(runId: string): AutomationRecipe {
  return recipe(runId, "rolling-outline", [
    ["generate", "outline.generate", 5],
    ["commit", "outline.commit", 1],
  ]);
}

export function buildSteerClassificationRecipe(
  runId: string,
): AutomationRecipe {
  return recipe(runId, "steer-classification", [
    ["classify", "steer.classify", 5],
  ]);
}

export function buildClosingReviewRecipe(
  runId: string,
  scopes: readonly ("arc" | "volume")[],
): AutomationRecipe {
  return recipe(
    runId,
    "closing-review",
    scopes.map((scope) => [scope, `${scope}.review`, 5]),
  );
}

function recipe(
  runId: string,
  name: AutomationRecipe["name"],
  definitions: readonly [key: string, kind: RunStepKind, maxAttempts: number][],
): AutomationRecipe {
  return {
    name,
    version: 1,
    steps: definitions.map(([key, kind, maxAttempts], ordinal) => ({
      id: `${runId}:${key}`,
      ordinal,
      kind,
      cycle: 0,
      idempotencyKey: `${runId}/${key}`,
      maxAttempts,
    })),
  };
}
