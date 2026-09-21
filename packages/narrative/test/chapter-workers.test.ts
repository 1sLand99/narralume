import {
  createCanonEntity,
  createDocument,
  createOutlineNode,
  createProject,
} from "@narralume/domain";
import { buildChapterRecipe, HarnessSupervisor } from "@narralume/harness";
import {
  SqliteAutomationRepository,
  SqliteCanonRepository,
  SqliteContextReceiptRepository,
  SqliteDeliveryRepository,
  SqliteDocumentRepository,
  SqliteAssignmentRepository,
  SqliteModelRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteProviderRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ChapterWorkerSuite,
  GatewayNarrativeModelClient,
  type NarrativeModelClient,
} from "../src/index.js";

const now = "2026-08-10T00:00:00.000Z";
let database: NodeNarrativeDatabase;
let runs: SqliteRunRepository;
let chapterId: string;

beforeEach(() => {
  database = new NodeNarrativeDatabase();
  database.migrate();
  new SqliteProjectRepository(database).insert(
    createProject({
      id: "p1",
      title: "潮汐灯塔",
      premise: "灯塔熄灭时，港口会遗忘一个人。",
      now,
    }),
  );
  const story = new SqliteStoryRepository(database);
  const root = story.insertOutlineNode(
    createOutlineNode({
      id: "book",
      projectId: "p1",
      parent: null,
      kind: "book",
      ordinal: 0,
      title: "潮汐灯塔",
      now,
    }),
  );
  const chapter = story.insertOutlineNode(
    createOutlineNode({
      id: "chapter-1",
      projectId: "p1",
      parent: root,
      kind: "chapter",
      ordinal: 0,
      title: "雾港失灯",
      summary: "林昼回港当夜，灯塔熄灭。",
      goal: "发现遗忘规则",
      conflict: "父亲否认失踪者存在",
      now,
    }),
  );
  chapterId = chapter.id;
  story.upsertAuthorIntent({
    projectId: "p1",
    promise: "异象必须付出代价。",
    themes: ["记忆", "责任"],
    audience: null,
    tone: "潮湿而克制",
    boundaries: ["不使用廉价失忆反转"],
    endingDirection: null,
    currentFocus: "建立规则",
    lockedFields: ["promise", "boundaries"],
    updatedAt: now,
  });
  new SqliteCanonRepository(database).insertEntity(
    createCanonEntity({
      id: "hero",
      projectId: "p1",
      type: "character",
      name: "林昼",
      description: "守灯人的女儿。",
      now,
    }),
  );
  const delivery = new SqliteDeliveryRepository(database);
  delivery.insertStyleProfile({
    id: "style-active",
    projectId: "p1",
    name: "冷雾短句",
    description: "用动作承载情绪",
    rules: ["段尾留下可观察变化"],
    examples: [],
    negativeRules: ["不解释主题"],
    source: "test",
    active: true,
    status: "active",
    createdAt: now,
    updatedAt: now,
    version: 0,
  });
  delivery.insertWritingSkill({
    id: "skill-chapter",
    projectId: "p1",
    name: "场景证据链",
    description: null,
    instructions: "规则揭示必须包含动作、结果和代价。",
    scopes: ["chapter"],
    priority: 80,
    enabled: true,
    source: "test",
    createdAt: now,
    updatedAt: now,
    version: 0,
  });
  runs = new SqliteRunRepository(database);
});

afterEach(() => database.close());

