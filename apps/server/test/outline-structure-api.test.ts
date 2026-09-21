import { randomUUID } from "node:crypto";
import type {
  OutlineChangeRequest,
  OutlineChangePreview,
} from "@narralume/contracts";
import {
  createDocument,
  createOutlineNode,
  type OutlineNode,
} from "@narralume/domain";
import {
  chapterOutlineIsCurrent,
  outlineStructureFingerprint,
} from "@narralume/narrative";
import {
  SqliteCanonRepository,
  SqliteDocumentRepository,
  SqliteNarrativeStateRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { applyOutlineChangeViaApi } from "./outline-change-helper.js";

const resources: {
  app: Awaited<ReturnType<typeof buildApp>>;
  database: NodeNarrativeDatabase;
}[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close();
    resource.database.close();
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
  const projectId = (
    await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { requestId: randomUUID(), title: "结构调整" },
    })
  ).json().id as string;
  const story = new SqliteStoryRepository(database);
  const root = story.listOutline(projectId)[0]!;
  const now = "2026-09-20T08:00:00.000Z";
  const node = (
    parent: OutlineNode,
    kind: OutlineNode["kind"],
    title: string,
    ordinal = 0,
  ) =>
    story.insertOutlineNode(
      createOutlineNode({
        id: randomUUID(),
        projectId,
        parent,
        kind,
        title,
        ordinal,
        now,
      }),
    );
  const volumeA = node(root, "volume", "First volume");
  const arcA = node(volumeA, "arc", "First arc");
  const a = node(arcA, "chapter", "First chapter");
  const scene = node(a, "scene", "Scene");
  const beat = node(scene, "beat", "Beat");
  const b = node(arcA, "chapter", "Second chapter", 1);
  const volumeB = node(root, "volume", "Second volume", 1);
  const arcB = node(volumeB, "arc", "Second arc");
  const c = node(arcB, "chapter", "Third chapter");
  const state = new SqliteNarrativeStateRepository(
    database,
    new SqliteCanonRepository(database),
    story,
  );
  const clue = state.insertForeshadow({
    id: randomUUID(),
    projectId,
    title: "A promise",
    description: "A promise made in the first chapter",
    status: "planted",
    importance: 3,
    targetFromNodeId: a.id,
    targetToNodeId: b.id,
    resolutionNodeId: null,
    dependencies: [],
    evidenceNodeIds: [scene.id],
    createdAt: now,
    updatedAt: now,
  });
  const runs = new SqliteRunRepository(database);
  const startRun = (
    kind: "context.compile" | "outline.generate",
    succeeded = true,
  ) => {
    const id = randomUUID(),
      stepId = `${id}:step`;
    runs.create({
      id,
      projectId,
      recipe: "test",
      recipeVersion: 1,
      mode: "autopilot",
      targetOutlineNodeId: b.id,
      policy: {},
      steps: [
        {
          id: stepId,
          kind,
          ordinal: 0,
          cycle: 0,
          idempotencyKey: stepId,
          maxAttempts: 1,
        },
      ],
      now,
    });
    runs.startStep(id, stepId, now);
    if (succeeded)
      runs.succeedStep(
        id,
        stepId,
        {
          outlineStructureFingerprint: outlineStructureFingerprint(
            story.listOutline(projectId),
          ),
        },
        "context",
        now,
      );
    return id;
  };
  const move = (
    parent = arcB,
    beforeNodeId: string | null = c.id,
  ): OutlineChangeRequest => ({
    kind: "move",
    nodeId: a.id,
    parentId: parent.id,
    beforeNodeId,
    expectedUpdatedAt: a.updatedAt,
    expectedParentUpdatedAt: parent.updatedAt,
  });
  const preview = (change: OutlineChangeRequest) =>
    app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/outline/changes/preview`,
      payload: change,
    });
  const apply = (change: OutlineChangeRequest, fingerprint: string) =>
    app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/outline/changes`,
      payload: { change, previewFingerprint: fingerprint },
    });
  return {
    app,
    database,
    projectId,
    story,
    state,
    runs,
    root,
    volumeA,
    volumeB,
    arcA,
    arcB,
    a,
    b,
    c,
    scene,
    beat,
    clue,
    startRun,
    move,
    preview,
    apply,
    now,
  };
}

