import { createProject } from "@narralume/domain";
import { NodeNarrativeDatabase } from "../src/node.js";
import { buildChapterRecipe } from "@narralume/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SqliteLlmCallRepository,
  SqliteModelRepository,
  SqliteProjectRepository,
  SqliteProviderRepository,
  SqliteRunRepository,
  SqliteRunStreamRepository,
} from "../src/index.js";
import { migration001 } from "../src/migrations/001-foundation.js";
import { migration002 } from "../src/migrations/002-story-kernel.js";
import { migration003 } from "../src/migrations/003-harness.js";
import { migration004 } from "../src/migrations/004-autopilot.js";
import { migration005 } from "../src/migrations/005-cocreate-studio.js";
import { migration006 } from "../src/migrations/006-delivery.js";
import { migration007 } from "../src/migrations/007-editing-safety.js";
import { migration008 } from "../src/migrations/008-canon-fact-withdrawals.js";
import { migration009 } from "../src/migrations/009-review-workspace.js";
import { migration010 } from "../src/migrations/010-run-streams.js";
import { migration011 } from "../src/migrations/011-long-novel-intelligence.js";
import { migration012 } from "../src/migrations/012-product-lifecycle.js";
import { migration013 } from "../src/migrations/013-resilient-import-analysis.js";
import { migration014 } from "../src/migrations/014-data-safety.js";

const now = "2026-08-10T00:00:00.000Z";
const later = "2026-08-10T01:02:03.000Z";
let database: NodeNarrativeDatabase;
let calls: SqliteLlmCallRepository;
let streams: SqliteRunStreamRepository;
let stepId: string;

