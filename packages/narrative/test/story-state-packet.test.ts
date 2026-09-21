import {
  createCanonEntity,
  createCanonFact,
  createOutlineNode,
  createProject,
} from "@narralume/domain";
import {
  SqliteCanonRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteStoryRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StoryStatePacketBuilder } from "../src/story-state-packet.js";

const now = "2026-08-10T00:00:00.000Z";
let database: NodeNarrativeDatabase;
let canon: SqliteCanonRepository;
let state: SqliteNarrativeStateRepository;
let story: SqliteStoryRepository;

beforeEach(() => {
  database = new NodeNarrativeDatabase();
  database.migrate();
  new SqliteProjectRepository(database).insert(
    createProject({ id: "p1", title: "Access Boundaries", now }),
  );
  story = new SqliteStoryRepository(database);
  const root = story.insertOutlineNode(
    createOutlineNode({
      id: "book",
      projectId: "p1",
      parent: null,
      kind: "book",
      ordinal: 0,
      title: "Book",
      now,
    }),
  );
  story.insertOutlineNode(
    createOutlineNode({
      id: "chapter-1",
      projectId: "p1",
      parent: root,
      kind: "chapter",
      ordinal: 0,
      title: "Chapter 1",
      now,
    }),
  );
  canon = new SqliteCanonRepository(database);
  for (const [id, name] of [
    ["hero", "Hero"],
    ["rival", "Rival"],
  ] as const) {
    canon.insertEntity(
      createCanonEntity({
        id,
        projectId: "p1",
        type: "character",
        name,
        now,
      }),
    );
  }
  canon.insertFact(
    createCanonFact({
      id: "public-fact",
      projectId: "p1",
      subjectId: "hero",
      predicate: "home",
      value: "harbor",
      knowledgeScope: "omniscient",
      authority: "confirmed",
      sourceType: "test",
      now,
    }),
  );
  canon.insertFact(
    createCanonFact({
      id: "secret-fact",
      projectId: "p1",
      subjectId: "rival",
      predicate: "secretIdentity",
      value: "the missing king",
      knowledgeScope: "author_secret",
      authority: "locked",
      sourceType: "test",
      now,
    }),
  );
  state = new SqliteNarrativeStateRepository(database, canon, story);
  state.insertRelationship({
    id: "relationship-1",
    projectId: "p1",
    fromEntityId: "hero",
    toEntityId: "rival",
    relation: "distrusts",
    intensity: 7,
    state: {},
    outlineNodeId: "chapter-1",
    storyTime: null,
    sourceId: "test",
    supersedesEventId: null,
    createdAt: now,
  });
  state.insertTimelineEvent({
    id: "secret-event",
    projectId: "p1",
    title: "Secret coronation",
    description: "Only the author knows",
    outlineNodeId: "chapter-1",
    storyTimeStart: null,
    storyTimeEnd: null,
    sequence: 1,
    participants: ["rival"],
    causes: [],
    visibility: "author_secret",
    sourceId: "test",
    createdAt: now,
    updatedAt: now,
  });
  state.insertForeshadow({
    id: "future-reveal",
    projectId: "p1",
    title: "The rival will inherit the crown",
    description: "Author-only future reveal",
    status: "planned",
    importance: 5,
    targetFromNodeId: "chapter-1",
    targetToNodeId: null,
    dependencies: [],
    evidenceNodeIds: [],
    resolutionNodeId: null,
    createdAt: now,
    updatedAt: now,
  });
});

afterEach(() => database.close());

