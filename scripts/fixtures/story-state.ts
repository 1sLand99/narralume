import {
  createCanonEntity,
  createCanonFact,
  createOutlineNode,
  createProject,
  type OutlineNode,
} from "@narralume/domain";
import {
  SqliteCanonRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";

/** Deterministic, synthetic story shared by API and browser boundary tests. */
export function seedStoryState(database: NarrativeDatabase) {
  const projectId = "state-fixture";
  const now = "2026-09-01T00:00:00.000Z";
  new SqliteProjectRepository(database).insert(
    createProject({ id: projectId, title: "雾港的两份证词", now }),
  );
  const story = new SqliteStoryRepository(database);
  const canon = new SqliteCanonRepository(database);
  const state = new SqliteNarrativeStateRepository(database, canon, story);
  const node = (
    id: string,
    parent: OutlineNode | null,
    kind: OutlineNode["kind"],
    ordinal: number,
    title: string,
  ) =>
    story.insertOutlineNode({
      ...createOutlineNode({
        id,
        projectId,
        parent,
        kind,
        ordinal,
        title,
        now,
      }),
      status: "committed",
    });
  const book = node("state-book", null, "book", 0, "雾港的两份证词");
  const volume = node("state-vz", book, "volume", 0, "第一卷 · 港内");
  const chapters = Array.from({ length: 12 }, (_, index) =>
    node(
      `state-c${index + 1}`,
      volume,
      "chapter",
      index,
      `第${index + 1}章 · ${index === 0 ? "旧证词" : index === 1 ? "熄灯之夜" : index === 11 ? "证词翻转" : "追查"}`,
    ),
  );
  const nextVolume = node("state-va", book, "volume", 1, "第二卷 · 港外");
  chapters.push(node("state-c13", nextVolume, "chapter", 0, "第13章 · 新航线"));
  const scene = node("state-scene", chapters[1]!, "scene", 0, "塔下的目击者");
  const hero = canon.insertEntity(
    createCanonEntity({
      id: "state-hero",
      projectId,
      type: "character",
      name: "林澈",
      description: "PROFILE_SECRET：尚未公开的血缘",
      now,
    }),
  );
  const witness = canon.insertEntity(
    createCanonEntity({
      id: "state-witness",
      projectId,
      type: "character",
      name: "沈渡",
      now,
    }),
  );
  const outsider = canon.insertEntity(
    createCanonEntity({
      id: "state-outsider",
      projectId,
      type: "character",
      name: "何岚",
      now,
    }),
  );
  const oldFact = canon.insertFact(
    createCanonFact({
      id: "state-old-fact",
      projectId,
      subjectId: hero.id,
      predicate: "灯塔控制者",
      value: "议会",
      knowledgeScope: "character",
      knowledgeSubjectId: hero.id,
      validFromNodeId: chapters[0]!.id,
      authority: "inferred",
      sourceType: "fixture",
      now,
    }),
  );
  const newFact = canon.insertFact(
    createCanonFact({
      id: "state-new-fact",
      projectId,
      subjectId: hero.id,
      predicate: "灯塔控制者",
      value: "守灯人",
      knowledgeScope: "author_secret",
      validFromNodeId: scene.id,
      supersedesFactId: oldFact.id,
      authority: "confirmed",
      sourceType: "fixture",
      now,
    }),
  );
  canon.insertFact(
    createCanonFact({
      id: "state-future-fact",
      projectId,
      subjectId: witness.id,
      predicate: "航线",
      value: "FUTURE_ROUTE",
      knowledgeScope: "omniscient",
      validFromNodeId: chapters[12]!.id,
      authority: "confirmed",
      sourceType: "fixture",
      now,
    }),
  );
  state.insertTimelineEvent({
    id: "state-event",
    projectId,
    title: "灯塔熄灭",
    description: "守灯人关闭了灯塔。",
    outlineNodeId: scene.id,
    storyTimeStart: "十年前",
    storyTimeEnd: null,
    sequence: 1,
    participants: [witness.id],
    causes: [],
    visibility: "author_secret",
    sourceId: "fixture",
    createdAt: now,
    updatedAt: now,
  });
  const records = [
    {
      id: "state-belief",
      knowerType: "character" as const,
      knowerEntityId: hero.id,
      factId: oldFact.id,
      timelineEventId: null,
      learnedAtNodeId: chapters[0]!.id,
      belief: "false_belief" as const,
      createdAt: "2026-09-09T00:00:00.000Z",
    },
    {
      id: "state-witness-knows",
      knowerType: "character" as const,
      knowerEntityId: witness.id,
      factId: newFact.id,
      timelineEventId: null,
      learnedAtNodeId: scene.id,
      belief: "known" as const,
      createdAt: now,
    },
    {
      id: "state-suspicion",
      knowerType: "character" as const,
      knowerEntityId: hero.id,
      factId: null,
      timelineEventId: "state-event",
      learnedAtNodeId: scene.id,
      belief: "suspected" as const,
      createdAt: now,
    },
    {
      id: "state-reader",
      knowerType: "reader" as const,
      knowerEntityId: null,
      factId: null,
      timelineEventId: "state-event",
      learnedAtNodeId: scene.id,
      belief: "believed" as const,
      createdAt: now,
    },
    {
      id: "state-learned",
      knowerType: "character" as const,
      knowerEntityId: hero.id,
      factId: newFact.id,
      timelineEventId: null,
      learnedAtNodeId: chapters[11]!.id,
      belief: "known" as const,
      createdAt: now,
    },
    {
      id: "state-event-known",
      knowerType: "character" as const,
      knowerEntityId: hero.id,
      factId: null,
      timelineEventId: "state-event",
      learnedAtNodeId: chapters[11]!.id,
      belief: "known" as const,
      createdAt: now,
    },
  ];
  for (const record of records)
    state.insertKnowledge({ ...record, projectId, sourceId: "fixture" });
  state.insertRelationship({
    id: "state-distrust",
    projectId,
    fromEntityId: hero.id,
    toEntityId: witness.id,
    relation: "互相怀疑",
    intensity: 6,
    state: {},
    outlineNodeId: chapters[0]!.id,
    storyTime: null,
    sourceId: "fixture",
    supersedesEventId: null,
    createdAt: now,
  });
  state.insertRelationship({
    id: "state-trust",
    projectId,
    fromEntityId: hero.id,
    toEntityId: witness.id,
    relation: "交换证据后结盟",
    intensity: 8,
    state: {},
    outlineNodeId: chapters[11]!.id,
    storyTime: null,
    sourceId: "fixture",
    supersedesEventId: "state-distrust",
    createdAt: now,
  });
  state.insertRelationship({
    id: "state-unrelated",
    projectId,
    fromEntityId: outsider.id,
    toEntityId: witness.id,
    relation: "旧识",
    intensity: null,
    state: {},
    outlineNodeId: chapters[0]!.id,
    storyTime: null,
    sourceId: "fixture",
    supersedesEventId: null,
    createdAt: now,
  });
  state.insertForeshadow({
    id: "state-clue",
    projectId,
    title: "两份证词的矛盾",
    description: "是谁真正控制了灯塔？",
    status: "resolved",
    importance: 5,
    targetFromNodeId: chapters[11]!.id,
    targetToNodeId: chapters[11]!.id,
    dependencies: [],
    evidenceNodeIds: [chapters[0]!.id, scene.id, chapters[11]!.id],
    resolutionNodeId: chapters[11]!.id,
    createdAt: now,
    updatedAt: now,
  });
  return {
    projectId,
    story,
    canon,
    state,
    book,
    chapters,
    scene,
    hero,
    witness,
    outsider,
    oldFact,
    newFact,
  };
}