describe("outline structure changes", () => {
  it("previews actual windows and materialized tasks without writing, then moves the complete subtree", async () => {
    const f = await setup();
    const chapterRun = f.startRun("context.compile");
    const planningRun = f.startRun("outline.generate", false);
    const before = f.story.listOutline(f.projectId);
    const change = f.move();
    const response = await f.preview(change);
    expect(response.statusCode, response.body).toBe(200);
    const preview = response.json() as OutlineChangePreview;
    expect(f.story.listOutline(f.projectId)).toEqual(before);
    expect((await f.preview(change)).json()).toEqual(preview);
    expect(preview.affectedRuns).toEqual(
      expect.arrayContaining([
        { id: chapterRun, outlineNodeId: f.b.id, reason: "chapter_context" },
        { id: planningRun, outlineNodeId: f.b.id, reason: "rolling_plan" },
      ]),
    );
    expect(preview.foreshadowWindows).toEqual([
      {
        id: f.clue.id,
        title: f.clue.title,
        fromNodeId: f.a.id,
        toNodeId: f.b.id,
        beforeChapterIds: [f.a.id, f.b.id],
        afterChapterIds: [],
        inverted: true,
      },
    ]);
    expect(
      preview.changedChapters.find((node) => node.id === f.a.id),
    ).toMatchObject({
      fromParentId: f.arcA.id,
      toParentId: f.arcB.id,
      fromPosition: 1,
      toPosition: 2,
    });
    const applied = await f.apply(change, preview.fingerprint);
    expect(applied.statusCode, applied.body).toBe(200);
    const after = f.story.listOutline(f.projectId);
    expect(
      after.filter((node) => node.kind === "chapter").map((node) => node.id),
    ).toEqual([f.b.id, f.a.id, f.c.id]);
    expect(f.story.requireOutlineNode(f.projectId, f.a.id)).toMatchObject({
      parentId: f.arcB.id,
      path: `${f.arcB.path}/${f.a.id}`,
      ordinal: 0,
    });
    expect(f.story.requireOutlineNode(f.projectId, f.scene.id)).toMatchObject({
      parentId: f.a.id,
      path: `${f.arcB.path}/${f.a.id}/${f.scene.id}`,
      depth: f.arcB.depth + 2,
    });
    expect(f.story.requireOutlineNode(f.projectId, f.beat.id)).toMatchObject({
      parentId: f.scene.id,
      path: `${f.arcB.path}/${f.a.id}/${f.scene.id}/${f.beat.id}`,
      depth: f.arcB.depth + 3,
    });
    expect(
      f.story
        .listOutlineChildren(f.projectId, f.arcA.id)
        .map((node) => node.ordinal),
    ).toEqual([0]);
    expect(f.state.listForeshadows(f.projectId)).toEqual([f.clue]);
    expect(
      chapterOutlineIsCurrent(f.database, f.runs.getSnapshot(chapterRun)),
    ).toBe(false);
  });

  it.each(["volume", "book"] as const)(
    "updates descendant depth when moving to a %s",
    async (kind) => {
      const f = await setup();
      const parent = kind === "volume" ? f.volumeB : f.root;
      const response = await applyOutlineChangeViaApi(
        f.app,
        f.projectId,
        f.move(parent, null),
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(f.story.requireOutlineNode(f.projectId, f.beat.id)).toMatchObject({
        depth: parent.depth + 3,
        path: `${parent.path}/${f.a.id}/${f.scene.id}/${f.beat.id}`,
      });
    },
  );

  it.each(["outline", "foreshadow", "run", "document"] as const)(
    "rejects a preview when %s state changes before saving",
    async (field) => {
      const f = await setup();
      const change = f.move();
      const fingerprint = (await f.preview(change)).json()
        .fingerprint as string;
      if (field === "outline")
        f.story.updateOutlineDetails(
          f.projectId,
          f.b.id,
          { title: "Changed title" },
          new Date().toISOString(),
        );
      if (field === "foreshadow")
        f.state.insertForeshadow({
          ...f.clue,
          id: randomUUID(),
          title: "New promise",
        });
      if (field === "run") f.startRun("context.compile", false);
      if (field === "document")
        new SqliteDocumentRepository(f.database).insert(
          createDocument({
            id: randomUUID(),
            projectId: f.projectId,
            kind: "note",
            title: "Scene content",
            outlineNodeId: f.scene.id,
            now: f.now,
          }),
        );
      const before = f.story.listOutline(f.projectId);
      const response = await f.apply(change, fingerprint);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          code:
            field === "document"
              ? "outline.reorder.protected"
              : "outline.preview.stale",
        },
      });
      expect(f.story.listOutline(f.projectId)).toEqual(before);
    },
  );

  it("protects written chronology, subtree contents, invalid destinations and preview identity", async () => {
    const f = await setup();
    const before = f.story.listOutline(f.projectId);
    for (const change of [
      f.move(f.arcA, f.b.id),
      f.move(f.scene, null),
      f.move(f.a, null),
      f.move(f.arcB, f.b.id),
    ]) {
      expect((await f.preview(change)).statusCode).toBe(409);
      expect(f.story.listOutline(f.projectId)).toEqual(before);
    }
    const another = (
      await f.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { requestId: randomUUID(), title: "Other" },
      })
    ).json().id as string;
    const otherRoot = f.story.listOutline(another)[0]!;
    expect((await f.preview(f.move(otherRoot, null))).statusCode).toBe(404);
    const valid = (await f.preview(f.move())).json().fingerprint as string;
    expect(
      (await f.apply(f.move(f.volumeB, null), valid)).json(),
    ).toMatchObject({ error: { code: "outline.preview.stale" } });
    f.story.updateOutlineStatus(f.projectId, f.volumeB.id, "abandoned", f.now);
    expect((await f.preview(f.move())).json()).toMatchObject({
      error: { code: "outline.move.target_invalid" },
    });
    f.story.updateOutlineStatus(f.projectId, f.volumeB.id, "planned", f.now);
    f.story.updateOutlineStatus(f.projectId, f.b.id, "committed", f.now);
    expect((await f.preview(f.move())).json()).toMatchObject({
      error: { code: "outline.reorder.protected" },
    });
    f.story.updateOutlineStatus(f.projectId, f.b.id, "planned", f.now);
    f.story.updateOutlineStatus(f.projectId, f.scene.id, "drafting", f.now);
    expect((await f.preview(f.move())).json()).toMatchObject({
      error: { code: "outline.reorder.protected" },
    });
  });

  it("rolls back every placement when updating a descendant fails", async () => {
    const f = await setup();
    const before = f.story.listOutline(f.projectId);
    f.database.raw
      .exec(`CREATE TRIGGER fail_descendant BEFORE UPDATE OF path ON outline_nodes
      WHEN OLD.kind = 'beat' AND OLD.path != NEW.path BEGIN SELECT RAISE(ABORT, 'injected descendant failure'); END`);
    const response = await applyOutlineChangeViaApi(
      f.app,
      f.projectId,
      f.move(),
    );
    expect(response.statusCode).toBe(500);
    expect(f.story.listOutline(f.projectId)).toEqual(before);
  });

  it("does not move a chapter across written scenes directly under an arc", async () => {
    const f = await setup();
    const standalone = f.story.insertOutlineNode(
      createOutlineNode({
        id: randomUUID(),
        projectId: f.projectId,
        parent: f.arcB,
        kind: "scene",
        title: "Written scene",
        ordinal: 1,
        now: f.now,
      }),
    );
    new SqliteDocumentRepository(f.database).insert(
      createDocument({
        id: randomUUID(),
        projectId: f.projectId,
        kind: "note",
        title: "Scene prose",
        outlineNodeId: standalone.id,
        now: f.now,
      }),
    );
    const response = await f.preview(f.move(f.arcB, null));
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "outline.reorder.protected" },
    });
  });
});
