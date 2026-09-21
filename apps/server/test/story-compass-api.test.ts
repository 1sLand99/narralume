import { randomUUID } from "node:crypto";
import type { StoryCompassDto, StoryLongLineDto } from "@narralume/contracts";
import { createOutlineNode, type OutlineNode } from "@narralume/domain";
import {
  SqliteAutomationRepository,
  SqliteCanonRepository,
  SqliteNarrativeStateRepository,
  SqliteStoryRepository,
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
