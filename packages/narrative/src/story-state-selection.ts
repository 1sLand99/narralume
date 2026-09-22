import {
  canAccessFact,
  type CanonAccess,
  type CanonEntity,
  type CanonFact,
  type Foreshadow,
  type KnowledgeRecord,
  type OutlineNode,
  type RelationshipEvent,
  type TimelineEvent,
} from "@narralume/domain";
import type {
  SqliteCanonRepository,
  SqliteNarrativeStateRepository,
  SqliteStoryRepository,
} from "@narralume/persistence";

export type StoryStateAudience = "author" | "reader" | "character";

export interface StoryStateRequest {
  projectId: string;
  audience: StoryStateAudience;
  characterId?: string | null;
  targetOutlineNodeId?: string | null;
}

export interface StoryKnowledge {
  record: KnowledgeRecord;
  fact: CanonFact | null;
  event: Pick<TimelineEvent, "id" | "title" | "outlineNodeId"> | null;
}

export interface OutlineScope {
  nodeOrder: ReadonlyMap<string, number>;
  nodeEndOrder: ReadonlyMap<string, number>;
  chapterOrder: ReadonlyMap<string, number>;
  chapterByNode: ReadonlyMap<string, string>;
  nodeById: ReadonlyMap<string, OutlineNode>;
  targetNode: OutlineNode | null;
  targetNodeOrder: number | null;
  targetChapterOrder: number | null;
}

export interface StoryStateSelection {
  scope: OutlineScope;
  access: CanonAccess;
  entities: CanonEntity[];
  facts: CanonFact[];
  relationships: RelationshipEvent[];
  timeline: TimelineEvent[];
  knowledge: StoryKnowledge[];
  foreshadows: Foreshadow[];
}

