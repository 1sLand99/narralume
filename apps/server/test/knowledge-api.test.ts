import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCanonEntity,
  createOutlineNode,
  createProject,
  sha256Hex,
} from "@narralume/domain";
import {
  KnowledgeEditorSchema,
  KnowledgeWriteResultSchema,
  StoryStateSnapshotSchema,
} from "@narralume/contracts";
import { SqliteProjectRepository } from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { StoryStatePacketBuilder } from "@narralume/narrative";
import { seedStoryState } from "../../../scripts/fixtures/story-state.js";
import { buildApp } from "../src/app.js";

let database: NodeNarrativeDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let fixture: ReturnType<typeof seedStoryState>;
const url = "/api/projects/state-fixture/knowledge";
beforeEach(async () => {
  database = new NodeNarrativeDatabase();
  app = await buildApp({
    database,
    config: {
      dataDirectory: ".",
      databasePath: ":memory:",
      host: "127.0.0.1",
      port: 4317,
      environment: "test",
    },
    environment: {},
    logger: false,
    enableRunWorker: false,
  });
  fixture = seedStoryState(database);
});
afterEach(async () => {
  await app.close();
  database.close();
});
async function read() {
  const response = await app.inject({ url });
  expect(response.statusCode, response.body).toBe(200);
  return KnowledgeEditorSchema.parse(response.json());
}
async function payload(fields: Record<string, unknown> = {}) {
  return {
    requestId: crypto.randomUUID(),
    expectedVersion: (await read()).version,
    action: "register",
    knowerType: "character",
    knowerEntityId: "state-hero",
    factId: "state-old-fact",
    timelineEventId: null,
    learnedAtNodeId: "state-c4",
    belief: "suspected",
    ...fields,
  };
}
async function write(body: unknown, status = 200) {
  const response = await app.inject({
    method: "POST",
    url,
    payload: body as object,
  });
  expect(response.statusCode, response.body).toBe(status);
  return response;
}
async function change(fields: Record<string, unknown>) {
  const response = await write({
    requestId: crypto.randomUUID(),
    expectedVersion: (await read()).version,
    ...fields,
  });
  return KnowledgeWriteResultSchema.parse(response.json());
}
async function snapshot(
  chapter: string,
  audience = "character&characterId=state-hero",
) {
  const response = await app.inject({
    url: `/api/projects/state-fixture/story-state?chapterId=${chapter}&audience=${audience}`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return StoryStateSnapshotSchema.parse(response.json());
}

describe("manual knowledge maintenance", () => {
  it("reads an author maintenance snapshot without changing data", async () => {
    const before = database.raw.prepare("SELECT total_changes() AS n").get();
    const data = await read();
    expect(data.records).toHaveLength(6);
    expect(data.facts.some((fact) => fact.id === "state-future-fact")).toBe(
      true,
    );
    expect(data.eligibleNodeIds).toContain("state-scene");
    expect(data.eligibleNodeIds).not.toContain("state-vz");
    expect((await read()).version).toBe(data.version);
    expect(database.raw.prepare("SELECT total_changes() AS n").get()).toEqual(
      before,
    );
  });

  it("backdates learning without overwriting later knowledge or changing canon", async () => {
    const before = fixture.canon.listFactHistory(fixture.projectId);
    const response = await write(await payload());
    const result = KnowledgeWriteResultSchema.parse(response.json());
    expect(result.record).toMatchObject({
      sourceId: "manual",
      learnedAtNodeId: "state-c4",
    });
    expect(
      (await snapshot("state-c2")).knowledge.find((item) => item.fact)?.record
        .belief,
    ).toBe("false_belief");
    expect(
      (await snapshot("state-c4")).knowledge.find((item) => item.fact)?.record
        .id,
    ).toBe(result.record!.id);
    expect(
      (await snapshot("state-c12")).knowledge.find((item) => item.fact)?.record
        .id,
    ).toBe("state-learned");
    expect(fixture.canon.listFactHistory(fixture.projectId)).toEqual(before);
  });

  it("records a reader's explicit knowledge only from its evidence onward", async () => {
    await write(
      await payload({
        knowerType: "reader",
        knowerEntityId: null,
        factId: "state-new-fact",
        belief: "known",
        learnedAtNodeId: "state-scene",
      }),
    );
    expect((await snapshot("state-c1", "reader")).knowledge).toEqual([]);
    const reader = await snapshot("state-c2", "reader");
    expect(reader.knowledge.find((item) => item.fact)?.fact?.value).toBe(
      "守灯人",
    );
    expect(
      (await snapshot("state-c2")).knowledge.find((item) => item.fact)?.record
        .belief,
    ).toBe("false_belief");
  });

  it("corrects belief and evidence atomically and uses the correction in generation", async () => {
    const body = {
      requestId: crypto.randomUUID(),
      expectedVersion: (await read()).version,
      action: "correct",
      recordId: "state-belief",
      belief: "believed",
      learnedAtNodeId: "state-scene",
      reason: "原登记把尚未确认的判断记成了误信",
    };
    const result = KnowledgeWriteResultSchema.parse((await write(body)).json());
    expect(result.correction).toMatchObject({
      recordId: "state-belief",
      replacementRecordId: result.record!.id,
      reason: body.reason,
    });
    expect((await snapshot("state-c1")).knowledge).toEqual([]);
    expect(
      (await snapshot("state-c2")).knowledge.find((item) => item.fact)?.record
        .belief,
    ).toBe("believed");
    expect(
      (await snapshot("state-c12")).knowledge.find((item) => item.fact)?.record
        .id,
    ).toBe("state-learned");
    expect(
      fixture.state
        .listKnowledge(fixture.projectId)
        .some((record) => record.id === "state-belief"),
    ).toBe(false);
    expect(
      (await read()).records.find((record) => record.id === "state-belief")
        ?.belief,
    ).toBe("false_belief");
    const packet = new StoryStatePacketBuilder(
      fixture.canon,
      fixture.state,
      fixture.story,
    ).build({
      projectId: fixture.projectId,
      audience: "character",
      characterId: "state-hero",
      targetOutlineNodeId: "state-c2",
    });
    expect(JSON.stringify(packet.sources)).toContain(result.record!.id);
    expect(JSON.stringify(packet.sources)).not.toContain("state-belief");
    expect(JSON.stringify(packet.sources)).not.toContain(body.reason);
    expect(
      KnowledgeWriteResultSchema.parse((await write(body)).json())
        .idempotentReplay,
    ).toBe(true);
    expect((await read()).corrections).toHaveLength(1);
  });

  it("withdraws an erroneous later record and reveals earlier knowledge without deleting history", async () => {
    const result = await change({
      action: "withdraw",
      recordId: "state-event-known",
      reason: "此处还没有得知真相",
    });
    expect(result.record).toBeNull();
    expect(result.correction?.replacementRecordId).toBeNull();
    const view = await snapshot("state-c12");
    expect(view.knowledge.find((item) => item.event)?.record.id).toBe(
      "state-suspicion",
    );
    expect(view.timeline).toEqual([]);
    expect((await read()).records).toHaveLength(6);
    const before = fixture.state.listKnowledge(fixture.projectId);
    const response = await write(
      {
        requestId: crypto.randomUUID(),
        expectedVersion: (await read()).version,
        action: "withdraw",
        recordId: "state-event-known",
        reason: "重复撤销",
      },
      409,
    );
    expect(response.json().error.code).toBe("knowledge.record_unavailable");
    expect(fixture.state.listKnowledge(fixture.projectId)).toEqual(before);
  });

  it("replays lost responses before comparing versions and rejects request ID reuse", async () => {
    const body = await payload();
    const first = KnowledgeWriteResultSchema.parse((await write(body)).json());
    await change({
      action: "withdraw",
      recordId: "state-reader",
      reason: "另一项维护",
    });
    const replay = KnowledgeWriteResultSchema.parse((await write(body)).json());
    expect(replay.record?.id).toBe(first.record?.id);
    expect(replay.idempotentReplay).toBe(true);
    expect(
      (await write({ ...body, belief: "known" }, 409)).json().error.code,
    ).toBe("knowledge.idempotency_conflict");
    expect((await read()).records).toHaveLength(7);
  });

  it("accepts only one concurrent edit from the same baseline", async () => {
    const body = await payload();
    const responses = await Promise.all([
      app.inject({ method: "POST", url, payload: body }),
      app.inject({
        method: "POST",
        url,
        payload: { ...body, requestId: crypto.randomUUID(), belief: "known" },
      }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(
      responses.find((response) => response.statusCode === 409)!.json().error
        .code,
    ).toBe("knowledge.version_conflict");
    expect((await read()).records).toHaveLength(7);
  });

  it.each(["fact", "event", "entity", "outline", "settlement"])(
    "rejects stale input after a referenced %s changes",
    async (kind) => {
      const body = await payload();
      if (kind === "fact")
        fixture.canon.withdrawFact({
          projectId: fixture.projectId,
          factId: fixture.oldFact.id,
          reason: "修订事实",
          withdrawnAt: new Date().toISOString(),
        });
      if (kind === "event")
        fixture.state.updateTimelineEvent({
          ...fixture.state.listTimeline(fixture.projectId)[0]!,
          title: "另一事件标题",
        });
      if (kind === "entity")
        database.raw
          .prepare("UPDATE canon_entities SET name = 'new name' WHERE id = ?")
          .run(fixture.hero.id);
      if (kind === "outline")
        fixture.story.updateOutlineStatus(
          fixture.projectId,
          "state-c4",
          "drafting",
          new Date().toISOString(),
        );
      if (kind === "settlement")
        fixture.state.insertKnowledge({
          ...fixture.state.listKnowledge(fixture.projectId)[0]!,
          id: "ai-new-record",
          learnedAtNodeId: "state-c3",
        });
      expect((await write(body, 409)).json().error.code).toBe(
        "knowledge.version_conflict",
      );
    },
  );

  it("rejects duplicate nodes and changes to the same fact lineage", async () => {
    expect(
      (await write(await payload({ learnedAtNodeId: "state-c1" }), 409)).json()
        .error.code,
    ).toBe("knowledge.duplicate");
    expect(
      (
        await write(
          await payload({
            factId: "state-old-fact",
            learnedAtNodeId: "state-c12",
          }),
          409,
        )
      ).json().error.code,
    ).toBe("knowledge.duplicate");
    expect(
      (
        await write(
          await payload({
            factId: "state-new-fact",
            learnedAtNodeId: "state-c1",
          }),
          409,
        )
      ).json().error.code,
    ).toBe("knowledge.future_claim");
    expect(
      (
        await write(
          await payload({
            factId: null,
            timelineEventId: "state-event",
            learnedAtNodeId: "state-c1",
          }),
          409,
        )
      ).json().error.code,
    ).toBe("knowledge.future_claim");
  });

  it("does not expose withdrawn claims, while allowing historical maintenance for retired characters", async () => {
    fixture.canon.withdrawFact({
      projectId: fixture.projectId,
      factId: fixture.oldFact.id,
      reason: "撤销错误事实",
      withdrawnAt: new Date().toISOString(),
    });
    expect((await write(await payload(), 409)).json().error.code).toBe(
      "knowledge.claim_unavailable",
    );
    fixture.state.removeTimelineEvent(
      fixture.projectId,
      "state-event",
      new Date().toISOString(),
    );
    expect(
      (
        await write(
          await payload({ factId: null, timelineEventId: "state-event" }),
          409,
        )
      ).json().error.code,
    ).toBe("knowledge.claim_unavailable");
    fixture.canon.insertFact({
      ...fixture.newFact,
      id: "candidate",
      authority: "candidate",
      supersedesFactId: null,
    });
    expect(
      (await write(await payload({ factId: "candidate" }), 409)).json().error
        .code,
    ).toBe("knowledge.claim_unavailable");
    database.raw
      .prepare("UPDATE canon_entities SET status = 'retired' WHERE id = ?")
      .run(fixture.hero.id);
    await write(await payload({ factId: fixture.newFact.id }));
    await change({
      action: "correct",
      recordId: "state-learned",
      belief: "believed",
      learnedAtNodeId: "state-c12",
      reason: "补正已退役人物的历史",
    });
    const current = await read();
    expect(current.corrections).toHaveLength(1);
  });

  it("keeps a fact lineage together across a withdrawn intermediate revision", async () => {
    fixture.canon.insertFact({
      ...fixture.newFact,
      id: "third-fact",
      value: "新的守灯人",
      supersedesFactId: fixture.newFact.id,
      validFromNodeId: "state-c3",
    });
    fixture.canon.withdrawFact({
      projectId: fixture.projectId,
      factId: fixture.newFact.id,
      reason: "第二条登记撤回",
      withdrawnAt: new Date().toISOString(),
    });
    await write(await payload({ factId: "third-fact", belief: "known" }));
    expect(
      (await snapshot("state-c4")).knowledge.filter((item) => item.fact),
    ).toHaveLength(1);
    expect(
      (await snapshot("state-c4")).knowledge.find((item) => item.fact)?.fact
        ?.id,
    ).toBe("third-fact");
  });

  it("requires committed evidence, active references and an unambiguous payload", async () => {
    fixture.story.updateOutlineStatus(
      fixture.projectId,
      "state-c4",
      "planned",
      new Date().toISOString(),
    );
    expect((await write(await payload(), 409)).json().error.code).toBe(
      "knowledge.evidence_unavailable",
    );
    fixture.story.updateOutlineStatus(
      fixture.projectId,
      "state-vz",
      "abandoned",
      new Date().toISOString(),
    );
    expect((await read()).eligibleNodeIds).not.toContain("state-scene");
    expect(
      (
        await write(await payload({ learnedAtNodeId: "state-scene" }), 409)
      ).json().error.code,
    ).toBe("knowledge.evidence_unavailable");
    for (const fields of [
      { factId: null },
      { timelineEventId: "state-event" },
      { knowerType: "reader" },
      { knowerEntityId: null },
    ])
      await write(await payload(fields), 400);
    await write(
      {
        action: "withdraw",
        recordId: "state-reader",
        reason: " ",
        requestId: crypto.randomUUID(),
        expectedVersion: (await read()).version,
      },
      400,
    );
    await write(
      {
        action: "correct",
        recordId: "state-reader",
        reason: "change actor",
        belief: "known",
        learnedAtNodeId: "state-scene",
        knowerEntityId: "state-hero",
        requestId: crypto.randomUUID(),
        expectedVersion: (await read()).version,
      },
      422,
    );
  });

  it("rejects references from another project and recycled projects", async () => {
    const now = new Date().toISOString();
    const projects = new SqliteProjectRepository(database);
    projects.insert(createProject({ id: "foreign", title: "Other", now }));
    const book = createOutlineNode({
      id: "foreign-book",
      projectId: "foreign",
      parent: null,
      kind: "book",
      ordinal: 0,
      title: "Other",
      now,
    });
    fixture.story.insertOutlineNode(book);
    fixture.canon.insertEntity(
      createCanonEntity({
        id: "foreign-character",
        projectId: "foreign",
        name: "Other",
        type: "character",
        now,
      }),
    );
    fixture.canon.insertFact({
      ...fixture.oldFact,
      id: "foreign-fact",
      projectId: "foreign",
      subjectId: "foreign-character",
      knowledgeSubjectId: "foreign-character",
      validFromNodeId: null,
    });
    for (const [fields, code] of [
      [{ factId: "foreign-fact" }, "knowledge.claim_unavailable"],
      [
        { knowerEntityId: "foreign-character" },
        "knowledge.character_unavailable",
      ],
      [{ learnedAtNodeId: "foreign-book" }, "knowledge.evidence_unavailable"],
    ] as const)
      expect((await write(await payload(fields), 409)).json().error.code).toBe(
        code,
      );
    const body = await payload();
    database.raw
      .prepare("UPDATE projects SET deleted_at = ? WHERE id = ?")
      .run(now, fixture.projectId);
    expect((await write(body, 404)).json().error.code).toBe(
      "project.not_found",
    );
    expect((await app.inject({ url })).statusCode).toBe(404);
    expect(() =>
      fixture.state.insertKnowledgeCorrection({
        recordId: "state-reader",
        projectId: fixture.projectId,
        replacementRecordId: null,
        reason: "blocked write",
        createdAt: now,
      }),
    ).toThrow("project.not_found");
  });

  it("keeps snapshot metadata readable while rejecting unsupported bundle formats without restoring", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/state-fixture/backups",
      payload: { label: "prior snapshot" },
    });
    expect(response.statusCode, response.body).toBe(201);
    const backupId = response.json().id as string;
    const row = database.raw
      .prepare("SELECT bundle_json FROM project_backups WHERE id = ?")
      .get(backupId) as { bundle_json: string };
    const bundle = JSON.parse(row.bundle_json) as {
      manifest: { version: number };
    };
    bundle.manifest.version = 5;
    const json = JSON.stringify(bundle);
    database.raw
      .prepare(
        "UPDATE project_backups SET bundle_json = ?, bundle_hash = ?, counts_json = ? WHERE id = ?",
      )
      .run(json, sha256Hex(json), JSON.stringify({ outline: 17 }), backupId);
    const listing = await app.inject({
      url: "/api/projects/state-fixture/backups",
    });
    expect(listing.statusCode, listing.body).toBe(200);
    expect(listing.json()[0].counts).toEqual({ outline: 17 });
    const before = new SqliteProjectRepository(database).list();
    const restore = await app.inject({
      method: "POST",
      url: `/api/backups/${backupId}/restore`,
      payload: { requestId: crypto.randomUUID() },
    });
    expect(restore.statusCode, restore.body).toBe(422);
    expect(restore.json().error.code).toBe("import.bundle.invalid_schema");
    expect(new SqliteProjectRepository(database).list()).toEqual(before);
  });

  it("rolls back replacement and replay if appending the correction fails", async () => {
    const body = {
      requestId: crypto.randomUUID(),
      expectedVersion: (await read()).version,
      action: "correct",
      recordId: "state-reader",
      belief: "known",
      learnedAtNodeId: "state-c3",
      reason: "核对正文",
    };
    database.raw.exec(
      "CREATE TRIGGER fail_knowledge_correction BEFORE INSERT ON knowledge_corrections BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    await write(body, 500);
    expect((await read()).records).toHaveLength(6);
    expect((await read()).corrections).toEqual([]);
    expect((await read()).version).toBe(body.expectedVersion);
    database.raw.exec("DROP TRIGGER fail_knowledge_correction");
    await write(body);
    expect((await read()).records).toHaveLength(7);
  });
});
