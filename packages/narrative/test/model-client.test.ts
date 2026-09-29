import { createProject } from "@narralume/domain";
import { buildChapterRecipe } from "@narralume/harness";
import type { AssignmentRole, ModelTaskType } from "@narralume/domain";
import {
  SqliteAssignmentRepository,
  SqliteModelRepository,
  SqliteProjectRepository,
  SqliteProviderRepository,
  SqliteRunRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GatewayNarrativeModelClient,
  optionalEmbeddings,
} from "../src/index.js";

const NOW = "2026-08-11T00:00:00.000Z";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function seedAssignment(
  database: NodeNarrativeDatabase,
  input: {
    role?: AssignmentRole;
    taskType?: ModelTaskType;
    modelRowId?: string;
    modelId?: string;
    providerId?: string;
    credentialRef?: string;
    contextWindow?: number | null;
    maxOutputTokens?: number | null;
    providerEnabled?: boolean;
    modelEnabled?: boolean;
  } = {},
): void {
  const role = input.role ?? "writing";
  const providerId = input.providerId ?? `provider-${role}`;
  const modelRowId = input.modelRowId ?? `model-${role}`;
  new SqliteProviderRepository(database).upsert({
    id: providerId,
    name: providerId,
    wireApi: "openai-chat",
    baseUrl: `https://${providerId}.example/v1`,
    endpoint: null,
    credentialRef: input.credentialRef ?? "raw-secret-key-123456",
    anthropicVersion: null,
    headers: {},
    queryParams: {},
    requestStartTimeoutMs: null,
    streamIdleTimeoutMs: null,
    enabled: input.providerEnabled ?? true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  new SqliteModelRepository(database).upsert({
    id: modelRowId,
    providerId,
    modelId: input.modelId ?? `${role}-wire-model`,
    taskType: input.taskType ?? role,
    contextWindow:
      input.contextWindow === undefined ? 128_000 : input.contextWindow,
    maxOutputTokens:
      input.maxOutputTokens === undefined ? 32_000 : input.maxOutputTokens,
    sampling: { temperature: 0.4 },
    capabilities: {},
    enabled: input.modelEnabled ?? true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  new SqliteAssignmentRepository(database).set(role, modelRowId, NOW);
}

function createRun(
  database: NodeNarrativeDatabase,
  id: string,
  policy: Record<string, unknown> = {},
) {
  const projectId = `${id}-project`;
  new SqliteProjectRepository(database).insert(
    createProject({ id: projectId, title: "远潮", now: NOW }),
  );
  const recipe = buildChapterRecipe(id, 0);
  const runs = new SqliteRunRepository(database);
  runs.create({
    id,
    projectId,
    recipe: recipe.name,
    recipeVersion: recipe.version,
    mode: "manual",
    targetOutlineNodeId: null,
    policy: {
      contextWindow: 128_000,
      draftMaxOutputTokens: 32_000,
      reviewMaxOutputTokens: 24_000,
      planningMaxOutputTokens: 24_000,
      settlementMaxOutputTokens: 24_000,
      logicalCallDeadlineMs: 60_000,
      maxRepairAttempts: 1,
      explicitPolicyFields: [],
      ...policy,
    },
    steps: recipe.steps,
    now: NOW,
  });
  runs.leaseNext("worker", NOW, 30_000);
  const step = runs.startStep(id, `${id}:context`, NOW);
  return { runs, step };
}

function chatResponse(text = "续写", finishReason = "stop"): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      choices: [{ message: { content: text }, finish_reason: finishReason }],
      usage: { prompt_tokens: 18, completion_tokens: 3, total_tokens: 21 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("GatewayNarrativeModelClient B1 assignment runtime", () => {
  it("uses only the role assignment and persists masked model/applied snapshots", async () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database, {
      modelRowId: "model-a",
      modelId: "assigned-model",
    });
    const { runs, step } = createRun(database, "run-a");
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        requests.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return chatResponse("assignment 链路");
      }),
    );

    const result = await new GatewayNarrativeModelClient(database, {}).text(
      runs.getRun("run-a")!,
      step,
      "chapter-draft",
      {
        messages: [{ role: "user", content: "继续" }],
        maxOutputTokens: 3_000,
      },
      new AbortController().signal,
    );

    expect(result.text).toBe("assignment 链路");
    expect(requests[0]).toMatchObject({
      model: "assigned-model",
      max_tokens: 32_000,
    });
    const snapshot = database.raw
      .prepare(
        `SELECT requested_role, assignment_role, model_id, provider_json,
                model_json, applied_json
         FROM model_assignment_snapshots WHERE run_id = ?`,
      )
      .get("run-a") as Record<string, string>;
    expect(snapshot).toMatchObject({
      requested_role: "drafting",
      assignment_role: "writing",
      model_id: "model-a",
    });
    expect(JSON.parse(snapshot.provider_json)).toMatchObject({
      credentialRef: "••••3456",
    });
    expect(JSON.parse(snapshot.applied_json)).toMatchObject({
      modelContextWindow: 128_000,
      modelMaxOutputTokens: 32_000,
      maxOutputTokens: 32_000,
      maxOutputTokensAppliedBy: ["model"],
      modelMetadataSource: "manual",
      timeoutPolicy: {
        requestStartTimeoutMs: { value: 120_000, source: "built-in" },
        streamIdleTimeoutMs: { value: 120_000, source: "built-in" },
      },
    });
    expect(JSON.parse(snapshot.model_json)).toMatchObject({
      metadataSource: "manual",
      metadataVerifiedAt: null,
    });
    expect(
      database.raw
        .prepare(
          "SELECT model_id, model, details_json FROM llm_calls WHERE run_id = ?",
        )
        .get("run-a"),
    ).toMatchObject({ model_id: "model-a", model: "assigned-model" });
    const details = JSON.parse(
      (
        database.raw
          .prepare("SELECT details_json FROM llm_calls WHERE run_id = ?")
          .get("run-a") as { details_json: string }
      ).details_json,
    ) as Record<string, unknown>;
    expect(details).toMatchObject({
      estimatedInputTokens: expect.any(Number),
      actualInputTokens: 18,
      inputEstimateErrorTokens: expect.any(Number),
    });
    database.close();
  });

  it("rejects unknown physical capacity before sending a request", async () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database, {
      contextWindow: null,
      maxOutputTokens: null,
    });
    const { runs, step } = createRun(database, "run-unknown-limits", {
      contextWindow: 64_000,
      draftMaxOutputTokens: 12_000,
    });
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        requests.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return chatResponse("未知上限仍可调用");
      }),
    );

    await expect(
      new GatewayNarrativeModelClient(database, {}).text(
        runs.getRun("run-unknown-limits")!,
        step,
        "chapter-draft",
        {
          messages: [{ role: "user", content: "继续" }],
          maxOutputTokens: 20_000,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "model.capacity_unknown" });

    expect(requests).toHaveLength(0);
    database.close();
  });

  it.each([
    [32_000, 32_000],
    [128_000, 128_000],
    [256_000, 256_000],
    [1_000_000, 1_000_000],
  ])(
    "uses the configured %i physical context window %i",
    (physical, expected) => {
      const database = new NodeNarrativeDatabase();
      database.migrate();
      seedAssignment(database, {
        contextWindow: physical,
        maxOutputTokens: 64_000,
      });
      const { runs } = createRun(database, `run-context-${physical}`, {
        contextWindow: 256_000,
      });
      const client = new GatewayNarrativeModelClient(database, {});
      expect(
        client.effectiveContextWindow(
          runs.getRun(`run-context-${physical}`)!,
          "chapter-draft",
        ),
      ).toBe(expected);
      database.close();
    },
  );

  it("uses a 1M model window when the run explicitly requests 1M", () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database, {
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
    });
    const { runs } = createRun(database, "run-context-million", {
      contextWindow: 1_000_000,
      explicitPolicyFields: ["contextWindow"],
    });
    const client = new GatewayNarrativeModelClient(database, {});
    expect(
      client.effectiveContextWindow(
        runs.getRun("run-context-million")!,
        "chapter-draft",
      ),
    ).toBe(1_000_000);
    database.close();
  });

  it("freezes independent planning, writing, and review assignments for context materialization", () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database, {
      role: "writing",
      taskType: "writing",
      modelRowId: "model-writing",
      modelId: "wire-writing",
    });
    seedAssignment(database, {
      role: "planning",
      taskType: "planning",
      modelRowId: "model-planning",
      modelId: "wire-planning",
    });
    seedAssignment(database, {
      role: "review",
      taskType: "review",
      modelRowId: "model-review",
      modelId: "wire-review",
    });
    const { runs } = createRun(database, "run-purpose-assignments");
    const run = runs.getRun("run-purpose-assignments")!;
    const client = new GatewayNarrativeModelClient(database, {});

    const keys = [
      client.contextMaterializationKey(run, "scene-plan"),
      client.contextMaterializationKey(run, "chapter-draft"),
      client.contextMaterializationKey(run, "semantic-review"),
    ];
    expect(new Set(keys).size).toBe(3);
    expect(
      database.raw
        .prepare(
          `SELECT purpose, requested_role, assignment_role, model_id
           FROM model_assignment_snapshots WHERE run_id = ? ORDER BY purpose`,
        )
        .all(run.id),
    ).toEqual([
      {
        purpose: "chapter-draft",
        requested_role: "drafting",
        assignment_role: "writing",
        model_id: "model-writing",
      },
      {
        purpose: "scene-plan",
        requested_role: "planning",
        assignment_role: "planning",
        model_id: "model-planning",
      },
      {
        purpose: "semantic-review",
        requested_role: "review",
        assignment_role: "review",
        model_id: "model-review",
      },
    ]);
    database.close();
  });

  it("keeps the first per-purpose assignment snapshot across retries", async () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database, {
      providerId: "provider-a",
      modelRowId: "model-a",
      modelId: "wire-a",
    });
    const { runs, step } = createRun(database, "run-frozen-assignment");
    const requestedModels: string[] = [];
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        requestedUrls.push(String(input));
        requestedModels.push(
          String((JSON.parse(String(init?.body)) as { model: string }).model),
        );
        return chatResponse();
      }),
    );
    const client = new GatewayNarrativeModelClient(database, {});
    await client.text(
      runs.getRun("run-frozen-assignment")!,
      step,
      "chapter-draft",
      { messages: [{ role: "user", content: "第一次" }] },
      new AbortController().signal,
    );
    seedAssignment(database, {
      providerId: "provider-b",
      modelRowId: "model-b",
      modelId: "wire-b",
    });
    const models = new SqliteModelRepository(database);
    const original = models.get("model-a")!;
    models.upsert({
      ...original,
      providerId: "provider-b",
      modelId: "wire-a-mutated",
      contextWindow: 32_000,
      maxOutputTokens: 4_000,
      updatedAt: "2026-08-11T01:00:00.000Z",
    });
    expect(
      client.effectiveContextWindow(
        runs.getRun("run-frozen-assignment")!,
        "chapter-draft",
      ),
    ).toBe(128_000);
    expect(
      client.effectiveOutputLimit(
        runs.getRun("run-frozen-assignment")!,
        "chapter-draft",
      ),
    ).toBe(32_000);
    await client.text(
      runs.getRun("run-frozen-assignment")!,
      step,
      "chapter-draft",
      { messages: [{ role: "user", content: "重试" }] },
      new AbortController().signal,
    );

    expect(requestedModels).toEqual(["wire-a", "wire-a"]);
    expect(requestedUrls).toEqual([
      "https://provider-a.example/v1/chat/completions",
      "https://provider-a.example/v1/chat/completions",
    ]);
    database.close();
  });

  it.each(["length", "context_length"] as const)(
    "surfaces the %s finish reason for worker-level recovery",
    async (finishReason) => {
      const database = new NodeNarrativeDatabase();
      database.migrate();
      seedAssignment(database);
      const { runs, step } = createRun(database, "run-output-limit");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => chatResponse("未完正文", finishReason)),
      );
      const result = await new GatewayNarrativeModelClient(database, {}).text(
        runs.getRun("run-output-limit")!,
        step,
        "chapter-draft",
        { messages: [{ role: "user", content: "继续" }] },
        new AbortController().signal,
      );
      expect(result).toMatchObject({ text: "未完正文", finishReason });
      database.close();
    },
  );

  it("falls planning/review back to writing but never falls embedding back", async () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database);
    const assignments = new SqliteAssignmentRepository(database);
    expect(assignments.resolve("planning")?.role).toBe("writing");
    expect(assignments.resolve("review")?.role).toBe("writing");
    expect(assignments.resolve("embedding")).toBeNull();
    const { runs, step } = createRun(database, "run-degrade");
    const outcome = await optionalEmbeddings(
      new GatewayNarrativeModelClient(database, {}),
      runs.getRun("run-degrade")!,
      step,
      "chapter-index",
      ["文本"],
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      vectors: [],
      modelId: null,
      degradation: {
        capability: "embedding",
        reason: "embedding_not_configured",
      },
    });
    database.close();
  });

  it("rejects a missing assignment credential before dispatch", async () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database, { credentialRef: "env:MISSING_MODEL_KEY" });
    const { runs, step } = createRun(database, "run-credential");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new GatewayNarrativeModelClient(database, {}).text(
        runs.getRun("run-credential")!,
        step,
        "chapter-draft",
        { messages: [{ role: "user", content: "继续" }] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "model.credential.missing_env" });
    expect(fetchMock).not.toHaveBeenCalled();
    database.close();
  });

  it("resolves relay:demo credential to a dummy key (D5)", async () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database, { credentialRef: "relay:demo" });
    const { runs, step } = createRun(database, "run-relay");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await new GatewayNarrativeModelClient(database, {}).text(
      runs.getRun("run-relay")!,
      step,
      "chapter-draft",
      { messages: [{ role: "user", content: "继续" }] },
      new AbortController().signal,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    // 浏览器端只持哑 key；中继剥掉它并注入真实 key（真实 key 不在库中）。
    expect(headers.authorization).toBe("Bearer relay:demo");
    database.close();
  });
});