/** Shared narrative-time and visibility boundary for inspection and prompts. */
export function selectStoryState(
  canon: SqliteCanonRepository,
  state: SqliteNarrativeStateRepository,
  story: SqliteStoryRepository,
  request: StoryStateRequest,
): StoryStateSelection {
  if (request.audience === "character" && !request.characterId) {
    throw new Error("character story-state packets require characterId");
  }
  const scope = buildOutlineScope(
    story.listOutline(request.projectId),
    request.targetOutlineNodeId,
  );
  if (request.targetOutlineNodeId && !scope.targetNode) {
    throw new Error(
      `story-state target outline node ${request.targetOutlineNodeId} does not exist`,
    );
  }
  const entities = canon.listEntities(request.projectId, {
    includeRetired: true,
  });
  if (
    request.audience === "character" &&
    !entities.some(
      (entity) =>
        entity.id === request.characterId && entity.type === "character",
    )
  ) {
    throw new Error("story-state character does not exist in this project");
  }
  const access: CanonAccess = {
    audience: request.audience,
    ...(request.characterId ? { characterId: request.characterId } : {}),
    includeCandidates: false,
  };
  const factHistory = canon.listFactHistory(request.projectId);
  const factById = new Map(factHistory.map((fact) => [fact.id, fact]));
  // Withdrawn intermediate revisions still connect older beliefs to a claim's
  // lineage, even though those revisions cannot themselves enter the packet.
  const lineageById = new Map(
    canon
      .listFactHistory(request.projectId, {
        includeCandidates: true,
        includeWithdrawn: true,
      })
      .map((fact) => [fact.id, fact]),
  );
  const timeline = state
    .listTimeline(request.projectId)
    .filter((event) => nodeIsNotAfterTarget(event.outlineNodeId, scope));
  const eventById = new Map(timeline.map((event) => [event.id, event]));
  const latestKnowledge = new Map<string, StoryKnowledge>();
  const records = state
    .listKnowledge(request.projectId)
    .filter(
      (record) =>
        nodeIsNotAfterTarget(record.learnedAtNodeId, scope) &&
        (request.audience === "author" ||
          (request.audience === "reader"
            ? record.knowerType === "reader"
            : record.knowerType === "character" &&
              record.knowerEntityId === request.characterId)),
    )
    .sort(
      (left, right) =>
        nodeOrder(left.learnedAtNodeId, scope) -
          nodeOrder(right.learnedAtNodeId, scope) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
  for (const record of records) {
    const fact = record.factId ? (factById.get(record.factId) ?? null) : null;
    const event = record.timelineEventId
      ? (eventById.get(record.timelineEventId) ?? null)
      : null;
    // Withdrawn/candidate claims and future events cannot become present knowledge.
    // Superseded/expired claims remain available: a person may still believe them.
    if (
      (!fact && !event) ||
      (fact && !nodeIsNotAfterTarget(fact.validFromNodeId, scope))
    )
      continue;
    const subject = fact
      ? `fact:${factLineage(fact, lineageById)}`
      : `event:${event!.id}`;
    latestKnowledge.set(
      JSON.stringify([record.knowerType, record.knowerEntityId, subject]),
      {
        record,
        fact,
        // Knowledge records identify the event claim, not every author-side detail.
        event: event
          ? {
              id: event.id,
              title: event.title,
              outlineNodeId: event.outlineNodeId,
            }
          : null,
      },
    );
  }
  const knowledge = [...latestKnowledge.values()];
  const explicitFactLineages = new Set(
    knowledge.flatMap((item) =>
      item.fact ? [factLineage(item.fact, lineageById)] : [],
    ),
  );
  const uncertainScopedFactIds = new Set(
    knowledge
      .filter(
        ({ record, fact }) =>
          fact &&
          record.belief !== "known" &&
          ((fact.knowledgeScope === "reader" &&
            record.knowerType === "reader") ||
            (fact.knowledgeScope === "character" &&
              record.knowerType === "character" &&
              fact.knowledgeSubjectId === record.knowerEntityId)),
      )
      .map(({ fact }) => fact!.id),
  );
  const uncertainEventIds = new Set(
    knowledge
      .filter((item) => item.record.belief !== "known")
      .map((item) => item.event?.id),
  );
  const knownEventIds = new Set(
    knowledge
      .filter((item) => item.record.belief === "known")
      .map((item) => item.event?.id),
  );
  const activeFacts = factHistory.filter((fact) =>
    factActiveAtTarget(fact, scope),
  );
  const supersededFacts = new Set(
    factHistory
      .filter((fact) => nodeIsNotAfterTarget(fact.validFromNodeId, scope))
      .map((fact) => fact.supersedesFactId),
  );
  // Explicit beliefs are rendered separately, never silently replaced by a newer truth.
  const facts = activeFacts.filter(
    (fact) =>
      !supersededFacts.has(fact.id) &&
      !uncertainScopedFactIds.has(fact.id) &&
      canAccessFact(fact, access) &&
      (request.audience === "author" ||
        !explicitFactLineages.has(factLineage(fact, lineageById))),
  );
  const eligibleRelationships = state
    .listRelationshipHistory(request.projectId)
    .filter((event) => nodeIsNotAfterTarget(event.outlineNodeId, scope));
  const supersededRelationships = new Set(
    eligibleRelationships.map((event) => event.supersedesEventId),
  );
  const relationships = eligibleRelationships.filter(
    (event) =>
      !supersededRelationships.has(event.id) &&
      event.state.lifecycle !== "voided" &&
      (request.audience !== "character" ||
        event.fromEntityId === request.characterId ||
        event.toEntityId === request.characterId),
  );
  return {
    scope,
    access,
    entities,
    facts,
    relationships,
    knowledge,
    timeline: timeline.filter(
      (event) =>
        request.audience === "author" ||
        (!uncertainEventIds.has(event.id) &&
          (event.visibility === "omniscient" ||
            knownEventIds.has(event.id) ||
            (request.audience === "reader" && event.visibility === "reader"))),
    ),
    // These are current author plans, not a reconstructed historical status.
    foreshadows:
      request.audience === "author"
        ? state.listForeshadows(request.projectId)
        : [],
  };
}

export function factLineage(
  fact: CanonFact,
  byId: ReadonlyMap<string, CanonFact>,
): string {
  let cursor = fact;
  const seen = new Set<string>();
  while (cursor.supersedesFactId && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const previous = byId.get(cursor.supersedesFactId);
    if (!previous) return cursor.supersedesFactId;
    cursor = previous;
  }
  return cursor.id;
}

export function buildOutlineScope(
  outline: readonly OutlineNode[],
  targetId: string | null | undefined,
): OutlineScope {
  const allNodes = new Map(outline.map((node) => [node.id, node]));
  const active = outline.filter((node) => {
    let cursor: OutlineNode | undefined = node;
    while (cursor) {
      if (cursor.status === "abandoned") return false;
      cursor = cursor.parentId ? allNodes.get(cursor.parentId) : undefined;
    }
    return true;
  });
  const nodeById = new Map(active.map((node) => [node.id, node]));
  const nodeOrder = new Map(active.map((node, index) => [node.id, index]));
  const nodeEndOrder = new Map(nodeOrder);
  for (const node of [...active].reverse()) {
    if (node.parentId && nodeEndOrder.has(node.parentId)) {
      nodeEndOrder.set(
        node.parentId,
        Math.max(nodeEndOrder.get(node.parentId)!, nodeEndOrder.get(node.id)!),
      );
    }
  }
  const chapterOrder = new Map(
    active
      .filter((node) => node.kind === "chapter")
      .map((node, index) => [node.id, index]),
  );
  const chapterByNode = new Map<string, string>();
  for (const node of active) {
    let cursor: OutlineNode | undefined = node;
    while (cursor && cursor.kind !== "chapter")
      cursor = cursor.parentId ? nodeById.get(cursor.parentId) : undefined;
    if (cursor) chapterByNode.set(node.id, cursor.id);
  }
  const targetChapterId = targetId ? chapterByNode.get(targetId) : undefined;
  return {
    nodeById,
    nodeOrder,
    nodeEndOrder,
    chapterOrder,
    chapterByNode,
    targetNode: targetId ? (nodeById.get(targetId) ?? null) : null,
    targetNodeOrder: targetId ? (nodeEndOrder.get(targetId) ?? null) : null,
    targetChapterOrder: targetChapterId
      ? (chapterOrder.get(targetChapterId) ?? null)
      : null,
  };
}

function factActiveAtTarget(fact: CanonFact, scope: OutlineScope): boolean {
  if (!nodeIsNotAfterTarget(fact.validFromNodeId, scope)) return false;
  if (!fact.validToNodeId) return true;
  const end = scope.nodeEndOrder.get(fact.validToNodeId);
  return (
    end !== undefined &&
    (scope.targetNodeOrder === null || end >= scope.targetNodeOrder)
  );
}

export function nodeIsNotAfterTarget(
  id: string | null,
  scope: OutlineScope,
): boolean {
  if (!id) return true;
  const order = scope.nodeOrder.get(id);
  return (
    order !== undefined &&
    (scope.targetNodeOrder === null || order <= scope.targetNodeOrder)
  );
}

export function nodeOrder(id: string | null, scope: OutlineScope): number {
  return id ? (scope.nodeOrder.get(id) ?? -1) : -1;
}
