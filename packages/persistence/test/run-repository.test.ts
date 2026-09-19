import { createProject } from "@narralume/domain";
import { NodeNarrativeDatabase } from "../src/node.js";
import { buildChapterRecipe, HarnessSupervisor } from "@narralume/harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SqliteProjectRepository,
  SqliteRunRepository,
  SqliteRunStreamRepository,
} from "../src/index.js";

const now = "2026-08-10T00:00:00.000Z";
let database: NodeNarrativeDatabase;
let runs: SqliteRunRepository;

beforeEach(() => {
  database = new NodeNarrativeDatabase();
  database.migrate();
  new SqliteProjectRepository(database).insert(
    createProject({ id: "p1", title: "潮汐灯塔", now }),
  );
  runs = new SqliteRunRepository(database);
});

afterEach(() => database.close());

describe("SqliteRunRepository", () => {
  it("publishes events only after the outer transaction commits", () => {
    seedRun(0);
    const repositoryEvents: string[] = [];
    const databaseEvents: string[] = [];
    const persistedCounts: number[] = [];
    runs.setEventListener((event) => repositoryEvents.push(event.type));
    const unsubscribe = database.onRunEvent((event) => {
      databaseEvents.push(event.type);
      persistedCounts.push(
        (
          database.raw
            .prepare(
              "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = ?",
            )
            .get(event.runId, event.type) as { count: number }
        ).count,
      );
    });

    database.transaction(() => {
      runs.appendRunEvent("run-1", null, "probe.committed", {}, now);
      expect(repositoryEvents).toEqual([]);
      expect(databaseEvents).toEqual([]);
    });

    expect(repositoryEvents).toEqual(["probe.committed"]);
    expect(databaseEvents).toEqual(["probe.committed"]);
    expect(persistedCounts).toEqual([1]);
    unsubscribe();
  });

  it("discards pending event notifications when an outer transaction rolls back", () => {
    seedRun(0);
    const events: string[] = [];
    runs.setEventListener((event) => events.push(event.type));
    const unsubscribe = database.onRunEvent((event) => events.push(event.type));

    expect(() =>
      database.transaction(() => {
        runs.appendRunEvent("run-1", null, "probe.ghost", {}, now);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");

    expect(events).toEqual([]);
    expect(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = ?",
        )
        .get("run-1", "probe.ghost"),
    ).toEqual({ count: 0 });
    unsubscribe();
  });

  it("leases atomically, records hashed artifacts, checkpoints, usage, and events", () => {
    seedRun(1);
    const lease = runs.leaseNext("worker-a", now, 30_000);
    expect(lease).toEqual({ runId: "run-1", leaseOwner: "worker-a" });
    expect(runs.leaseNext("worker-b", now, 30_000)).toBeNull();

    const step = runs.startStep("run-1", "run-1:context", now);
    expect(step).toMatchObject({ status: "running", attempt: 1 });
    const streams = new SqliteRunStreamRepository(database);
    streams.appendText("run-1", step.id, "雾", now);
    streams.appendText("run-1", step.id, "港", now);
    streams.markStatus("run-1", step.id, "completed", now);
    expect(streams.listForRun("run-1")).toEqual([
      expect.objectContaining({
        stepId: step.id,
        attempt: 1,
        content: "雾港",
        status: "completed",
      }),
    ]);
    expect(streams.discard("run-1", step.id, step.attempt)).toBe(true);
    expect(streams.listForRun("run-1")).toEqual([]);
    runs.succeedStep(
      "run-1",
      step.id,
      { receiptId: "receipt-1", compiledHash: "abc" },
      "context",
      now,
      [{ kind: "lore-activation", output: { activated: ["entry-1"] } }],
    );
    runs.recordBudget(
      "run-1",
      step.id,
      {
        inputTokens: 120,
        outputTokens: 0,
        calls: 0,
        costUsd: 0,
        wallTimeMs: 15,
      },
      now,
    );
    runs.finishLease("run-1", "worker-a", { requeue: true }, now);

    const snapshot = runs.getSnapshot("run-1");
    expect(
      database.raw
        .prepare(
          "SELECT kind, content_json FROM run_artifacts WHERE run_id = ? ORDER BY kind",
        )
        .all("run-1"),
    ).toEqual([
      {
        kind: "context",
        content_json: JSON.stringify({
          compiledHash: "abc",
          receiptId: "receipt-1",
        }),
      },
      {
        kind: "lore-activation",
        content_json: JSON.stringify({ activated: ["entry-1"] }),
      },
    ]);
    expect(snapshot.steps[0]).toMatchObject({
      status: "succeeded",
      outputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(snapshot.latestCheckpoint).toMatchObject({
      kind: "after:context.compile",
      stateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(snapshot.run.budgetUsage).toMatchObject({
      inputTokens: 120,
      wallTimeMs: 15,
    });
    expect(snapshot.events.map((event) => event.sequence)).toEqual(
      snapshot.events.map((_, index) => index),
    );
  });

  it("recovers expired leases and persists pause/resume/cancel commands", () => {
    seedRun(0);
    runs.leaseNext("dead-worker", now, 1_000);
    expect(runs.recoverExpiredLeases("2026-08-10T00:00:02.000Z")).toBe(1);
    expect(
      runs.leaseNext("worker-b", "2026-08-10T00:00:02.000Z", 1_000),
    ).toMatchObject({ leaseOwner: "worker-b" });
    runs.requestPause("run-1", "2026-08-10T00:00:02.100Z");
    runs.finishLease(
      "run-1",
      "worker-b",
      { requeue: true },
      "2026-08-10T00:00:02.200Z",
    );
    const lease = runs.leaseNext("worker-c", "2026-08-10T00:00:02.300Z", 1_000);
    expect(lease).not.toBeNull();
    runs.setRunStatus(
      "run-1",
      "paused",
      "2026-08-10T00:00:02.400Z",
      "requested",
    );
    runs.finishLease(
      "run-1",
      "worker-c",
      { requeue: false },
      "2026-08-10T00:00:02.500Z",
    );
    runs.resume("run-1", "2026-08-10T00:00:03.000Z");
    expect(runs.getRun("run-1")?.status).toBe("running");
    runs.requestCancel("run-1", "2026-08-10T00:00:03.100Z");
    expect(runs.getRun("run-1")?.cancelRequested).toBe(true);
  });

  it("turns an orphaned running step into a retryable failure", () => {
    seedRun(0);
    expect(runs.leaseNext("dead-worker", now, 1_000)).not.toBeNull();
    runs.startStep("run-1", "run-1:context", now);

    expect(runs.recoverExpiredLeases("2026-08-10T00:00:02.000Z")).toBe(1);
    const recovered = runs.getSnapshot("run-1");
    expect(recovered.run).toMatchObject({
      status: "failed_recoverable",
      currentStepId: null,
    });
    expect(recovered.steps[0]).toMatchObject({
      status: "failed",
      attempt: 1,
      error: { code: "run.lease_expired", retryable: true },
    });
    expect(
      recovered.events.some(
        (event) => event.type === "step.recovered_after_lease_expiry",
      ),
    ).toBe(true);
    expect(
      runs.leaseNext("replacement-worker", "2026-08-10T00:00:02.100Z", 1_000),
    ).not.toBeNull();
  });

  it("renews a live lease so it cannot be reclaimed at its original deadline", () => {
    seedRun(0);
    expect(runs.leaseNext("worker-a", now, 1_000)).not.toBeNull();
    expect(
      runs.renewLease("run-1", "worker-a", "2026-08-10T00:00:00.800Z", 1_000),
    ).toBe(true);
    expect(runs.recoverExpiredLeases("2026-08-10T00:00:01.100Z")).toBe(0);
    expect(
      runs.renewLease(
        "run-1",
        "different-worker",
        "2026-08-10T00:00:01.200Z",
        1_000,
      ),
    ).toBe(false);
  });

  it("drives an entire no-revision recipe through registered workers", async () => {
    seedRun(0);
    const executed: string[] = [];
    const worker = {
      execute: vi.fn(async (_snapshot, step) => {
        executed.push(step.kind);
        return {
          output:
            step.kind === "deterministic.check" ||
            step.kind === "semantic.review"
              ? { verdict: "pass", issues: [] }
              : { kind: step.kind, ok: true },
          artifactKind: step.kind,
          usage: {
            inputTokens: step.kind.includes("generate") ? 10 : 0,
            outputTokens: step.kind.includes("generate") ? 20 : 0,
            calls: step.kind.includes("generate") ? 1 : 0,
            costUsd: 0,
            wallTimeMs: 1,
          },
        };
      }),
    };
    const supervisor = new HarnessSupervisor(
      runs,
      {
        "context.compile": worker,
        "scene.plan": worker,
        "draft.generate": worker,
        "deterministic.check": worker,
        "semantic.review": worker,
        "revision.generate": worker,
        "chapter.settle": worker,
        "chapter.commit": worker,
      },
      { now: () => new Date(now), leaseMs: 30_000 },
    );

    for (let index = 0; index < 20; index += 1) {
      if (!(await supervisor.processNext("worker-a"))) break;
    }
    expect(runs.getRun("run-1")?.status).toBe("completed");
    expect(executed).toEqual([
      "context.compile",
      "scene.plan",
      "draft.generate",
      "deterministic.check",
      "semantic.review",
      "chapter.settle",
      "chapter.commit",
    ]);
    expect(
      runs
        .getSnapshot("run-1")
        .steps.every((step) => step.status === "succeeded"),
    ).toBe(true);
  });

  it("charges failed model work to the run budget", async () => {
    seedRun(0);
    const supervisor = new HarnessSupervisor(
      runs,
      {
        "context.compile": {
          execute: async () => {
            throw {
              code: "model.structured_output",
              message: "结构化输出失败",
              retryable: false,
              usage: {
                inputTokens: 500,
                outputTokens: 800,
                calls: 3,
                costUsd: 0,
                wallTimeMs: 2_000,
              },
            };
          },
        },
      },
      { now: () => new Date(now) },
    );

    await supervisor.processRun("run-1", "worker-a");

    expect(
      database.raw
        .prepare("SELECT last_error_json FROM run_jobs WHERE run_id = ?")
        .get("run-1"),
    ).toEqual({ last_error_json: null });
    expect(runs.getSnapshot("run-1").steps[0]?.error).toMatchObject({
      code: "model.structured_output",
      usage: { calls: 3 },
    });
    expect(runs.getRun("run-1")?.budgetUsage).toEqual({
      inputTokens: 500,
      outputTokens: 800,
      calls: 3,
      costUsd: 0,
      wallTimeMs: 2_000,
    });
  });
});

function seedRun(maxRevisionCycles: number) {
  const recipe = buildChapterRecipe("run-1", maxRevisionCycles);
  return runs.create({
    id: "run-1",
    projectId: "p1",
    recipe: recipe.name,
    recipeVersion: recipe.version,
    mode: "autopilot",
    targetOutlineNodeId: null,
    policy: { maxRevisionCycles },
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
}
