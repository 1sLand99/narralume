import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCanonFact, createOutlineNode } from "@narralume/domain";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { seedStoryState } from "../../../scripts/fixtures/story-state.js";
import { StoryStatePacketBuilder } from "../src/story-state-packet.js";

let database: NodeNarrativeDatabase;
let fixture: ReturnType<typeof seedStoryState>;
let builder: StoryStatePacketBuilder;
beforeEach(() => {
  database = new NodeNarrativeDatabase();
  database.migrate();
  fixture = seedStoryState(database);
  builder = new StoryStatePacketBuilder(
    fixture.canon,
    fixture.state,
    fixture.story,
  );
});
afterEach(() => database.close());
const target = (
  chapter: number,
  audience: "author" | "reader" | "character" = "author",
  characterId = "state-hero",
) => ({
  projectId: "state-fixture",
  targetOutlineNodeId: `state-c${chapter}`,
  audience,
  ...(audience === "character" ? { characterId } : {}),
});

describe("chapter state selection", () => {
  it("includes scenes through chapter end and follows narrative order across volumes, not dates or paths", () => {
    const first = builder.snapshot(target(1));
    expect(first.timeline).toEqual([]);
    expect(first.facts.map((fact) => fact.id)).not.toContain("state-new-fact");
    const second = builder.snapshot(target(2));
    expect(second.timeline.map((event) => event.id)).toEqual(["state-event"]);
    expect(second.facts.map((fact) => fact.id)).toContain("state-new-fact");
    expect(
      builder.snapshot(target(12)).facts.map((fact) => fact.id),
    ).not.toContain("state-future-fact");
    expect(builder.snapshot(target(13)).facts.map((fact) => fact.id)).toContain(
      "state-future-fact",
    );
  });

  it("preserves a superseded belief until the character learns its revision, using narrative time before insertion time", () => {
    const early = builder.snapshot(target(2, "character"));
    expect(early.knowledge.find((item) => item.fact)?.fact?.id).toBe(
      fixture.oldFact.id,
    );
    expect(early.knowledge.find((item) => item.fact)?.record.belief).toBe(
      "false_belief",
    );
    expect(early.facts).toEqual([]);
    const late = builder.snapshot(target(12, "character"));
    expect(late.knowledge.filter((item) => item.fact)).toHaveLength(1);
    expect(late.knowledge.find((item) => item.fact)?.fact?.id).toBe(
      fixture.newFact.id,
    );
    expect(late.knowledge.find((item) => item.fact)?.record.id).toBe(
      "state-learned",
    );
    const text = builder
      .build(target(2, "character"))
      .sources.map((source) => source.content)
      .join("\n");
    expect(text).toContain("[false_belief] 林澈 [node:state-c1]");
    expect(text).toContain("议会");
    expect(text).not.toContain("守灯人");
  });

  it("keeps uncertain claims out of factual sources and enforces reader and character visibility", () => {
    for (const audience of ["character", "reader"] as const) {
      const early = builder.snapshot(target(2, audience));
      expect(early.timeline).toEqual([]);
      expect(early.foreshadows).toEqual([]);
      expect(
        early.knowledge.some((item) => item.event?.id === "state-event"),
      ).toBe(true);
      const packet = builder.build(target(2, audience));
      expect(
        packet.sources.some((source) => source.sourceType === "timeline_state"),
      ).toBe(false);
      expect(
        packet.sources.find((source) => source.sourceType === "knowledge_state")
          ?.content,
      ).toContain("灯塔熄灭");
      expect(JSON.stringify(early)).not.toContain("PROFILE_SECRET");
    }
    expect(
      builder
        .snapshot(target(2, "reader"))
        .knowledge.every((item) => item.record.knowerType === "reader"),
    ).toBe(true);
    expect(
      builder
        .snapshot(target(12, "character"))
        .timeline.map((event) => event.id),
    ).toEqual(["state-event"]);
    expect(
      builder.snapshot(target(2, "character", fixture.outsider.id)).knowledge,
    ).toEqual([]);
  });

  it("does not expose unscoped entity descriptions via a visible canon fact", () => {
    fixture.canon.insertFact(
      createCanonFact({
        id: "public-role",
        projectId: fixture.projectId,
        subjectId: fixture.hero.id,
        predicate: "职业",
        value: "调查者",
        knowledgeScope: "omniscient",
        authority: "confirmed",
        sourceType: "fixture",
        now: "2026-09-01T00:00:00.000Z",
      }),
    );
    const text = builder
      .build(target(2, "character"))
      .sources.map((source) => source.content)
      .join("\n");
    expect(text).toContain("调查者");
    expect(text).not.toContain("PROFILE_SECRET");
  });

  it("keeps a character-scoped false belief separate from author truth", () => {
    const snapshot = builder.snapshot(target(1));
    expect(snapshot.facts).toEqual([]);
    expect(snapshot.knowledge[0]?.record.belief).toBe("false_belief");
    const packet = builder.build(target(1));
    expect(
      packet.sources.find((source) => source.sourceType === "canon_entity"),
    ).toBeUndefined();
    expect(
      packet.sources.find((source) => source.sourceType === "knowledge_state")
        ?.content,
    ).toContain("[false_belief] 林澈");
  });

  it("reconstructs relationship revisions and excludes voided records", () => {
    expect(
      builder
        .snapshot(target(2, "character"))
        .relationships.map((item) => item.id),
    ).toEqual(["state-distrust"]);
    expect(
      builder
        .snapshot(target(12, "character"))
        .relationships.map((item) => item.id),
    ).toEqual(["state-trust"]);
    const old = fixture.state
      .listRelationshipHistory(fixture.projectId)
      .find((item) => item.id === "state-distrust")!;
    fixture.state.insertRelationship({
      ...old,
      id: "state-void",
      supersedesEventId: old.id,
      state: { lifecycle: "voided" },
      outlineNodeId: fixture.scene.id,
    });
    expect(
      builder
        .snapshot(target(1, "character"))
        .relationships.map((item) => item.id),
    ).toEqual(["state-distrust"]);
    expect(builder.snapshot(target(2, "character")).relationships).toEqual([]);
  });

  it("separates current foreshadow plans from evidence available through the chapter", () => {
    expect(builder.snapshot(target(2)).foreshadows[0]).toMatchObject({
      currentStatus: "resolved",
      evidenceNodeIds: ["state-c1", "state-scene"],
      resolutionNodeId: null,
    });
    expect(builder.snapshot(target(12)).foreshadows[0]?.resolutionNodeId).toBe(
      "state-c12",
    );
  });

  it("excludes abandoned subtrees and rejects an abandoned target", () => {
    const chapter = fixture.story.requireOutlineNode(
      fixture.projectId,
      "state-c2",
    );
    fixture.story.updateOutlineStatus(
      fixture.projectId,
      chapter.id,
      "abandoned",
      chapter.updatedAt,
    );
    const snapshot = builder.snapshot(target(12));
    expect(snapshot.timeline).toEqual([]);
    expect(
      snapshot.knowledge.some(
        (item) => item.record.learnedAtNodeId === fixture.scene.id,
      ),
    ).toBe(false);
    expect(snapshot.foreshadows[0]?.evidenceNodeIds).not.toContain(
      fixture.scene.id,
    );
    expect(() => builder.snapshot(target(2))).toThrow("does not exist");
  });

  it("does not resurrect a superseded fact after its replacement expires", () => {
    const chapter = fixture.chapters[11]!;
    const scene = fixture.story.insertOutlineNode(
      createOutlineNode({
        id: "late-scene",
        projectId: fixture.projectId,
        parent: chapter,
        kind: "scene",
        ordinal: 0,
        title: "晚间",
        now: chapter.createdAt,
      }),
    );
    fixture.canon.insertFact(
      createCanonFact({
        ...fixture.newFact,
        id: "state-last-fact",
        value: "代管者",
        supersedesFactId: fixture.newFact.id,
        validFromNodeId: scene.id,
        validToNodeId: chapter.id,
        now: chapter.createdAt,
      }),
    );
    expect(builder.snapshot(target(12)).facts.map((fact) => fact.id)).toContain(
      "state-last-fact",
    );
    expect(
      builder.snapshot(target(13)).facts.map((fact) => fact.id),
    ).not.toEqual(
      expect.arrayContaining([fixture.oldFact.id, fixture.newFact.id]),
    );
    expect(builder.snapshot(target(13)).facts.map((fact) => fact.id)).toEqual([
      "state-future-fact",
    ]);
  });
});