describe("ChapterWorkerSuite", () => {
  it("checks the order again after asynchronous indexing and lets a fresh run use the new order", async () => {
    const story = new SqliteStoryRepository(database);
    const root = story.requireOutlineNode("p1", "book");
    story.insertOutlineNode(
      createOutlineNode({
        id: "next-chapter",
        projectId: "p1",
        parent: root,
        kind: "chapter",
        ordinal: 1,
        title: "Next",
        now,
      }),
    );
    let reordered = false;
    const model = {
      ...scriptedModel(
        "雾从海面推上石阶。林昼把手按在冰冷的门上，听见灯塔深处传来第三下钟声。\n\n灯灭的一刻，父亲忽然问她为何对着空椅子说话。",
      ),
      hasEmbeddingAssignment: () => true,
      async embed(_run: unknown, _step: unknown, purpose: string) {
        if (purpose === "chapter-index" && !reordered) {
          reordered = true;
          database.transaction(() => {
            story.updateOutlineOrdinal("p1", chapterId, 2, now);
            story.updateOutlineOrdinal("p1", "next-chapter", 0, now);
            story.updateOutlineOrdinal("p1", chapterId, 1, now);
          });
        }
        return {
          vectors: [],
          model: "test",
          modelId: null,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            calls: 0,
            costUsd: 0,
            wallTimeMs: 0,
          },
        };
      },
    } as unknown as NarrativeModelClient;
    const suite = new ChapterWorkerSuite(database, model, () => new Date(now));
    const supervisor = new HarnessSupervisor(runs, suite.registry(), {
      now: () => new Date(now),
    });
    for (const runId of ["old-order", "fresh-order"]) {
      const recipe = buildChapterRecipe(runId, 0);
      runs.create({
        id: runId,
        projectId: "p1",
        recipe: recipe.name,
        recipeVersion: recipe.version,
        mode: "autopilot",
        targetOutlineNodeId: chapterId,
        policy: { minChapterCharacters: 20, chapterApproved: true },
        steps: recipe.steps,
        now,
      });
      for (let index = 0; index < 25; index += 1) {
        if (!(await supervisor.processNext("order-test"))) break;
      }
      const snapshot = runs.getSnapshot(runId);
      if (runId === "old-order") {
        expect(reordered).toBe(true);
        expect(snapshot.run.status).toBe("failed");
        expect(
          snapshot.steps.find((step) => step.kind === "chapter.commit")?.error
            ?.code,
        ).toBe("outline.context.stale");
        expect(new SqliteDocumentRepository(database).list("p1")).toEqual([]);
      } else {
        expect(
          snapshot.run.status,
          JSON.stringify(snapshot.steps.map((step) => step.error)),
        ).toBe("completed");
        expect(new SqliteDocumentRepository(database).list("p1")).toHaveLength(
          1,
        );
      }
    }
  });

  it("produces, reviews, settles, and commits a chapter through the harness", async () => {
    const manuscript =
      "雾从海面推上石阶。林昼把手按在冰冷的门上，听见灯塔深处传来第三下钟声。\n\n灯灭的一刻，父亲忽然问她为何对着空椅子说话。";
    const model = scriptedModel(manuscript, { nearEvidence: true });
    const suite = new ChapterWorkerSuite(database, model, () => new Date(now));
    const recipe = buildChapterRecipe("run-1", 1);
    runs.create({
      id: "run-1",
      projectId: "p1",
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "autopilot",
      targetOutlineNodeId: chapterId,
      policy: {
        maxRevisionCycles: 1,
        minChapterCharacters: 20,
        contextWindow: 8_000,
      },
      budgetLimit: {
        maxInputTokens: 100_000,
        maxOutputTokens: 50_000,
        maxCalls: 20,
        maxCostUsd: null,
        maxWallTimeMs: 60_000,
      },
      steps: recipe.steps,
      now,
    });
    const supervisor = new HarnessSupervisor(runs, suite.registry(), {
      now: () => new Date(now),
    });

    for (let index = 0; index < 30; index += 1) {
      if (!(await supervisor.processNext("worker-test"))) break;
    }

    const snapshot = runs.getSnapshot("run-1");
    expect(
      snapshot.run.status,
      JSON.stringify(snapshot.steps.map((step) => [step.kind, step.error])),
    ).toBe("completed");
    expect(
      snapshot.steps.find((step) => step.kind === "revision.generate")?.status,
    ).toBe("skipped");
    const document = new SqliteDocumentRepository(database).list(
      "p1",
      "chapter",
    )[0];
    expect(document?.title).toBe("雾港失灯");
    const version = new SqliteDocumentRepository(database).listVersions(
      "p1",
      document!.id,
    )[0];
    expect(version).toMatchObject({ content: manuscript, source: "run:run-1" });
    const story = new SqliteStoryRepository(database);
    const canon = new SqliteCanonRepository(database);
    const state = new SqliteNarrativeStateRepository(database, canon, story);
    expect(state.latestSummary("p1", "chapter", chapterId)?.summary).toBe(
      "林昼亲历灯塔熄灭，并发现父亲遗忘了空椅子的主人。",
    );
    expect(
      database.raw
        .prepare("SELECT status FROM canon_change_sets WHERE run_id = ?")
        .get("run-1"),
    ).toEqual({ status: "applied" });
    expect(state.listTimeline("p1")).toEqual([
      expect.objectContaining({
        sourceId: "run-1:canon-change-set",
        participants: ["hero"],
      }),
    ]);
    expect(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM review_reports WHERE run_id = ?",
        )
        .get("run-1"),
    ).toEqual({ count: 1 });
    expect(
      new SqliteContextReceiptRepository(database)
        .list("p1", 1)[0]
        ?.entries.filter((entry) => entry.status !== "excluded")
        .map((entry) => entry.label),
    ).toEqual(
      expect.arrayContaining([
        "启用风格 · 冷雾短句",
        "写作 Skill · 场景证据链",
      ]),
    );
    const persistedEvidence = database.raw
      .prepare("SELECT evidence_json FROM review_issues LIMIT 1")
      .get() as { evidence_json: string };
    expect(JSON.parse(persistedEvidence.evidence_json)).toEqual([
      expect.objectContaining({
        quote: manuscript.split("\n\n")[0],
        start: 0,
        paragraphOrdinal: 1,
        documentVersionId: version!.id,
        contentHash: version!.contentHash,
      }),
    ]);
    expect(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM context_receipts WHERE run_id = ?",
        )
        .get("run-1"),
    ).toEqual({ count: 5 });
    expect(model.structured).toHaveBeenCalledTimes(3);
    expect(model.text).toHaveBeenCalledTimes(1);
    const settlementRequest = model.structured.mock.calls.find(
      ([, , purpose]) => purpose === "chapter-settlement",
    )?.[3];
    expect(settlementRequest?.instructions).toContain(
      "不要额外填写布尔值或字符串 true 表示事实成立",
    );
    expect(settlementRequest?.instructions).toContain(
      "同时需要实体和文本时拆成两条事实",
    );
  });

  it("uses one compass length reference for scene planning and draft continuation only", async () => {
    const automation = new SqliteAutomationRepository(database);
    automation.upsertCompass({
      projectId: "p1",
      corePromise: "记忆的代价必须落到人物选择上。",
      endingDirection: null,
      longLines: [],
      themeQuestions: ["谁有权决定哪些记忆值得保留？"],
      target: { chapters: 12, wordsPerChapter: 3_200, volumes: 1 },
      constraints: [],
      version: 1,
      updatedAt: now,
    });
    const continuationPrefix = "已有开头。";
    const manuscript =
      "林昼推开灯塔的门，潮气贴着石阶上涌。\n\n第三声钟响后，父亲忘记了空椅子的主人。";
    const model = scriptedModel(manuscript, { nearEvidence: true });
    const suite = new ChapterWorkerSuite(database, model, () => new Date(now));
    const recipe = buildChapterRecipe("run-length-reference", 0);
    runs.create({
      id: "run-length-reference",
      projectId: "p1",
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "autopilot",
      targetOutlineNodeId: chapterId,
      policy: {
        continuationPrefix,
        minChapterCharacters: 20,
        contextWindow: 8_000,
      },
      steps: recipe.steps,
      now,
    });
    const supervisor = new HarnessSupervisor(runs, suite.registry(), {
      now: () => new Date(now),
    });

    expect(await supervisor.processNext("worker-length-reference")).toBe(true);
    const compiled = runs
      .getSnapshot("run-length-reference")
      .steps.find((step) => step.kind === "context.compile")?.outputArtifact;
    expect(compiled?.chapterWritingReference).toEqual({
      targetCharacters: 3_200,
      compassVersion: 1,
    });

    automation.upsertCompass({
      ...automation.requireCompass("p1"),
      target: { chapters: 12, wordsPerChapter: 5_200, volumes: 1 },
      updatedAt: "2026-08-10T00:01:00.000Z",
    });
    for (let index = 0; index < 30; index += 1) {
      if (!(await supervisor.processNext("worker-length-reference"))) break;
    }

    const sceneRequest = model.structured.mock.calls.find(
      ([, , purpose]) => purpose === "scene-plan",
    )?.[3];
    const draftRequest = model.text.mock.calls.find(
      ([, , purpose]) => purpose === "chapter-draft",
    )?.[3];
    const reviewRequest = model.structured.mock.calls.find(
      ([, , purpose]) => purpose === "semantic-review",
    )?.[3];
    const scenePrompt = sceneRequest?.messages[0]?.content ?? "";
    const draftPrompt = draftRequest?.messages[0]?.content ?? "";
    const reviewPrompt = reviewRequest?.messages[0]?.content ?? "";

    expect(scenePrompt).toContain("参考篇幅约为 3200 字");
    expect(scenePrompt).toContain("scenes[].targetCharacters 合计大致围绕");
    expect(draftPrompt).toContain("参考篇幅约为 3200 字");
    expect(draftPrompt).toContain(
      `现有开头已有 ${[...continuationPrefix].length} 字`,
    );
    expect(draftPrompt).toContain("不是要求再新增 3200 字");
    expect(scenePrompt).not.toContain("5200");
    expect(draftPrompt).not.toContain("5200");
    expect(reviewPrompt).not.toContain("chapter-writing-reference");
    expect(reviewPrompt).not.toContain("3200");
  });

  it("结算输出把上下文标注前缀抄进 ID 时自动规范化并照常落盘", async () => {
    const manuscript =
      "雾从海面推上石阶。林昼推门进入灯塔，钟声第三下停了。\n\n父亲问她为何对着空椅子说话。";
    const model = scriptedModel(manuscript, {
      nearEvidence: true,
      taggedIds: true,
    });
    const suite = new ChapterWorkerSuite(database, model, () => new Date(now));
    const recipe = buildChapterRecipe("run-1", 1);
    runs.create({
      id: "run-1",
      projectId: "p1",
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "autopilot",
      targetOutlineNodeId: chapterId,
      policy: {
        maxRevisionCycles: 1,
        minChapterCharacters: 20,
        contextWindow: 8_000,
      },
      steps: recipe.steps,
      now,
    });
    const supervisor = new HarnessSupervisor(runs, suite.registry(), {
      now: () => new Date(now),
    });

    for (let index = 0; index < 30; index += 1) {
      if (!(await supervisor.processNext("worker-test"))) break;
    }

    const snapshot = runs.getSnapshot("run-1");
    expect(
      snapshot.run.status,
      JSON.stringify(snapshot.steps.map((step) => [step.kind, step.error])),
    ).toBe("completed");
    const state = new SqliteNarrativeStateRepository(
      database,
      new SqliteCanonRepository(database),
      new SqliteStoryRepository(database),
    );
    // participantIds 的 entity: 前缀被剥掉，伏笔的 node: 前缀同理，
    // 落盘的是裸 ID。
    expect(state.listTimeline("p1")[0]?.participants).toEqual(["hero"]);
    expect(state.listForeshadows("p1")[0]).toMatchObject({
      title: "灯塔熄灭的代价",
      targetFromNodeId: chapterId,
      status: "planted",
    });
  });

  it("turns a length-limited draft into an explicit recoverable partial", async () => {
    const model = scriptedModel("尚未写完的正文。", { nearEvidence: true });
    vi.mocked(model.text).mockResolvedValue({
      text: "尚未写完的正文。",
      finishReason: "length",
      usage: {
        inputTokens: 10,
        outputTokens: 10,
        calls: 1,
        costUsd: 0,
        wallTimeMs: 1,
      },
    });
    const suite = new ChapterWorkerSuite(database, model, () => new Date(now));
    const recipe = buildChapterRecipe("run-length", 0);
    runs.create({
      id: "run-length",
      projectId: "p1",
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "manual",
      targetOutlineNodeId: chapterId,
      policy: { minChapterCharacters: 20, contextWindow: 8_000 },
      budgetLimit: {
        maxInputTokens: 100_000,
        maxOutputTokens: 50_000,
        maxCalls: 20,
        maxCostUsd: null,
        maxWallTimeMs: 60_000,
      },
      steps: recipe.steps,
      now,
    });
    const supervisor = new HarnessSupervisor(runs, suite.registry(), {
      now: () => new Date(now),
    });

    for (let index = 0; index < 10; index += 1) {
      await supervisor.processNext("worker-length");
      if (runs.getRun("run-length")?.status === "failed_recoverable") break;
    }

    const snapshot = runs.getSnapshot("run-length");
    expect(snapshot.run.status).toBe("failed_recoverable");
    expect(
      snapshot.steps.find((step) => step.kind === "draft.generate")?.error,
    ).toMatchObject({
      code: "draft.output_limit",
      details: {
        finishReason: "length",
        partial: true,
        recoveryActions: ["continue", "adopt", "regenerate"],
      },
    });
  });

  it("completes a chapter through the real HTTP transport and a fake provider", async () => {
    const manuscript =
      "雾从海面推上石阶。林昼推开灯塔的门，第三下钟声从墙内响起。\n\n灯灭之后，父亲指着空椅子，问她刚才在同谁说话。";
    const providerOutputs: unknown[] = [
      {
        chapterGoal: "让林昼发现遗忘规则",
        povEntityId: "hero",
        scenes: [
          {
            title: "熄灯",
            goal: "进入灯塔",
            conflict: "父亲阻拦",
            turn: "灯塔自行熄灭",
            outcome: "父亲遗忘一人",
            locationId: null,
            participants: ["hero"],
            targetCharacters: 1_200,
          },
        ],
        continuityRisks: [],
      },
      manuscript,
      {
        summary: "章节目标已经完成。",
        scores: {
          continuity: 90,
          pacing: 88,
          character: 86,
          prose: 85,
          goal: 92,
        },
        issues: [
          {
            category: "prose",
            severity: "minor",
            message: "第一段可以更凝练",
            evidenceParagraphs: [1],
            suggestedDirection: null,
            requiresAuthorDecision: false,
          },
        ],
      },
      {
        summary: "林昼亲历灯塔熄灭，并发现父亲遗忘了空椅子的主人。",
        stateDelta: [
          {
            key: "ruleObserved",
            before: null,
            after: "林昼观察到灯塔熄灭会触发遗忘",
            evidenceParagraphs: [2],
          },
        ],
        factCandidates: [],
        timelineCandidates: [
          {
            title: "灯塔熄灭",
            description: "父亲遗忘了一个人",
            storyTime: null,
            participantIds: ["hero"],
            causeEventIds: [],
            visibility: "reader",
            knownBy: [],
            evidenceParagraphs: [2],
          },
        ],
        relationshipCandidates: [],
        foreshadowCandidates: [],
      },
    ];
    let requests = 0;
    const server = createServer((_request, response) => {
      const output = providerOutputs[requests];
      requests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: `fake-${requests}`,
          choices: [
            {
              message: {
                content:
                  typeof output === "string" ? output : JSON.stringify(output),
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 100,
            total_tokens: 200,
          },
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const port = (server.address() as AddressInfo).port;
      new SqliteProviderRepository(database).upsert({
        id: "fake-provider",
        name: "fake-provider",
        wireApi: "openai-chat",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        endpoint: null,
        credentialRef: "fake-key",
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
        id: "fake-model",
        providerId: "fake-provider",
        modelId: "fake-model",
        taskType: "writing",
        contextWindow: 32_000,
        maxOutputTokens: 16_000,
        sampling: {},
        capabilities: {
          structuredOutput: true,
          structuredOutputNative: true,
          structuredOutputJsonMode: false,
        },
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      new SqliteAssignmentRepository(database).set(
        "writing",
        "fake-model",
        now,
      );
      const recipe = buildChapterRecipe("run-fake-provider", 0);
      runs.create({
        id: "run-fake-provider",
        projectId: "p1",
        recipe: recipe.name,
        recipeVersion: recipe.version,
        mode: "autopilot",
        targetOutlineNodeId: chapterId,
        policy: { minChapterCharacters: 20 },
        budgetLimit: {
          maxInputTokens: 100_000,
          maxOutputTokens: 50_000,
          maxCalls: 8,
          maxCostUsd: null,
          maxWallTimeMs: 60_000,
        },
        steps: recipe.steps,
        now,
      });
      const supervisor = new HarnessSupervisor(
        runs,
        new ChapterWorkerSuite(
          database,
          new GatewayNarrativeModelClient(database, {}),
          () => new Date(now),
        ).registry(),
        { now: () => new Date(now) },
      );

      for (let index = 0; index < 30; index += 1) {
        if (!(await supervisor.processNext("worker-fake-provider"))) break;
      }

      expect(
        runs.getSnapshot("run-fake-provider").run.status,
        JSON.stringify(
          runs
            .getSnapshot("run-fake-provider")
            .steps.map((step) => [step.kind, step.error]),
        ),
      ).toBe("completed");
      expect(requests).toBe(4);
      expect(runs.getRun("run-fake-provider")?.budgetUsage.calls).toBe(4);
      expect(
        new SqliteDocumentRepository(database).listVersions(
          "p1",
          new SqliteDocumentRepository(database).list("p1", "chapter")[0]!.id,
        )[0]?.content,
      ).toBe(manuscript);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("records run.degraded and notes the receipt when embedding is not configured", async () => {
    const manuscript =
      "雾从海面推上石阶。林昼把手按在冰冷的门上，听见灯塔深处传来第三下钟声。\n\n灯灭的一刻，父亲忽然问她为何对着空椅子说话。";
    const model = scriptedModel(manuscript, { nearEvidence: true });
    const suite = new ChapterWorkerSuite(database, model, () => new Date(now));
    const recipe = buildChapterRecipe("run-degraded", 0);
    runs.create({
      id: "run-degraded",
      projectId: "p1",
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "autopilot",
      targetOutlineNodeId: chapterId,
      policy: { minChapterCharacters: 20 },
      budgetLimit: {
        maxInputTokens: 100_000,
        maxOutputTokens: 50_000,
        maxCalls: 20,
        maxCostUsd: null,
        maxWallTimeMs: 60_000,
      },
      steps: recipe.steps,
      now,
    });
    const supervisor = new HarnessSupervisor(runs, suite.registry(), {
      now: () => new Date(now),
    });

    for (let index = 0; index < 30; index += 1) {
      if (!(await supervisor.processNext("worker-test"))) break;
    }

    const snapshot = runs.getSnapshot("run-degraded");
    expect(snapshot.run.status).toBe("completed");
    // The scripted model has no embedding capability: the run degrades to
    // FTS/entity ranking and records the warning exactly once per run.
    const degraded = snapshot.events.filter(
      (event) => event.type === "run.degraded",
    );
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.payload).toEqual({
      capability: "embedding",
      reason: "embedding_not_configured",
    });
    const receipt = new SqliteContextReceiptRepository(database).list(
      "p1",
      1,
    )[0];
    expect(receipt?.degradations).toEqual([
      { capability: "embedding", reason: "embedding_not_configured" },
    ]);
  });

  it("records an empty revision as revision_noop and reuses the unchanged document version", async () => {
    const manuscript =
      "雾从海面推上石阶。林昼听见第三下钟声。\n\n灯灭的一刻，父亲忽然忘了空椅子的主人。";
    const documents = new SqliteDocumentRepository(database);
    const document = documents.insert(
      createDocument({
        id: "existing-chapter",
        projectId: "p1",
        kind: "chapter",
        title: "雾港失灯",
        outlineNodeId: chapterId,
        now,
      }),
    );
    const baseVersion = documents.appendVersion("p1", document.id, {
      id: "existing-version",
      content: manuscript,
      source: "author",
      expectedCurrentVersionId: null,
      now,
    });
    const model = scriptedModel(manuscript, {
      reviewVerdicts: ["revise", "pass"],
      revisionText: "",
    });
    const recipe = buildChapterRecipe("run-noop", 1);
    runs.create({
      id: "run-noop",
      projectId: "p1",
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "autopilot",
      targetOutlineNodeId: chapterId,
      policy: {
        maxRevisionCycles: 1,
        minChapterCharacters: 20,
        contextWindow: 8_000,
      },
      budgetLimit: {
        maxInputTokens: 100_000,
        maxOutputTokens: 50_000,
        maxCalls: 20,
        maxCostUsd: null,
        maxWallTimeMs: 60_000,
      },
      steps: recipe.steps,
      now,
    });
    const supervisor = new HarnessSupervisor(
      runs,
      new ChapterWorkerSuite(database, model, () => new Date(now)).registry(),
      { now: () => new Date(now) },
    );
    for (let index = 0; index < 30; index += 1) {
      if (!(await supervisor.processNext("worker-noop"))) break;
    }

    const snapshot = runs.getSnapshot("run-noop");
    expect(snapshot.run.status).toBe("completed");
    const revisionRequest = model.text.mock.calls.find(
      ([, , purpose]) => purpose === "chapter-revision",
    )?.[3];
    expect(revisionRequest?.instructions).toContain("<writing-craft>");
    expect(revisionRequest?.instructions).toContain("先对抗你的本能");
    expect(
      revisionRequest!.instructions.indexOf("先对抗你的本能"),
    ).toBeLessThan(
      revisionRequest!.instructions.indexOf("不要为了润色而全篇换风格"),
    );
    expect(
      database.raw
        .prepare(
          "SELECT kind FROM run_artifacts WHERE run_id = ? AND step_id = ?",
        )
        .get("run-noop", "run-noop:revise:0"),
    ).toEqual({ kind: "revision_noop" });
    expect(documents.listVersions("p1", document.id)).toHaveLength(1);
    expect(documents.get("p1", document.id)?.currentVersionId).toBe(
      baseVersion.id,
    );
    expect(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM revision_proposals WHERE run_id = ?",
        )
        .get("run-noop"),
    ).toEqual({ count: 0 });
    expect(
      database.raw
        .prepare(
          `SELECT status FROM review_issues issue
           JOIN review_reports report ON report.id = issue.report_id
           WHERE report.run_id = ?`,
        )
        .get("run-noop"),
    ).toEqual({ status: "open" });
  });

  it("retries an excerpt-only revision instead of promoting it as the next manuscript", async () => {
    const manuscript =
      "雾从海面推上石阶。林昼听见第三下钟声。\n\n灯灭的一刻，父亲忽然忘了空椅子的主人。";
    const model = scriptedModel(manuscript, {
      reviewVerdicts: ["revise"],
      revisionText: "只改这一句。",
    });
    const recipe = buildChapterRecipe("run-incomplete-revision", 1);
    runs.create({
      id: "run-incomplete-revision",
      projectId: "p1",
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "autopilot",
      targetOutlineNodeId: chapterId,
      policy: { minChapterCharacters: 20, maxRetries: 2 },
      budgetLimit: {
        maxInputTokens: 100_000,
        maxOutputTokens: 50_000,
        maxCalls: 20,
        maxCostUsd: null,
        maxWallTimeMs: 60_000,
      },
      steps: recipe.steps,
      now,
    });
    let clock = Date.parse(now);
    const supervisor = new HarnessSupervisor(
      runs,
      new ChapterWorkerSuite(database, model, () => new Date(now)).registry(),
      { now: () => new Date(clock), retryDelayMs: 0 },
    );
    for (let index = 0; index < 30; index += 1) {
      clock += 5_000;
      if (!(await supervisor.processNext("worker-incomplete-revision"))) break;
    }

    const revision = runs
      .getSnapshot("run-incomplete-revision")
      .steps.find((step) => step.kind === "revision.generate");
    expect(revision).toMatchObject({
      status: "failed",
      attempt: 3,
      error: { code: "revision.incomplete", retryable: true },
    });
    expect(model.text).toHaveBeenCalledTimes(4);
    expect(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM revision_proposals WHERE run_id = ?",
        )
        .get("run-incomplete-revision"),
    ).toEqual({ count: 0 });
  });

  it("rejects review evidence that cannot be found in the manuscript", async () => {
    const model = scriptedModel(
      Array.from(
        { length: 20 },
        (_, index) => `第${index + 1}段正文发生不同动作。`,
      ).join("\n\n"),
      {
        hallucinateEvidence: true,
      },
    );
    const suite = new ChapterWorkerSuite(database, model, () => new Date(now));
    const recipe = buildChapterRecipe("run-2", 0);
    runs.create({
      id: "run-2",
      projectId: "p1",
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "chapter-gate",
      targetOutlineNodeId: chapterId,
      policy: { minChapterCharacters: 20 },
      budgetLimit: {
        maxInputTokens: 100_000,
        maxOutputTokens: 50_000,
        maxCalls: 20,
        maxCostUsd: null,
        maxWallTimeMs: 60_000,
      },
      steps: recipe.steps,
      now,
    });
    const supervisor = new HarnessSupervisor(runs, suite.registry(), {
      now: () => new Date(now),
    });
    for (let index = 0; index < 10; index += 1) {
      await supervisor.processNext("worker-test");
      const review = runs
        .getSnapshot("run-2")
        .steps.find((step) => step.kind === "semantic.review");
      if (review?.status === "failed") break;
    }
    const review = runs
      .getSnapshot("run-2")
      .steps.find((step) => step.kind === "semantic.review");
    expect(review).toMatchObject({
      status: "failed",
      error: { code: "mock.validation", retryable: false },
    });
  });

  it("pins the latest preceding chapter text into the next chapter context", async () => {
    const story = new SqliteStoryRepository(database);
    const previousDocument = new SqliteDocumentRepository(database).insert(
      createDocument({
        id: "chapter-1-document",
        projectId: "p1",
        kind: "chapter",
        title: "雾港失灯",
        outlineNodeId: chapterId,
        now,
      }),
    );
    const previousVersion = new SqliteDocumentRepository(
      database,
    ).appendVersion("p1", previousDocument.id, {
      id: "chapter-1-version",
      content: "上一章的最后一句仍然悬着：钟声之后，空椅子属于谁？",
      source: "manual",
      expectedCurrentVersionId: null,
      now,
    });
    const nextChapter = story.insertOutlineNode(
      createOutlineNode({
        id: "chapter-2",
        projectId: "p1",
        parent: story.requireOutlineNode("p1", "book"),
        kind: "chapter",
        ordinal: 1,
        title: "空椅来客",
        summary: "林昼追查空椅子的主人。",
        now,
      }),
    );
    const model = scriptedModel("第二章正文足够长，可以通过机械检查。", {
      nearEvidence: true,
    });
    const recipe = buildChapterRecipe("run-next-chapter", 0);
    runs.create({
      id: "run-next-chapter",
      projectId: "p1",
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "autopilot",
      targetOutlineNodeId: nextChapter.id,
      policy: { minChapterCharacters: 20, contextWindow: 8_000 },
      budgetLimit: {
        maxInputTokens: 100_000,
        maxOutputTokens: 50_000,
        maxCalls: 20,
        maxCostUsd: null,
        maxWallTimeMs: 60_000,
      },
      steps: recipe.steps,
      now,
    });
    const supervisor = new HarnessSupervisor(
      runs,
      new ChapterWorkerSuite(database, model, () => new Date(now)).registry(),
      { now: () => new Date(now) },
    );

    expect(await supervisor.processNext("worker-next-chapter")).toBe(true);

    const draftReceipt = new SqliteContextReceiptRepository(database)
      .list("p1", 10)
      .find((receipt) => receipt.purpose === "chapter-draft");
    expect(draftReceipt?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "紧邻上一章最新正文 · 雾港失灯",
          status: "included",
          provenanceId: previousVersion.id,
        }),
      ]),
    );
  });
});

