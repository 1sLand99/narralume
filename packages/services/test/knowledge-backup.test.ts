import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@narralume/domain";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import {
  SqliteCanonRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteStoryRepository,
} from "@narralume/persistence";
import { StoryStatePacketBuilder } from "@narralume/narrative";
import { seedStoryState } from "../../../scripts/fixtures/story-state.js";
import { DeliveryService } from "../src/delivery-service.js";
import { KnowledgeService } from "../src/knowledge-service.js";

const databases: NodeNarrativeDatabase[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const path of directories.splice(0)) {
    if (
      dirname(resolve(path)) !== resolve(tmpdir()) ||
      !basename(path).startsWith("narralume-knowledge-")
    )
      throw new Error("Unexpected test directory");
    rmSync(path, { recursive: true, force: true });
  }
});
function setup(path?: string) {
  const database = new NodeNarrativeDatabase(path);
  database.migrate();
  databases.push(database);
  return database;
}
function knowledge(database: NodeNarrativeDatabase, projectId: string) {
  const service = new KnowledgeService(database);
  return { service, data: service.read(projectId) };
}

describe("knowledge backup and restart fidelity", () => {
  it("preserves fact lineage, withdrawn claims, corrections, evidence and perspective after restore", () => {
    const db = setup();
    const fixture = seedStoryState(db);
    const projectId = fixture.projectId;
    const service = new KnowledgeService(db);
    const corrected = service.write(projectId, {
      action: "correct",
      recordId: "state-belief",
      belief: "believed",
      learnedAtNodeId: "state-c1",
      reason: "登记状态修订",
      requestId: crypto.randomUUID(),
      expectedVersion: service.read(projectId).version,
    });
    service.write(projectId, {
      action: "withdraw",
      recordId: "state-event-known",
      reason: "该章还不知道",
      requestId: crypto.randomUUID(),
      expectedVersion: service.read(projectId).version,
    });
    // History must retain references even after their claims cease to be usable.
    fixture.canon.withdrawFact({
      projectId,
      factId: "state-future-fact",
      reason: "撤回未来安排",
      withdrawnAt: "2026-09-20T00:00:00.000Z",
    });
    fixture.state.insertKnowledge({
      ...corrected.record!,
      id: "withdrawn-fact-knowledge",
      factId: "state-future-fact",
      learnedAtNodeId: "state-c13",
    });
    const event = fixture.state.listTimeline(projectId)[0]!;
    fixture.state.insertTimelineEvent({
      ...event,
      id: "voided-event",
      title: "已撤销事件",
      causes: [],
    });
    fixture.state.insertKnowledge({
      ...corrected.record!,
      id: "voided-event-knowledge",
      factId: null,
      timelineEventId: "voided-event",
    });
    fixture.state.removeTimelineEvent(
      projectId,
      "voided-event",
      "2026-09-21T00:00:00.000Z",
    );
    const delivery = new DeliveryService(db);
    const now = new Date().toISOString();
    const bundle = delivery.buildBundle(projectId, now);
    expect(bundle.manifest.version).toBe(6);
    expect(bundle.knowledgeRecords).toHaveLength(9);
    expect(bundle.knowledgeCorrections).toHaveLength(2);
    expect(bundle.facts).toHaveLength(3);
    expect(bundle.factWithdrawals).toHaveLength(1);
    expect(bundle.voidedTimeline).toHaveLength(1);
    const backup = delivery.createBackup(projectId, "history", now);
    const restored = delivery.restoreBackup(backup.id, "恢复后的认知", now);
    expect(restored.counts).toEqual(bundle.manifest.counts);
    const data = service.read(restored.projectId);
    expect(data.records).toHaveLength(9);
    expect(data.corrections.map((item) => item.reason)).toEqual(
      bundle.knowledgeCorrections.map((item) => item.reason),
    );
    expect(data.withdrawnFactIds).toHaveLength(1);
    expect(data.voidedEventIds).toHaveLength(1);
    const oldFact = data.facts.find((item) => item.value === "议会")!;
    const newFact = data.facts.find((item) => item.value === "守灯人")!;
    expect(newFact.supersedesFactId).toBe(oldFact.id);
    expect(oldFact.id).not.toBe("state-old-fact");
    expect(
      data.records.find((item) => item.factId === data.withdrawnFactIds[0]),
    ).toBeTruthy();
    expect(
      data.records.find(
        (item) => item.timelineEventId === data.voidedEventIds[0],
      ),
    ).toBeTruthy();
    expect(
      data.corrections.every(
        (item) =>
          data.records.some((record) => record.id === item.recordId) &&
          (!item.replacementRecordId ||
            data.records.some(
              (record) => record.id === item.replacementRecordId,
            )),
      ),
    ).toBe(true);
    expect(
      data.records.every(
        (item) =>
          item.projectId === restored.projectId &&
          data.outline.some((node) => node.id === item.learnedAtNodeId),
      ),
    ).toBe(true);
    const story = new SqliteStoryRepository(db);
    const canon = new SqliteCanonRepository(db);
    const state = new SqliteNarrativeStateRepository(db, canon, story);
    const builder = new StoryStatePacketBuilder(canon, state, story);
    const hero = data.entities.find((item) => item.name === fixture.hero.name)!;
    const chapter = (ordinal: number) =>
      data.outline.find(
        (node) =>
          node.kind === "chapter" &&
          node.ordinal === ordinal &&
          node.title.startsWith(`第${ordinal + 1}章`),
      )!;
    const early = builder.snapshot({
      projectId: restored.projectId,
      audience: "character",
      characterId: hero.id,
      targetOutlineNodeId: chapter(1).id,
    });
    expect(early.knowledge.find((item) => item.fact)?.record.belief).toBe(
      "believed",
    );
    const later = builder.snapshot({
      projectId: restored.projectId,
      audience: "character",
      characterId: hero.id,
      targetOutlineNodeId: chapter(11).id,
    });
    expect(later.knowledge.find((item) => item.fact)?.fact?.value).toBe(
      "守灯人",
    );
    expect(later.knowledge.find((item) => item.event)?.record.belief).toBe(
      "suspected",
    );
    expect(later.knowledge).toHaveLength(2);
    expect(db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("preserves equal-time knowledge ordering when duplication changes IDs", () => {
    const db = setup();
    const fixture = seedStoryState(db);
    const original = fixture.state
      .listKnowledge(fixture.projectId)
      .find((item) => item.id === "state-reader")!;
    fixture.state.insertKnowledge({
      ...original,
      id: "z-final-reader",
      belief: "suspected",
    });
    const newId = new DeliveryService(db).duplicateProject(
      fixture.projectId,
      "copy",
      new Date().toISOString(),
    );
    const data = knowledge(db, newId).data;
    const latest = data.records
      .filter((record) => record.knowerType === "reader")
      .at(-1)!;
    expect(latest.belief).toBe("suspected");
    expect(latest.createdAt).toBe(original.createdAt);
  });

  it("rejects a missing historical dependency and rolls back the whole restored project", () => {
    const db = setup();
    const fixture = seedStoryState(db);
    const delivery = new DeliveryService(db);
    const now = new Date().toISOString();
    const bundle = delivery.buildBundle(fixture.projectId, now);
    bundle.knowledgeRecords[0]!.factId = "missing-fact";
    bundle.knowledgeRecords[0]!.timelineEventId = null;
    const backup = delivery.createBackup(fixture.projectId, "broken", now);
    const json = JSON.stringify(bundle);
    db.raw
      .prepare(
        "UPDATE project_backups SET bundle_json = ?, bundle_hash = ? WHERE id = ?",
      )
      .run(json, sha256Hex(json), backup.id);
    const before = new SqliteProjectRepository(db).list();
    expect(() => delivery.restoreBackup(backup.id, "incomplete", now)).toThrow(
      "reference is missing",
    );
    expect(new SqliteProjectRepository(db).list()).toEqual(before);
  });

  it("persists corrections and request replays across reopening and blocks a second connection's stale edit", () => {
    const path = mkdtempSync(join(tmpdir(), "narralume-knowledge-"));
    directories.push(path);
    const db = setup(join(path, "state.sqlite"));
    const fixture = seedStoryState(db);
    const second = setup(db.path);
    const service = new KnowledgeService(db);
    const stale = new KnowledgeService(second).read(fixture.projectId);
    const body = {
      action: "correct" as const,
      recordId: "state-reader",
      belief: "known" as const,
      learnedAtNodeId: "state-scene",
      reason: "正文已明示",
      requestId: crypto.randomUUID(),
      expectedVersion: stale.version,
    };
    const written = service.write(fixture.projectId, body);
    expect(() =>
      new KnowledgeService(second).write(fixture.projectId, {
        ...body,
        requestId: crypto.randomUUID(),
        belief: "false_belief",
      }),
    ).toThrow("changed; reload");
    const filePath = db.path;
    for (const connection of [second, db]) {
      connection.close();
      databases.splice(databases.indexOf(connection), 1);
    }
    const reopened = setup(filePath);
    const result = new KnowledgeService(reopened).write(
      fixture.projectId,
      body,
    );
    expect(result.idempotentReplay).toBe(true);
    expect(result.record?.id).toBe(written.record?.id);
    expect(
      knowledge(reopened, fixture.projectId).data.corrections,
    ).toHaveLength(1);
  });
});
