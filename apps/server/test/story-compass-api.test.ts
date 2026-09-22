import { randomUUID } from "node:crypto";
import type { StoryCompassDto, StoryLongLineDto } from "@narralume/contracts";
import {
  createOutlineNode,
  createDocument,
  ZERO_BUDGET_USAGE,
  type OutlineNode,
} from "@narralume/domain";
import {
  buildClosingReviewRecipe,
  buildRollingOutlineRecipe,
} from "@narralume/harness";
import {
  AutomationWorkerSuite,
  type NarrativeModelClient,
} from "@narralume/narrative";
import {
  SqliteAutomationRepository,
  SqliteCanonRepository,
  SqliteNarrativeStateRepository,
  SqliteStoryRepository,
  SqliteDocumentRepository,
  SqliteRunRepository,
  SqliteReviewRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const resources: {
  app: Awaited<ReturnType<typeof buildApp>>;
  database: NodeNarrativeDatabase;
}[] = [];
afterEach(async () => {
  for (const { app, database } of resources.splice(0)) {
    await app.close();
    database.close();
  }
});

async function setup() {
  const database = new NodeNarrativeDatabase();
  const app = await buildApp({
    database,
    config: {
      dataDirectory: ".",
      databasePath: ":memory:",
      host: "127.0.0.1",
      port: 4317,
      environment: "test",
    },
    environment: {},
    enableRunWorker: false,
    logger: false,
  });
  resources.push({ app, database });
  const createProject = async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { requestId: randomUUID(), title: "长期故事线" },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  };
  const projectId = await createProject();
  const foreignId = await createProject();
  const story = new SqliteStoryRepository(database);
  const node = (
    parent: OutlineNode,
    kind: OutlineNode["kind"],
    title: string,
    ordinal = 0,
  ) =>
    story.insertOutlineNode(
      createOutlineNode({
        id: randomUUID(),
        projectId: parent.projectId,
        parent,
        kind,
        title,
        ordinal,
        now: "2026-09-20T10:00:00.000Z",
      }),
    );
  const root = story.listOutline(projectId)[0]!;
  const volume = node(root, "volume", "第一卷");
  const arc = node(volume, "arc", "寻找见证者");
  const chapter = node(arc, "chapter", "初见");
  story.updateOutlineStatus(
    projectId,
    chapter.id,
    "committed",
    "2026-09-20T11:00:00.000Z",
  );
  const future = node(arc, "chapter", "将来的会面", 1);
  const foreignVolume = node(
    story.listOutline(foreignId)[0]!,
    "volume",
    "其他作品的卷",
  );
  const foreignChapter = node(foreignVolume, "chapter", "其他作品的定稿");
  story.updateOutlineStatus(
    foreignId,
    foreignChapter.id,
    "committed",
    "2026-09-20T11:00:00.000Z",
  );
  const line: StoryLongLineDto = {
    title: "失踪者的名字",
    promise: "揭示港口如何失去记忆",
    status: "developing",
    development: {
      scopeNodeId: arc.id,
      stageGoal: "找到另一名见证者",
      progress: "已确认旧信件的笔迹",
      openPromises: ["尚未找到收信人", "尚未解释潮声"],
      nextDevelopment: "让调查触及港口之外",
      evidenceChapterIds: [chapter.id],
    },
  };
  const input = {
    corePromise: "记忆与代价",
    endingDirection: null,
    longLines: [line],
    themeQuestions: ["谁承担遗忘"],
    constraints: ["不立刻揭晓幕后原因"],
    target: { chapters: 100, wordsPerChapter: 3000, volumes: 4 },
  };
  const put = (body: unknown) =>
    app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/compass`,
      payload: body,
    });
  const get = async () =>
    (
      await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/compass`,
      })
    ).json() as StoryCompassDto;
  return {
    app,
    database,
    story,
    projectId,
    foreignId,
    arc,
    volume,
    chapter,
    future,
    foreignVolume,
    foreignChapter,
    line,
    input,
    put,
    get,
  };
}

