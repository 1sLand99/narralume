import {
  KnowledgeEditorSchema,
  KnowledgeWriteResultSchema,
  type KnowledgeEditorDto,
  type KnowledgeWrite,
  type KnowledgeWriteResult,
} from "@narralume/contracts";
import type { KnowledgeCorrection, KnowledgeRecord } from "@narralume/domain";
import {
  buildOutlineScope,
  factLineage,
  nodeIsNotAfterTarget,
} from "@narralume/narrative";
import {
  SqliteCanonRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteRequestReplayRepository,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";
import { randomUuid } from "./internal/crypto.js";
import { hashRequest } from "./request-idempotency.js";
import { StoryServiceError } from "./story-service.js";

export class KnowledgeService {
  private readonly projects;
  private readonly canon;
  private readonly story;
  private readonly state;
  private readonly replays;

  constructor(private readonly database: NarrativeDatabase) {
    this.projects = new SqliteProjectRepository(database);
    this.canon = new SqliteCanonRepository(database);
    this.story = new SqliteStoryRepository(database);
    this.state = new SqliteNarrativeStateRepository(
      database,
      this.canon,
      this.story,
    );
    this.replays = new SqliteRequestReplayRepository(database);
  }

  read(projectId: string): KnowledgeEditorDto {
    return this.database.transaction(() => this.snapshot(projectId));
  }

  write(projectId: string, input: KnowledgeWrite): KnowledgeWriteResult {
    return this.database.transaction(() => {
      this.requireProject(projectId);
      const scope = `project:${projectId}:knowledge`;
      const requestHash = hashRequest(input);
      const replay = this.replays.get(scope, input.requestId);
      if (replay) {
        if (replay.requestHash !== requestHash)
          fail(
            "idempotency_conflict",
            "This request ID was used for different knowledge changes",
          );
        return {
          ...KnowledgeWriteResultSchema.parse(replay.result),
          idempotentReplay: true,
        };
      }
      const snapshot = this.snapshot(projectId);
      if (input.expectedVersion !== snapshot.version)
        fail(
          "version_conflict",
          "Knowledge or its references changed; reload before saving",
        );
      const corrected = new Set(
        snapshot.corrections.map((item) => item.recordId),
      );
      const active = snapshot.records.filter(
        (record) => !corrected.has(record.id),
      );
      const original =
        input.action === "register"
          ? null
          : active.find((record) => record.id === input.recordId);
      if (input.action !== "register" && !original)
        fail(
          "record_unavailable",
          "The knowledge record is missing or already corrected",
        );
      // A wall-clock tie must not change which record wins after a backup/restore.
      const latest = snapshot.records.reduce(
        (max, record) => Math.max(max, Date.parse(record.createdAt) || 0),
        0,
      );
      const now = new Date(Math.max(Date.now(), latest + 1)).toISOString();
      let record: KnowledgeRecord | null = null;
      if (input.action !== "withdraw") {
        const target = input.action === "register" ? input : original!;
        record = {
          id: randomUuid(),
          projectId,
          knowerType: target.knowerType,
          knowerEntityId: target.knowerEntityId,
          factId: target.factId,
          timelineEventId: target.timelineEventId,
          learnedAtNodeId: input.learnedAtNodeId,
          belief: input.belief,
          sourceId: "manual",
          createdAt: now,
        };
        this.validate(
          record,
          snapshot,
          active.filter((item) => item.id !== original?.id),
        );
        this.state.insertKnowledge(record);
      }
      const correction: KnowledgeCorrection | null =
        input.action !== "register"
          ? {
              recordId: original!.id,
              projectId,
              replacementRecordId: record?.id ?? null,
              reason: input.reason,
              createdAt: now,
            }
          : null;
      if (correction) this.state.insertKnowledgeCorrection(correction);
      const result = KnowledgeWriteResultSchema.parse({
        record,
        correction,
        idempotentReplay: false,
      });
      this.replays.insert({
        scope,
        requestId: input.requestId,
        requestHash,
        result,
        createdAt: now,
      });
      return result;
    });
  }

  private requireProject(projectId: string): void {
    if (!this.projects.get(projectId))
      throw new StoryServiceError(
        "project.not_found",
        "Project not found",
        404,
      );
  }

  private snapshot(projectId: string): KnowledgeEditorDto {
    this.requireProject(projectId);
    const outline = this.story.listOutline(projectId);
    const scope = buildOutlineScope(outline, null);
    const data = {
      records: this.state.listKnowledge(projectId, { includeCorrected: true }),
      corrections: this.state.listKnowledgeCorrections(projectId),
      entities: this.canon
        .listEntities(projectId, { includeRetired: true })
        .map(({ id, name, type, status }) => ({ id, name, type, status })),
      facts: this.canon.listFactHistory(projectId, {
        includeCandidates: true,
        includeWithdrawn: true,
      }),
      withdrawnFactIds: this.canon
        .listFactWithdrawals(projectId)
        .map((item) => item.factId),
      timeline: this.state.listTimeline(projectId, { includeVoided: true }),
      voidedEventIds: this.state
        .listVoidedTimeline(projectId)
        .map((item) => item.eventId),
      outline,
      eligibleNodeIds: outline
        .filter((node) => {
          if (node.kind !== "chapter" && node.kind !== "scene") return false;
          const chapterId = scope.chapterByNode.get(node.id);
          return (
            chapterId && scope.nodeById.get(chapterId)?.status === "committed"
          );
        })
        .map((node) => node.id),
    };
    return KnowledgeEditorSchema.parse({ ...data, version: hashRequest(data) });
  }

  private validate(
    record: KnowledgeRecord,
    snapshot: KnowledgeEditorDto,
    active: KnowledgeRecord[],
  ): void {
    if (
      record.knowerType === "character" &&
      !snapshot.entities.some(
        (entity) =>
          entity.id === record.knowerEntityId && entity.type === "character",
      )
    )
      fail("character_unavailable", "Select a character in this project");
    if (!snapshot.eligibleNodeIds.includes(record.learnedAtNodeId))
      fail(
        "evidence_unavailable",
        "Knowledge requires a node within a committed, non-abandoned chapter",
      );
    const fact = snapshot.facts.find((item) => item.id === record.factId);
    const event = snapshot.timeline.find(
      (item) => item.id === record.timelineEventId,
    );
    if (
      record.factId
        ? !fact ||
          fact.authority === "candidate" ||
          snapshot.withdrawnFactIds.includes(record.factId)
        : !event || snapshot.voidedEventIds.includes(record.timelineEventId!)
    )
      fail(
        "claim_unavailable",
        "Select an established fact or active event in this project",
      );
    const scope = buildOutlineScope(snapshot.outline, record.learnedAtNodeId);
    if (
      !nodeIsNotAfterTarget(
        fact ? fact.validFromNodeId : event!.outlineNodeId,
        scope,
      )
    )
      fail(
        "future_claim",
        "The claim occurs after the selected knowledge evidence",
      );
    const facts = new Map(snapshot.facts.map((item) => [item.id, item]));
    const lineage = (item: KnowledgeRecord) => {
      const itemFact = item.factId ? facts.get(item.factId) : null;
      return itemFact
        ? `fact:${factLineage(itemFact, facts)}`
        : `event:${item.timelineEventId}`;
    };
    if (
      active.some(
        (item) =>
          item.knowerType === record.knowerType &&
          item.knowerEntityId === record.knowerEntityId &&
          item.learnedAtNodeId === record.learnedAtNodeId &&
          lineage(item) === lineage(record),
      )
    )
      fail(
        "duplicate",
        "Knowledge for this knower, claim and node already exists; correct the existing record",
      );
  }
}

function fail(code: string, message: string): never {
  throw new StoryServiceError(`knowledge.${code}`, message, 409);
}
