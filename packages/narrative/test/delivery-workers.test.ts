import { createProject } from "@narralume/domain";
import {
  buildImportAnalysisRecipe,
  buildStyleExtractionRecipe,
  HarnessSupervisor,
} from "@narralume/harness";
import {
  SqliteDeliveryRepository,
  SqliteProjectRepository,
  SqliteRunRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeliveryWorkerSuite } from "../src/delivery-workers.js";
import type { NarrativeModelClient } from "../src/model-client.js";

const now = "2026-08-10T00:00:00.000Z";
// Mutable clock: step retries are scheduled with a backoff delay, so tests
// that drive the supervisor manually must advance time between attempts.
let clockMs = Date.parse(now);
const clockNow = () => new Date(clockMs).toISOString();
let database: NodeNarrativeDatabase;
let delivery: SqliteDeliveryRepository;
let runs: SqliteRunRepository;

beforeEach(() => {
  database = new NodeNarrativeDatabase();
  database.migrate();
  new SqliteProjectRepository(database).insert(
    createProject({ id: "p1", title: "Long Import", now }),
  );
  delivery = new SqliteDeliveryRepository(database);
  const content = `${"A".repeat(9_000)}\n\n${"B".repeat(9_000)}\n\n${"C".repeat(9_000)}`;
  delivery.insertImportBatch({
    id: "batch-1",
    targetProjectId: "p1",
    filename: "long.txt",
    format: "text",
    sourceHash: "source-hash",
    sourceCharacters: content.length,
    status: "analyzing",
    metadata: {},
    analysisRunId: null,
    appliedProjectId: null,
    createdAt: now,
    updatedAt: now,
  });
  delivery.upsertImportCandidate({
    id: "batch-1:document:0",
    batchId: "batch-1",
    kind: "document",
    ordinal: 0,
    title: "Long",
    payload: { content },
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  const recipe = buildImportAnalysisRecipe("run-1");
  runs = new SqliteRunRepository(database);
  runs.create({
    id: "run-1",
    projectId: "p1",
    recipe: recipe.name,
    recipeVersion: recipe.version,
    mode: "manual",
    targetOutlineNodeId: null,
    policy: {
      batchId: "batch-1",
      importChunkCharacters: 10_000,
      analysisMaxOutputTokens: 2_000,
    },
    budgetLimit: {
      maxInputTokens: 1_000_000,
      maxOutputTokens: 100_000,
      maxCalls: 20,
      maxCostUsd: null,
      maxWallTimeMs: 600_000,
    },
    steps: recipe.steps,
    now,
  });
  delivery.updateImportBatch(
    "batch-1",
    { status: "analyzing", analysisRunId: "run-1" },
    now,
  );
});

afterEach(() => database.close());

describe("DeliveryWorkerSuite", () => {
  it("resumes a multi-chunk import from InputDigest artifacts without truncation", async () => {
    const purposes: string[] = [];
    let failedOnce = false;
    let active = 0;
    let maxActive = 0;
    const model: NarrativeModelClient = {
      async text() {
        throw new Error("unused");
      },
      structured: vi.fn(
        async (_run, _step, purpose, _request, _contract, validate) => {
          purposes.push(purpose);
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            await Promise.resolve();
            if (purpose === "import-analysis-chunk-2" && !failedOnce) {
              failedOnce = true;
              throw {
                code: "model.network",
                message: "temporary failure",
                retryable: true,
              };
            }
            const checked = validate(minimalAnalysis());
            if (!checked.success) throw new Error(checked.issues.join("; "));
            return {
              value: checked.data,
              usage: {
                inputTokens: 100,
                outputTokens: 100,
                calls: 1,
                costUsd: 0,
                wallTimeMs: 10,
              },
              mode: "native" as const,
              attempts: 1,
            };
          } finally {
            active -= 1;
          }
        },
      ),
    };
    const supervisor = new HarnessSupervisor(
      runs,
      new DeliveryWorkerSuite(database, model, () => new Date(now)).registry(),
      { now: () => new Date(clockNow()), retryDelayMs: 0 },
    );

    await supervisor.processRun("run-1", "worker");
    expect(runs.getSnapshot("run-1").steps[0]).toMatchObject({
      status: "failed",
      error: { retryable: true },
    });
    const persistedAfterFailure =
      delivery.listImportAnalysisArtifacts("batch-1").length;
    expect(persistedAfterFailure).toBeGreaterThanOrEqual(1);
    expect(persistedAfterFailure).toBeLessThanOrEqual(2);

    for (let index = 0; index < 12; index += 1) {
      clockMs += 5_000;
      await supervisor.processRun("run-1", "worker");
      if (runs.getRun("run-1")?.status === "completed") break;
    }
    expect(runs.getRun("run-1")?.status).toBe("completed");
    expect(maxActive).toBe(2);
    expect(
      purposes.filter((purpose) => purpose === "import-analysis-chunk-1"),
    ).toHaveLength(1);
    expect(delivery.listImportAnalysisArtifacts("batch-1")).toHaveLength(5);
    const analysis = runs
      .getSnapshot("run-1")
      .steps.find((step) => step.kind === "import.analyze")?.outputArtifact;
    expect(analysis?.importPipeline).toMatchObject({
      sourceCharacters: expect.any(Number),
      chunks: 3,
      synthesisStages: 2,
      reusedArtifacts: persistedAfterFailure,
    });
    expect(
      (analysis?.importPipeline as { sourceCharacters: number })
        .sourceCharacters,
    ).toBeGreaterThan(27_000);
  });

  it("distills a writing sample into an inactive draft profile with a deduped name", async () => {
    delivery.insertStyleProfile({
      id: "style-existing",
      projectId: "p1",
      name: "冷峻短句",
      description: "既有档案",
      rules: ["短句为主"],
      examples: [],
      negativeRules: [],
      source: "manual",
      active: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
      version: 0,
    });
    const sampleText = "雨下了一整夜，码头只剩一盏灯亮着。".repeat(20);
    const model: NarrativeModelClient = {
      async text() {
        throw new Error("unused");
      },
      structured: vi.fn(
        async (_run, _step, purpose, request, _contract, validate) => {
          expect(purpose).toBe("style-extract");
          expect(String(request.messages[0]?.content)).toContain("雨下了一整夜");
          const checked = validate({
            name: "冷峻短句",
            description: "克制、以动作推进的语感。",
            rules: ["叙述句短，转折压得更短", "情绪只从动作和物件里出来"],
            negativeRules: ["不用感叹句收尾"],
            examples: ["他把杯子放下，没说话。"],
          });
          if (!checked.success) throw new Error(checked.issues.join("; "));
          return {
            value: checked.data,
            usage: {
              inputTokens: 10,
              outputTokens: 10,
              calls: 1,
              costUsd: 0,
              wallTimeMs: 5,
            },
            mode: "native" as const,
            attempts: 1,
          };
        },
      ),
    };
    const recipe = buildStyleExtractionRecipe("run-2");
    runs.create({
      id: "run-2",
      projectId: "p1",
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "manual",
      targetOutlineNodeId: null,
      policy: {
        sourceText: sampleText,
        creationRequestId: "req-1",
        creationRequestHash: "hash",
      },
      budgetLimit: {
        maxInputTokens: 1_000_000,
        maxOutputTokens: 100_000,
        maxCalls: 20,
        maxCostUsd: null,
        maxWallTimeMs: 600_000,
      },
      steps: recipe.steps,
      now,
    });
    const supervisor = new HarnessSupervisor(
      runs,
      new DeliveryWorkerSuite(database, model, () => new Date(now)).registry(),
      { now: () => new Date(now), retryDelayMs: 0 },
    );

    for (let index = 0; index < 5; index += 1) {
      await supervisor.processRun("run-2", "worker");
      if (runs.getRun("run-2")?.status === "completed") break;
    }
    expect(runs.getRun("run-2")?.status).toBe("completed");
    const profiles = delivery.listStyleProfiles("p1", true);
    const draft = profiles.find((profile) => profile.source === "extract:run-2");
    expect(draft).toMatchObject({
      name: "冷峻短句 2",
      active: false,
      status: "active",
    });
    // 提炼草稿不得挤掉作者已启用的档案。
    expect(
      profiles.find((profile) => profile.id === "style-existing"),
    ).toMatchObject({ active: true });
  });
});

function minimalAnalysis() {
  return {
    title: "Imported",
    synopsis: "A complete import analysis.",
    themes: [],
    audience: "general",
    tone: "restrained",
    boundaries: [],
    entities: [],
    style: {
      name: "Imported style",
      description: "Evidence-led prose.",
      rules: ["Prefer concrete action", "Keep causality explicit"],
      negativeRules: [],
      examples: [],
    },
    skills: [],
    relationships: [],
    timeline: [],
    foreshadows: [],
    characterArcs: [],
    scenes: [],
  };
}
