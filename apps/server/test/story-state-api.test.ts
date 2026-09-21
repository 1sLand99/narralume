import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCanonEntity,
  createOutlineNode,
  createProject,
} from "@narralume/domain";
import { SqliteProjectRepository } from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { StoryStateSnapshotSchema } from "@narralume/contracts";
import { seedStoryState } from "../../../scripts/fixtures/story-state.js";
import { buildApp } from "../src/app.js";

let database: NodeNarrativeDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let fixture: ReturnType<typeof seedStoryState>;
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
const url = (query: string) =>
  `/api/projects/state-fixture/story-state?${query}`;

describe("chapter state API", () => {
  it("returns a complete read-only projection with chapter and audience metadata", async () => {
    const before = database.raw
      .prepare("SELECT total_changes() AS changes")
      .get();
    const response = await app.inject({
      url: url("chapterId=state-c2&audience=author"),
    });
    expect(response.statusCode, response.body).toBe(200);
    const snapshot = StoryStateSnapshotSchema.parse(response.json());
    expect(snapshot).toMatchObject({
      chapterId: "state-c2",
      audience: "author",
      characterId: null,
    });
    expect(snapshot.knowledge).toHaveLength(4);
    expect(snapshot.foreshadows[0]?.resolutionNodeId).toBeNull();
    expect(snapshot.foreshadows[0]?.evidenceNodeIds).toEqual([
      "state-c1",
      "state-scene",
    ]);
    expect(
      database.raw.prepare("SELECT total_changes() AS changes").get(),
    ).toEqual(before);
  });

  it("filters secrets and other characters from the response itself, not just UI rendering", async () => {
    const response = await app.inject({
      url: url("chapterId=state-c2&audience=character&characterId=state-hero"),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("PROFILE_SECRET");
    expect(response.body).not.toContain("守灯人");
    expect(response.body).not.toContain("FUTURE_ROUTE");
    const snapshot = StoryStateSnapshotSchema.parse(response.json());
    expect(
      snapshot.knowledge.every(
        (item) => item.record.knowerEntityId === fixture.hero.id,
      ),
    ).toBe(true);
    expect(snapshot.facts).toEqual([]);
    expect(snapshot.timeline).toEqual([]);
    expect(snapshot.foreshadows).toEqual([]);
    expect(snapshot.relationships.map((item) => item.id)).toEqual([
      "state-distrust",
    ]);
    const later = await app.inject({
      url: url("chapterId=state-c12&audience=character&characterId=state-hero"),
    });
    expect(later.body).toContain("守灯人");
    expect(later.body).not.toContain("FUTURE_ROUTE");
  });

  it("rejects incomplete or ambiguous audience queries", async () => {
    for (const [query, status] of [
      ["audience=author", 400],
      ["chapterId=state-c2&audience=character", 400],
      ["chapterId=state-c2&audience=reader&characterId=state-hero", 422],
      ["chapterId=state-c2&audience=omniscient", 400],
    ] as const) {
      expect((await app.inject({ url: url(query) })).statusCode, query).toBe(
        status,
      );
    }
  });

  it("rejects unavailable chapters and non-character or cross-project entities", async () => {
    const now = fixture.hero.createdAt;
    new SqliteProjectRepository(database).insert(
      createProject({ id: "other", title: "Other", now }),
    );
    const root = fixture.story.insertOutlineNode(
      createOutlineNode({
        id: "other-root",
        projectId: "other",
        parent: null,
        kind: "book",
        ordinal: 0,
        title: "Other",
        now,
      }),
    );
    const other = fixture.story.insertOutlineNode(
      createOutlineNode({
        id: "other-chapter",
        projectId: "other",
        parent: root,
        kind: "chapter",
        ordinal: 0,
        title: "Other",
        now,
      }),
    );
    fixture.canon.insertEntity(
      createCanonEntity({
        id: "other-person",
        projectId: "other",
        name: "Other",
        type: "character",
        now,
      }),
    );
    fixture.canon.insertEntity(
      createCanonEntity({
        id: "local-place",
        projectId: fixture.projectId,
        name: "Port",
        type: "location",
        now,
      }),
    );
    for (const id of ["missing", "state-book", "state-scene", other.id]) {
      const response = await app.inject({
        url: url(`chapterId=${id}&audience=author`),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe(
        "story_state.chapter_unavailable",
      );
    }
    for (const id of ["missing", "other-person", "local-place"]) {
      const response = await app.inject({
        url: url(`chapterId=state-c1&audience=character&characterId=${id}`),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe(
        "story_state.character_unavailable",
      );
    }
    fixture.story.updateOutlineStatus(
      fixture.projectId,
      "state-vz",
      "abandoned",
      now,
    );
    expect(
      (await app.inject({ url: url("chapterId=state-c2&audience=author") }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          url: "/api/projects/missing/story-state?chapterId=state-c2&audience=author",
        })
      ).statusCode,
    ).toBe(404);
  });
});
