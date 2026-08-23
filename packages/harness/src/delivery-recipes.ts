import type { RunStepSeed } from "./recipe.js";

export interface DeliveryRecipe {
  name: "import-analysis" | "style-extraction";
  version: 1;
  steps: readonly RunStepSeed[];
}

export function buildImportAnalysisRecipe(runId: string): DeliveryRecipe {
  return {
    name: "import-analysis",
    version: 1,
    steps: [
      {
        id: `${runId}:import.analyze`,
        ordinal: 0,
        kind: "import.analyze",
        cycle: 0,
        idempotencyKey: `${runId}/import.analyze`,
        maxAttempts: 5,
      },
      {
        id: `${runId}:import.stage`,
        ordinal: 1,
        kind: "import.stage",
        cycle: 0,
        idempotencyKey: `${runId}/import.stage`,
        maxAttempts: 1,
      },
    ],
  };
}

/** 贴样文提炼风格档案：单步 run，产物是一条未启用的 style profile 草稿。 */
export function buildStyleExtractionRecipe(runId: string): DeliveryRecipe {
  return {
    name: "style-extraction",
    version: 1,
    steps: [
      {
        id: `${runId}:style.extract`,
        ordinal: 0,
        kind: "style.extract",
        cycle: 0,
        idempotencyKey: `${runId}/style.extract`,
        maxAttempts: 3,
      },
    ],
  };
}