describe("StoryStatePacketBuilder", () => {
  it("keeps author-only facts, events, and foreshadows out of character packets", () => {
    const packet = new StoryStatePacketBuilder(canon, state, story).build({
      projectId: "p1",
      audience: "character",
      characterId: "hero",
      targetOutlineNodeId: "chapter-1",
    });
    const text = packet.sources.map((source) => source.content).join("\n");
    expect(text).toContain("harbor");
    expect(text).toContain("distrusts");
    expect(text).not.toContain("missing king");
    expect(text).not.toContain("Secret coronation");
    expect(text).not.toContain("inherit the crown");
    expect(packet.counts).toMatchObject({
      facts: 1,
      relationships: 1,
      timelineEvents: 0,
      foreshadows: 0,
    });
  });

  it("includes the complete planning ledger for author packets", () => {
    const packet = new StoryStatePacketBuilder(canon, state, story).build({
      projectId: "p1",
      audience: "author",
    });
    const text = packet.sources.map((source) => source.content).join("\n");
    expect(text).toContain("missing king");
    expect(text).toContain("Secret coronation");
    expect(text).toContain("inherit the crown");
  });

  it("recalls only target-valid facts and keeps causal history across chapters", () => {
    const root = story.requireOutlineNode("p1", "book");
    const chapter2 = story.insertOutlineNode(
      createOutlineNode({
        id: "chapter-2",
        projectId: "p1",
        parent: root,
        kind: "chapter",
        ordinal: 1,
        title: "Chapter 2",
        povEntityId: "hero",
        now,
      }),
    );
    const chapter3 = story.insertOutlineNode(
      createOutlineNode({
        id: "chapter-3",
        projectId: "p1",
        parent: root,
        kind: "chapter",
        ordinal: 2,
        title: "Chapter 3",
        now,
      }),
    );
    canon.insertFact(
      createCanonFact({
        id: "expired-fact",
        projectId: "p1",
        subjectId: "hero",
        predicate: "oldTitle",
        value: "cadet",
        validToNodeId: "chapter-1",
        authority: "confirmed",
        sourceType: "test",
        now,
      }),
    );
    canon.insertFact(
      createCanonFact({
        id: "future-fact",
        projectId: "p1",
        subjectId: "hero",
        predicate: "futureTitle",
        value: "captain",
        validFromNodeId: chapter3.id,
        authority: "confirmed",
        sourceType: "test",
        now,
      }),
    );
    canon.insertFact(
      createCanonFact({
        id: "current-fact",
        projectId: "p1",
        subjectId: "hero",
        predicate: "currentTitle",
        value: "navigator",
        validFromNodeId: "chapter-1",
        validToNodeId: chapter3.id,
        authority: "confirmed",
        sourceType: "test",
        now,
      }),
    );
    state.insertTimelineEvent({
      id: "old-cause",
      projectId: "p1",
      title: "Old cause",
      description: null,
      outlineNodeId: "chapter-1",
      storyTimeStart: null,
      storyTimeEnd: null,
      sequence: 2,
      participants: [],
      causes: [],
      visibility: "omniscient",
      sourceId: "test",
      createdAt: now,
      updatedAt: now,
    });
    state.insertTimelineEvent({
      id: "current-effect",
      projectId: "p1",
      title: "Current effect",
      description: null,
      outlineNodeId: chapter2.id,
      storyTimeStart: null,
      storyTimeEnd: null,
      sequence: 3,
      participants: ["hero"],
      causes: ["old-cause"],
      visibility: "omniscient",
      sourceId: "test",
      createdAt: now,
      updatedAt: now,
    });
    state.removeTimelineEvent("p1", "old-cause", "2026-08-19T00:01:00Z");
    state.insertTimelineEvent({
      id: "future-event",
      projectId: "p1",
      title: "Future event",
      description: null,
      outlineNodeId: chapter3.id,
      storyTimeStart: null,
      storyTimeEnd: null,
      sequence: 4,
      participants: ["hero"],
      causes: [],
      visibility: "omniscient",
      sourceId: "test",
      createdAt: now,
      updatedAt: now,
    });

    const packet = new StoryStatePacketBuilder(canon, state, story).build({
      projectId: "p1",
      audience: "author",
      targetOutlineNodeId: chapter2.id,
      recentChapterWindow: 1,
    });
    const text = packet.sources.map((source) => source.content).join("\n");
    expect(text).toContain("navigator");
    expect(text).not.toContain("cadet");
    expect(text).not.toContain("captain");
    expect(text).not.toContain("Old cause");
    expect(text).toContain("Current effect");
    expect(text).not.toContain("Future event");
  });

  it("reconstructs facts, relationships, and knowledge at the target chapter", () => {
    const root = story.requireOutlineNode("p1", "book");
    const chapter2 = story.insertOutlineNode(
      createOutlineNode({
        id: "chapter-2",
        projectId: "p1",
        parent: root,
        kind: "chapter",
        ordinal: 1,
        title: "Chapter 2",
        povEntityId: "hero",
        now,
      }),
    );
    const chapter3 = story.insertOutlineNode(
      createOutlineNode({
        id: "chapter-3",
        projectId: "p1",
        parent: root,
        kind: "chapter",
        ordinal: 2,
        title: "Chapter 3",
        povEntityId: "hero",
        now,
      }),
    );
    canon.insertFact(
      createCanonFact({
        id: "public-fact-next",
        projectId: "p1",
        subjectId: "hero",
        predicate: "home",
        value: "mountain",
        validFromNodeId: chapter3.id,
        authority: "confirmed",
        sourceType: "test",
        supersedesFactId: "public-fact",
        now: "2026-08-10T00:01:00.000Z",
      }),
    );
    state.insertRelationship({
      id: "relationship-2",
      projectId: "p1",
      fromEntityId: "hero",
      toEntityId: "rival",
      relation: "trusts",
      intensity: 8,
      state: {},
      outlineNodeId: chapter3.id,
      storyTime: null,
      sourceId: "test",
      supersedesEventId: "relationship-1",
      createdAt: "2026-08-10T00:01:00.000Z",
    });
    state.insertKnowledge({
      id: "future-knowledge",
      projectId: "p1",
      knowerType: "character",
      knowerEntityId: "hero",
      factId: "secret-fact",
      timelineEventId: null,
      learnedAtNodeId: chapter3.id,
      belief: "known",
      sourceId: "test",
      createdAt: "2026-08-10T00:01:00.000Z",
    });

    const builder = new StoryStatePacketBuilder(canon, state, story);
    const chapter2Text = builder
      .build({
        projectId: "p1",
        audience: "character",
        characterId: "hero",
        targetOutlineNodeId: chapter2.id,
      })
      .sources.map((source) => source.content)
      .join("\n");
    expect(chapter2Text).toContain("harbor");
    expect(chapter2Text).not.toContain("mountain");
    expect(chapter2Text).toContain("→ Rival：distrusts");
    expect(chapter2Text).not.toContain("→ Rival：trusts");
    expect(chapter2Text).not.toContain("missing king");

    const chapter3Text = builder
      .build({
        projectId: "p1",
        audience: "character",
        characterId: "hero",
        targetOutlineNodeId: chapter3.id,
      })
      .sources.map((source) => source.content)
      .join("\n");
    expect(chapter3Text).not.toContain("harbor");
    expect(chapter3Text).toContain("mountain");
    expect(chapter3Text).not.toContain("→ Rival：distrusts");
    expect(chapter3Text).toContain("→ Rival：trusts");
    expect(chapter3Text).toContain("missing king");
  });

  it("rejects an unknown target instead of leaking unbounded future state", () => {
    expect(() =>
      new StoryStatePacketBuilder(canon, state, story).build({
        projectId: "p1",
        audience: "author",
        targetOutlineNodeId: "missing-chapter",
      }),
    ).toThrow("story-state target outline node missing-chapter does not exist");
  });

  it("promotes due foreshadows together with their dependencies", () => {
    const root = story.requireOutlineNode("p1", "book");
    const chapter2 = story.insertOutlineNode(
      createOutlineNode({
        id: "chapter-2",
        projectId: "p1",
        parent: root,
        kind: "chapter",
        ordinal: 1,
        title: "Chapter 2",
        now,
      }),
    );
    state.insertForeshadow({
      id: "dependency",
      projectId: "p1",
      title: "Hidden key",
      description: "The key was planted long ago",
      status: "planned",
      importance: 3,
      targetFromNodeId: null,
      targetToNodeId: null,
      dependencies: [],
      evidenceNodeIds: ["chapter-1"],
      resolutionNodeId: null,
      createdAt: now,
      updatedAt: now,
    });
    state.insertForeshadow({
      id: "due-reveal",
      projectId: "p1",
      title: "Open the vault",
      description: "The hidden key opens the vault",
      status: "developing",
      importance: 5,
      targetFromNodeId: chapter2.id,
      targetToNodeId: chapter2.id,
      dependencies: ["dependency"],
      evidenceNodeIds: [],
      resolutionNodeId: null,
      createdAt: now,
      updatedAt: now,
    });

    const packet = new StoryStatePacketBuilder(canon, state, story).build({
      projectId: "p1",
      audience: "author",
      targetOutlineNodeId: chapter2.id,
    });
    const commitment = packet.sources.find(
      (source) => source.metadata?.continuityTier === "commitment",
    );
    expect(commitment?.content).toContain("Hidden key");
    expect(commitment?.content).toContain("Open the vault");
    expect(commitment?.required).toBe(true);
  });

  it("keeps long-chain recall deterministic and bounded", () => {
    const root = story.requireOutlineNode("p1", "book");
    for (let index = 2; index <= 121; index += 1) {
      story.insertOutlineNode(
        createOutlineNode({
          id: `chapter-${index}`,
          projectId: "p1",
          parent: root,
          kind: "chapter",
          ordinal: index - 1,
          title: `Chapter ${index}`,
          povEntityId: index === 120 ? "hero" : null,
          now,
        }),
      );
    }
    for (let index = 2; index <= 119; index += 1) {
      state.insertTimelineEvent({
        id: `chain-event-${index}`,
        projectId: "p1",
        title: `Chain event ${index}`,
        description: null,
        outlineNodeId: `chapter-${index}`,
        storyTimeStart: `Day ${index}`,
        storyTimeEnd: `Day ${index}`,
        sequence: index + 10,
        participants: index === 119 ? ["hero"] : [],
        causes: index === 2 ? [] : [`chain-event-${index - 1}`],
        visibility: "omniscient",
        sourceId: "long-chain-test",
        createdAt: now,
        updatedAt: now,
      });
    }
    canon.insertFact(
      createCanonFact({
        id: "long-lived-fact",
        projectId: "p1",
        subjectId: "hero",
        predicate: "mission",
        value: "guard the chain",
        validFromNodeId: "chapter-50",
        validToNodeId: "chapter-120",
        authority: "confirmed",
        sourceType: "long-chain-test",
        now,
      }),
    );
    canon.insertFact(
      createCanonFact({
        id: "after-target-fact",
        projectId: "p1",
        subjectId: "hero",
        predicate: "futureMission",
        value: "leave the harbor",
        validFromNodeId: "chapter-121",
        authority: "confirmed",
        sourceType: "long-chain-test",
        now,
      }),
    );

    const builder = new StoryStatePacketBuilder(canon, state, story);
    const request = {
      projectId: "p1",
      audience: "author" as const,
      targetOutlineNodeId: "chapter-120",
      recentChapterWindow: 6,
      maxTimelineEvents: 25,
    };
    const first = builder.build(request);
    const second = builder.build(request);
    expect(second).toEqual(first);
    expect(first.counts.timelineEvents).toBe(25);
    expect(builder.snapshot(request).timeline).toHaveLength(119);
    const text = first.sources.map((source) => source.content).join("\n");
    expect(text).toContain("guard the chain");
    expect(text).not.toContain("leave the harbor");
    expect(text).toContain("Chain event 119");
    expect(text).toContain("Chain event 95");
    expect(text).not.toContain("Chain event 94");
  });
});