async function proposalSetup() {
  const t = await setup();
  await t.put({
    ...t.input,
    longLines: [t.line, { ...t.line, title: "潮声" }],
    expectedVersion: null,
  });
  const now = "2026-09-22T00:00:00.000Z";
  const documents = new SqliteDocumentRepository(t.database);
  const document = documents.insert(
    createDocument({
      id: randomUUID(),
      projectId: t.projectId,
      kind: "chapter",
      title: t.chapter.title,
      outlineNodeId: t.chapter.id,
      now,
    }),
  );
  const version = documents.appendVersion(t.projectId, document.id, {
    id: randomUUID(),
    content: "见证者交出了旧信。潮声再次响起。",
    source: "test",
    now,
  });
  const state = new SqliteNarrativeStateRepository(
    t.database,
    new SqliteCanonRepository(t.database),
    t.story,
  );
  state.upsertSummary({
    id: randomUUID(),
    projectId: t.projectId,
    scopeType: "chapter",
    scopeId: t.chapter.id,
    summary: "见证者交出旧信，但潮声之谜仍未解开。",
    stateDelta: {},
    sourceHash: version.contentHash,
    createdAt: now,
  });
  const automation = new SqliteAutomationRepository(t.database);
  const session = automation.createSession({
    id: randomUUID(),
    projectId: t.projectId,
    mode: "autopilot",
    targetChapters: 2,
    windowSize: 2,
    maxRevisionCycles: 0,
    chapterPolicy: {},
    now,
  });
  const runId = randomUUID();
  const recipe = buildClosingReviewRecipe(runId, ["arc"]);
  const runs = new SqliteRunRepository(t.database);
  runs.create({
    id: runId,
    projectId: t.projectId,
    mode: "autopilot",
    recipe: recipe.name,
    recipeVersion: recipe.version,
    targetOutlineNodeId: t.arc.id,
    policy: { sessionId: session.id, arcId: t.arc.id },
    steps: recipe.steps,
    now,
  });
  runs.leaseNext("test", now, 30_000);
  const step = runs.startStep(runId, recipe.steps[0]!.id, now);
  const proposals = [0, 1].map((lineIndex) => ({
    lineIndex,
    rationale: "正文摘要记载旧信已交出",
    status: "developing",
    progress: "已取得旧信",
    openPromises: ["潮声之谜"],
    nextDevelopment: "寻找收信人",
    evidenceChapterIds: [t.chapter.id],
  }));
  let prompt = "";
  const review = async (items: unknown = proposals, during?: () => void) => {
    const model: NarrativeModelClient = {
      async text() {
        throw new Error("Unexpected text generation");
      },
      async structured(_run, _step, _purpose, request, _contract, validate) {
        prompt = JSON.stringify(request);
        const checked = validate({
          summary: "调查取得证据",
          scores: {
            promise: 80,
            causality: 80,
            characterArc: 80,
            pacing: 80,
            continuity: 80,
          },
          recommendations: [],
          compassAdjustments: [],
          lineProposals: items,
        });
        if (!checked.success) throw new Error(checked.issues.join("; "));
        during?.();
        return {
          value: checked.data,
          usage: ZERO_BUDGET_USAGE,
          mode: "native",
          attempts: 1,
        };
      },
    };
    const worker = new AutomationWorkerSuite(t.database, model).registry()[
      "arc.review"
    ]!;
    return worker.execute(
      runs.getSnapshot(runId),
      step,
      new AbortController().signal,
    );
  };
  const url = `/api/projects/${t.projectId}/compass/proposals`;
  const decide = (
    itemId: string,
    action: "apply" | "reject",
    projectId = t.projectId,
  ) =>
    t.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/compass/proposals/${encodeURIComponent(step.id + ":story-lines")}/items/${itemId}/decision`,
      payload: { action },
    });
  return {
    ...t,
    documents,
    document,
    state,
    automation,
    proposals,
    review,
    decide,
    url,
    runs,
    session,
    prompt: () => prompt,
    setId: step.id + ":story-lines",
  };
}

describe("evidence-backed story line proposals", () => {
  it("keeps evidence valid when unrelated future plans are appended and blocks bulk decisions", async () => {
    const t = await proposalSetup();
    await t.review();
    t.story.insertOutlineNode(
      createOutlineNode({
        id: randomUUID(),
        projectId: t.projectId,
        parent: t.arc,
        kind: "chapter",
        ordinal: 2,
        title: "尚未写作的新章",
        now: new Date().toISOString(),
      }),
    );
    const bulk = await t.app.inject({
      method: "POST",
      url: `/api/projects/${t.projectId}/canon-change-sets/${encodeURIComponent(t.setId)}/decisions`,
      payload: { requestId: randomUUID(), action: "apply" },
    });
    expect(bulk.statusCode, bulk.body).toBe(409);
    expect(bulk.json().error.code).toBe(
      "story_line_proposal.individual_required",
    );
    expect((await t.decide("0", "apply")).statusCode).toBe(200);
  });
  it("feeds actual accepted results and rejections into the next planning window", async () => {
    const t = await proposalSetup();
    await t.review();
    await t.decide("0", "apply");
    await t.decide("1", "reject");
    const id = randomUUID();
    const recipe = buildRollingOutlineRecipe(id);
    t.runs.create({
      id,
      projectId: t.projectId,
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "autopilot",
      targetOutlineNodeId: t.story.listOutline(t.projectId)[0]!.id,
      policy: { sessionId: t.session.id },
      steps: recipe.steps,
      now: new Date().toISOString(),
    });
    let captured = "";
    const model: NarrativeModelClient = {
      async text() {
        throw new Error("unexpected");
      },
      async structured(_run, _step, _purpose, request) {
        captured = JSON.stringify(request);
        throw new Error("captured planning input");
      },
    };
    const snapshot = t.runs.getSnapshot(id);
    const worker = new AutomationWorkerSuite(t.database, model).registry()[
      "outline.generate"
    ]!;
    await expect(
      worker.execute(
        snapshot,
        snapshot.steps[0]!,
        new AbortController().signal,
      ),
    ).rejects.toThrow("captured planning input");
    expect(captured).toContain("compassVersion");
    expect(captured).toContain("已取得旧信");
    expect(captured).toContain('\\"action\\":\\"reject\\"');
    expect(captured).toContain("不得当成作者方向");
  });
  it("stages without applying, applies siblings atomically, replays decisions and rejects opposite decisions", async () => {
    const t = await proposalSetup();
    const before = await t.get();
    await t.review();
    expect(await t.get()).toEqual(before);
    expect(t.prompt()).toContain(t.chapter.id);
    expect(t.prompt()).not.toContain(t.future.title);
    const list = (await t.app.inject({ method: "GET", url: t.url })).json();
    expect(list[0].items).toHaveLength(2);
    expect(list[0].stale).toBe(false);
    expect((await t.decide("0", "apply")).statusCode).toBe(200);
    expect((await t.decide("0", "apply")).statusCode).toBe(200);
    expect((await t.get()).version).toBe(before.version + 1);
    expect((await t.decide("0", "reject")).statusCode).toBe(409);
    expect((await t.decide("1", "apply")).statusCode).toBe(200);
    expect((await t.get()).version).toBe(before.version + 2);
    expect(
      (await t.get()).longLines.every(
        (line) => line.development?.progress === "已取得旧信",
      ),
    ).toBe(true);
    expect(
      new SqliteReviewRepository(t.database).listCanonItemDecisions(t.setId)[0]!
        .result,
    ).toMatchObject({ compassVersion: before.version + 1 });
    expect((await t.decide("0", "apply", t.foreignId)).statusCode).toBe(404);
  });
  it.each(["compass", "manuscript", "summary", "outline"])(
    "rejects stale %s evidence but allows refusal",
    async (change) => {
      const t = await proposalSetup();
      await t.review();
      if (change === "compass")
        t.automation.upsertCompass({
          ...(await t.get()),
          longLines: [...(await t.get()).longLines].reverse(),
        });
      if (change === "manuscript")
        t.documents.appendVersion(t.projectId, t.document.id, {
          id: randomUUID(),
          content: "旧信被烧毁",
          source: "test",
          now: new Date().toISOString(),
        });
      if (change === "summary") {
        const old = t.state.latestSummary(
          t.projectId,
          "chapter",
          t.chapter.id,
        )!;
        t.state.upsertSummary({ ...old, summary: "重新整理的摘要" });
      }
      if (change === "outline")
        t.story.updateOutlineStatus(
          t.projectId,
          t.arc.id,
          "abandoned",
          new Date().toISOString(),
        );
      const response = await t.decide("0", "apply");
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe("story_line_proposal.stale");
      expect((await t.decide("0", "reject")).statusCode).toBe(200);
    },
  );
  it("rejects fabricated, future, duplicate, and cross-project evidence and unknown lines", async () => {
    const t = await proposalSetup();
    for (const evidenceChapterIds of [
      [t.future.id],
      [t.foreignChapter.id],
      [t.chapter.id, t.chapter.id],
      ["made-up"],
    ]) {
      await expect(
        t.review([{ ...t.proposals[0], evidenceChapterIds }]),
      ).rejects.toThrow("Evidence");
    }
    await expect(
      t.review([{ ...t.proposals[0], lineIndex: 3 }]),
    ).rejects.toThrow("lineIndex");
    await expect(t.review([t.proposals[0], t.proposals[0]])).rejects.toThrow(
      "lineIndex",
    );
  });
  it("does not use outline summaries when manuscript summaries are absent or outdated", async () => {
    const t = await proposalSetup();
    t.documents.appendVersion(t.projectId, t.document.id, {
      id: randomUUID(),
      content: "新的正文",
      source: "test",
      now: new Date().toISOString(),
    });
    await expect(t.review()).rejects.toThrow("Evidence");
    await t.review([]);
    expect((await t.app.inject({ method: "GET", url: t.url })).json()).toEqual(
      [],
    );
  });
  it("rechecks the baseline after model completion", async () => {
    const t = await proposalSetup();
    await expect(
      t.review(t.proposals, () =>
        t.automation.upsertCompass({
          ...t.automation.requireCompass(t.projectId),
          corePromise: "变更",
        }),
      ),
    ).rejects.toMatchObject({ code: "story_line_proposal.stale" });
    expect((await t.app.inject({ method: "GET", url: t.url })).json()).toEqual(
      [],
    );
  });
  it("rolls back the compass if persisting its decision fails", async () => {
    const t = await proposalSetup();
    await t.review();
    const before = await t.get();
    t.database.raw.exec(
      "CREATE TRIGGER fail_proposal BEFORE INSERT ON canon_change_set_item_decisions BEGIN SELECT RAISE(ABORT, 'test fault'); END",
    );
    expect((await t.decide("0", "apply")).statusCode).toBe(500);
    expect(await t.get()).toEqual(before);
  });
});

describe("author-maintained long story lines", () => {
  it("persists stage records, rejects stale saves, and allows simple directions without a progress record", async () => {
    const { input, line, put, get } = await setup();
    const first = await put({ ...input, expectedVersion: null });
    expect(first.statusCode, first.body).toBe(200);
    expect(await get()).toMatchObject({ ...input, version: 1 });
    const edited = {
      ...line,
      development: {
        ...line.development!,
        nextDevelopment: "先展开新地点，不收束全书",
      },
    };
    const saved = await put({
      ...input,
      longLines: [edited],
      expectedVersion: 1,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const stale = await put({ ...input, longLines: [], expectedVersion: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: { code: "compass.version.conflict" },
    });
    expect((await get()).longLines).toEqual([edited]);
    const simple = {
      title: "封闭群像",
      promise: "发展已有角色之间的信任",
      status: "open",
    };
    expect(
      (await put({ ...input, longLines: [edited, simple], expectedVersion: 2 }))
        .statusCode,
    ).toBe(200);
    expect((await get()).longLines[1]).toEqual(simple);
    expect(
      (await put({ ...input, longLines: [simple], expectedVersion: 3 }))
        .statusCode,
    ).toBe(200);
    expect(await get()).toMatchObject({
      corePromise: input.corePromise,
      constraints: input.constraints,
      longLines: [simple],
      version: 4,
    });
  });

  it("rejects foreign, missing, future, and abandoned references without changing the compass", async () => {
    const {
      input,
      line,
      put,
      get,
      chapter,
      future,
      foreignVolume,
      foreignChapter,
      story,
      projectId,
      arc,
    } = await setup();
    expect((await put({ ...input, expectedVersion: null })).statusCode).toBe(
      200,
    );
    const baseline = await get();
    for (const scopeNodeId of [foreignVolume.id, chapter.id, "missing-stage"]) {
      const result = await put({
        ...input,
        longLines: [
          { ...line, development: { ...line.development!, scopeNodeId } },
        ],
        expectedVersion: 1,
      });
      expect(result.statusCode).toBe(409);
      expect(result.json()).toMatchObject({
        error: { code: "compass.scope.invalid" },
      });
    }
    for (const evidenceChapterIds of [
      [foreignChapter.id],
      [future.id],
      [arc.id],
      ["missing-chapter"],
    ]) {
      const result = await put({
        ...input,
        longLines: [
          {
            ...line,
            development: { ...line.development!, evidenceChapterIds },
          },
        ],
        expectedVersion: 1,
      });
      expect(result.statusCode).toBe(409);
      expect(result.json()).toMatchObject({
        error: { code: "compass.evidence.invalid" },
      });
    }
    const duplicate = await put({
      ...input,
      longLines: [
        {
          ...line,
          development: {
            ...line.development!,
            evidenceChapterIds: [chapter.id, chapter.id],
          },
        },
      ],
      expectedVersion: 1,
    });
    expect(duplicate.statusCode).toBe(400);
    story.updateOutlineStatus(
      projectId,
      arc.id,
      "abandoned",
      "2026-09-20T12:00:00.000Z",
    );
    expect((await put({ ...input, expectedVersion: 1 })).json()).toMatchObject({
      error: { code: "compass.scope.invalid" },
    });
    expect(
      (
        await put({
          ...input,
          longLines: [
            {
              ...line,
              development: { ...line.development!, scopeNodeId: null },
            },
          ],
          expectedVersion: 1,
        })
      ).json(),
    ).toMatchObject({ error: { code: "compass.evidence.invalid" } });
    expect(await get()).toEqual(baseline);
  });

  it("shows only the latest review of each stage in this project without adopting suggestions", async () => {
    const {
      app,
      database,
      story,
      projectId,
      foreignId,
      foreignVolume,
      arc,
      volume,
      input,
      put,
      get,
    } = await setup();
    await put({ ...input, expectedVersion: null });
    const baseline = await get();
    const state = new SqliteNarrativeStateRepository(
      database,
      new SqliteCanonRepository(database),
      story,
    );
    const review = (id: string, node: OutlineNode, time: string) =>
      state.upsertSummary({
        id,
        projectId: node.projectId,
        scopeType: node.kind === "arc" ? "arc" : "volume",
        scopeId: node.id,
        summary: id,
        stateDelta: {
          recommendations: ["建议引入新的调查阻力"],
          compassAdjustments: ["建议调整阶段目标"],
        },
        sourceHash: id,
        createdAt: time,
      });
    review("old-arc", arc, "2026-09-20T10:00:00.000Z");
    review("latest-arc", arc, "2026-09-20T11:00:00.000Z");
    review("latest-volume", volume, "2026-09-20T12:00:00.000Z");
    review("foreign-review", foreignVolume, "2026-09-20T13:00:00.000Z");
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/compass/reviews`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject([
      {
        id: "latest-volume",
        recommendations: ["建议引入新的调查阻力"],
        compassAdjustments: ["建议调整阶段目标"],
      },
      { id: "latest-arc", outlineNodeId: arc.id },
    ]);
    expect(response.json()).toHaveLength(2);
    expect(await get()).toEqual(baseline);
    expect(
      new SqliteAutomationRepository(database).getCompass(foreignId),
    ).toBeNull();
  });

  it.each([false, true])(
    "restores stage records with new node IDs, including abandoned references (%s)",
    async (abandoned) => {
      const { app, input, put, projectId, line, story, chapter, arc } =
        await setup();
      expect((await put({ ...input, expectedVersion: null })).statusCode).toBe(
        200,
      );
      if (abandoned) {
        const remove = async (id: string) =>
          app.inject({
            method: "DELETE",
            url: `/api/projects/${projectId}/outline/${id}`,
            payload: {
              expectedUpdatedAt: story.requireOutlineNode(projectId, id)
                .updatedAt,
            },
          });
        const removedChapter = await remove(chapter.id);
        expect(removedChapter.statusCode, removedChapter.body).toBe(200);
        expect(removedChapter.json()).toMatchObject({
          disposition: "abandoned",
          references: 1,
        });
        const removedScope = await remove(arc.id);
        expect(removedScope.statusCode, removedScope.body).toBe(200);
        expect(removedScope.json()).toMatchObject({
          disposition: "abandoned",
          references: 3,
        });
      }
      const backup = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/backups`,
        payload: { label: "阶段记录" },
      });
      expect(backup.statusCode, backup.body).toBe(201);
      const restored = await app.inject({
        method: "POST",
        url: `/api/backups/${backup.json().id}/restore`,
        payload: { requestId: randomUUID(), title: "恢复故事线" },
      });
      expect(restored.statusCode, restored.body).toBe(201);
      const restoredId = restored.json().projectId as string;
      const compass = (
        await app.inject({
          method: "GET",
          url: `/api/projects/${restoredId}/compass`,
        })
      ).json() as StoryCompassDto;
      const nodes = story.listOutline(restoredId);
      const stageId = nodes.find((node) => node.title === "寻找见证者")!.id;
      const evidenceId = nodes.find((node) => node.title === "初见")!.id;
      expect(compass.longLines).toEqual([
        {
          ...line,
          development: {
            ...line.development!,
            scopeNodeId: stageId,
            evidenceChapterIds: [evidenceId],
          },
        },
      ]);
      expect(stageId).not.toBe(line.development!.scopeNodeId);
      expect(evidenceId).not.toBe(line.development!.evidenceChapterIds[0]);
      expect(nodes.find((node) => node.id === evidenceId)!.status).toBe(
        abandoned ? "abandoned" : "committed",
      );
    },
  );
});