beforeEach(() => {
  database = new NodeNarrativeDatabase();
  database.migrate();
  new SqliteProjectRepository(database).insert(
    createProject({ id: "p1", title: "潮汐灯塔", now }),
  );
  new SqliteProviderRepository(database).upsert({
    id: "profile",
    name: "test",
    wireApi: "openai-chat",
    baseUrl: "https://api.example.com/v1",
    endpoint: null,
    credentialRef: "env:TEST_KEY",
    anthropicVersion: null,
    headers: {},
    queryParams: {},
    requestStartTimeoutMs: null,
    streamIdleTimeoutMs: null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  new SqliteModelRepository(database).upsert({
    id: "profile",
    providerId: "profile",
    modelId: "test-model",
    taskType: "writing",
    contextWindow: null,
    maxOutputTokens: null,
    sampling: {},
    capabilities: {},
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  const runs = new SqliteRunRepository(database);
  const recipe = buildChapterRecipe("run-1", 1);
  runs.create({
    id: "run-1",
    projectId: "p1",
    recipe: recipe.name,
    recipeVersion: recipe.version,
    mode: "autopilot",
    targetOutlineNodeId: null,
    policy: {},
    budgetLimit: {
      maxInputTokens: 100_000,
      maxOutputTokens: 50_000,
      maxCalls: 50,
      maxCostUsd: null,
      maxWallTimeMs: 3_600_000,
    },
    steps: recipe.steps,
    now,
  });
  stepId = recipe.steps[0]!.id;
  runs.startStep("run-1", stepId, now);
  calls = new SqliteLlmCallRepository(database);
  streams = new SqliteRunStreamRepository(database);
});

afterEach(() => database.close());

function startCall(id: string) {
  calls.start({
    id,
    projectId: "p1",
    runId: "run-1",
    stepId,
    modelId: "profile",
    protocol: "openai-chat",
    model: "test-model",
    purpose: "draft",
    requestHash: `hash-${id}`,
    startedAt: now,
  });
}

describe("SqliteLlmCallRepository.interruptOrphaned", () => {
  it("interrupts in-flight calls, keeps started_at, leaves terminal rows alone", () => {
    startCall("call-started");
    startCall("call-streaming");
    database.raw
      .prepare("UPDATE llm_calls SET status = 'streaming' WHERE id = ?")
      .run("call-streaming");
    startCall("call-completed");
    calls.complete("call-completed", {
      finishReason: "stop",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      },
      durationMs: 5,
      finishedAt: now,
    });
    startCall("call-failed");
    calls.fail("call-failed", { code: "x" }, 5, now);

    expect(calls.interruptOrphaned(later)).toBe(2);

    const byId = new Map(
      calls.listForRun("run-1").map((call) => [call.id, call]),
    );
    expect(byId.get("call-started")).toMatchObject({
      status: "interrupted",
      startedAt: now,
      finishedAt: later,
    });
    expect(byId.get("call-streaming")).toMatchObject({
      status: "interrupted",
      startedAt: now,
      finishedAt: later,
    });
    expect(byId.get("call-completed")?.status).toBe("completed");
    expect(byId.get("call-failed")?.status).toBe("failed");
    expect(calls.interruptOrphaned(later)).toBe(0);
  });
});

describe("SqliteRunStreamRepository.interruptOrphaned", () => {
  it("interrupts streaming attempts only", () => {
    streams.appendText("run-1", stepId, "雾", now);
    streams.interruptOrphaned(later);
    const interrupted = streams.listForRun("run-1");
    expect(interrupted).toEqual([
      expect.objectContaining({
        status: "interrupted",
        content: "雾",
        updatedAt: later,
      }),
    ]);

    streams.appendText("run-1", stepId, "港", later);
    streams.markStatus("run-1", stepId, "completed", later);
    expect(streams.interruptOrphaned(later)).toBe(0);
    expect(streams.listForRun("run-1")[0]?.status).toBe("completed");
  });
});

describe("migration 015 (llm-call-interruption)", () => {
  it("rebuilds llm_calls without losing referencing rows", () => {
    const legacy = new NodeNarrativeDatabase();
    try {
      legacy.migrate([
        migration001,
        migration002,
        migration003,
        migration004,
        migration005,
        migration006,
        migration007,
        migration008,
        migration009,
        migration010,
        migration011,
        migration012,
        migration013,
        migration014,
      ]);
      expect(legacy.currentMigration()).toBe(14);
      new SqliteProjectRepository(legacy).insert(
        createProject({ id: "p1", title: "潮汐灯塔", now }),
      );
      legacy.raw
        .prepare(
          `INSERT INTO model_profiles(
             id, name, protocol, base_url, endpoint, model, api_key_env,
             anthropic_version, extra_headers_json, capabilities_json,
             enabled, created_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, '{}', '{}', 1, ?, ?)`,
        )
        .run(
          "profile",
          "test",
          "openai-chat",
          "https://api.example.com/v1",
          "test-model",
          "TEST_KEY",
          now,
          now,
        );
      legacy.raw
        .prepare(
          `INSERT INTO llm_calls(
            id, project_id, profile_id, protocol, model, purpose, request_hash,
            status, started_at
          ) VALUES ('c1', 'p1', 'profile', 'openai-chat', 'm', 'draft', 'h', 'completed', ?)`,
        )
        .run(now);
      legacy.raw
        .prepare(
          `INSERT INTO tool_calls(
            id, llm_call_id, name, arguments_hash, permission, status, created_at
          ) VALUES ('t1', 'c1', 'tool', 'ah', 'auto', 'succeeded', ?)`,
        )
        .run(now);
      const legacyRuns = new SqliteRunRepository(legacy);
      const recipe = buildChapterRecipe("run-1", 1);
      legacyRuns.create({
        id: "run-1",
        projectId: "p1",
        recipe: recipe.name,
        recipeVersion: recipe.version,
        mode: "autopilot",
        targetOutlineNodeId: null,
        policy: {},
        budgetLimit: {
          maxInputTokens: 100_000,
          maxOutputTokens: 50_000,
          maxCalls: 50,
          maxCostUsd: null,
          maxWallTimeMs: 3_600_000,
        },
        steps: recipe.steps,
        now,
      });
      legacy.raw
        .prepare(
          `INSERT INTO run_budget_entries(run_id, step_id, call_id, created_at)
           VALUES ('run-1', NULL, 'c1', ?)`,
        )
        .run(now);

      legacy.migrate();
      expect(legacy.currentMigration()).toBe(44);

      const tool = legacy.raw
        .prepare("SELECT llm_call_id FROM tool_calls WHERE id = 't1'")
        .get() as { llm_call_id: string | null };
      const budget = legacy.raw
        .prepare("SELECT call_id FROM run_budget_entries")
        .get() as { call_id: string | null };
      expect(tool.llm_call_id).toBe("c1");
      expect(budget.call_id).toBe("c1");
      expect(legacy.raw.prepare("PRAGMA foreign_key_check").all()).toHaveLength(
        0,
      );

      legacy.raw
        .prepare("UPDATE llm_calls SET status = 'interrupted' WHERE id = 'c1'")
        .run();
      const call = legacy.raw
        .prepare("SELECT status, started_at FROM llm_calls WHERE id = 'c1'")
        .get() as { status: string; started_at: string };
      expect(call).toEqual({ status: "interrupted", started_at: now });
    } finally {
      legacy.close();
    }
  });
});