function scriptedModel(
  manuscript: string,
  options: {
    hallucinateEvidence?: boolean;
    nearEvidence?: boolean;
    reviewVerdicts?: Array<"pass" | "revise" | "block">;
    revisionText?: string;
    /** 模拟模型把上下文标注语法抄进 ID 值的常见失败形态。 */
    taggedIds?: boolean;
  } = {},
) {
  const tag = (value: string | null): string | null =>
    value === null || !options.taggedIds ? value : `node:${value}`;
  const participantTag = (value: string): string =>
    options.taggedIds ? `entity:${value}` : value;
  let reviewIndex = 0;
  const usage = {
    inputTokens: 100,
    outputTokens: 100,
    calls: 1,
    costUsd: 0,
    wallTimeMs: 10,
  };
  const client: NarrativeModelClient = {
    text: vi.fn(async (_run, _step, purpose) => {
      if (purpose === "chapter-draft") return { text: manuscript, usage };
      return {
        text: options.revisionText ?? manuscript.replace("父亲", "守灯人"),
        usage,
      };
    }),
    structured: vi.fn(
      async (_run, _step, purpose, _request, _contract, validate) => {
        const value =
          purpose === "scene-plan"
            ? {
                chapterGoal: "让林昼发现遗忘规则",
                povEntityId: "hero",
                scenes: [
                  {
                    title: "熄灯",
                    goal: "进入灯塔",
                    conflict: "父亲阻拦",
                    turn: "灯塔自行熄灭",
                    outcome: "父亲遗忘一人",
                    locationId: null,
                    participants: ["hero"],
                    targetCharacters: 1200,
                  },
                ],
                continuityRisks: [],
              }
            : purpose === "semantic-review"
              ? (() => {
                  const verdict =
                    options.reviewVerdicts?.[reviewIndex++] ??
                    (options.hallucinateEvidence ? "revise" : "pass");
                  return {
                    summary: "章节目标已经完成。",
                    scores: {
                      continuity: 90,
                      pacing: 88,
                      character: 86,
                      prose: 85,
                      goal: 92,
                    },
                    issues: options.hallucinateEvidence
                      ? [
                          {
                            category: "continuity",
                            severity: "major",
                            message: "引用并不存在",
                            evidenceParagraphs: [999],
                            suggestedDirection: "修复",
                            requiresAuthorDecision: false,
                          },
                        ]
                      : options.nearEvidence
                        ? [
                            {
                              category: "prose",
                              severity: "minor",
                              message: "第一段需要调整",
                              evidenceParagraphs: [1],
                              suggestedDirection: null,
                              requiresAuthorDecision: false,
                            },
                          ]
                        : verdict === "revise"
                          ? [
                              {
                                category: "continuity",
                                severity: "major",
                                message: "需要修订但模型可以选择不改",
                                evidenceParagraphs: [1],
                                suggestedDirection: "复核",
                                requiresAuthorDecision: false,
                              },
                            ]
                          : [],
                  };
                })()
              : {
                  summary: "林昼亲历灯塔熄灭，并发现父亲遗忘了空椅子的主人。",
                  stateDelta: [
                    {
                      key: "ruleObserved",
                      before: null,
                      after: "林昼观察到灯塔熄灭会触发遗忘",
                      evidenceParagraphs: [2],
                    },
                  ],
                  factCandidates: [],
                  timelineCandidates: [
                    {
                      title: "灯塔熄灭",
                      description: "父亲遗忘了一个人",
                      storyTime: null,
                      participantIds: ["hero"].map(participantTag),
                      causeEventIds: [],
                      visibility: "reader",
                      knownBy: [],
                      evidenceParagraphs: [2],
                    },
                  ],
                  relationshipCandidates: [],
                  foreshadowCandidates: options.taggedIds
                    ? [
                        {
                          foreshadowId: null,
                          title: "灯塔熄灭的代价",
                          action: "plant" as const,
                          expectedStatus: null,
                          importance: 3,
                          targetFromNodeId: tag(chapterId),
                          targetToNodeId: null,
                          evidenceParagraphs: [2],
                        },
                      ]
                    : [],
                };
        const checked = validate(value);
        if (!checked.success) {
          throw {
            code: "mock.validation",
            message: checked.issues.join("; "),
            retryable: false,
          };
        }
        return {
          value: checked.data,
          usage,
          mode: "native" as const,
          attempts: 1,
        };
      },
    ),
  };
  return client as NarrativeModelClient & {
    text: ReturnType<typeof vi.fn>;
    structured: ReturnType<typeof vi.fn>;
  };
}
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
