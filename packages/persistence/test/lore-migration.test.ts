import {
  createDefaultPersonaCardProfile,
  createProject,
  type StoryPersona,
} from "@narralume/domain";
import { afterEach, describe, expect, it } from "vitest";

import {
  SqliteCreativeRepository,
  SqliteLoreRepository,
  SqliteProjectRepository,
} from "../src/index.js";
import { NodeNarrativeDatabase } from "../src/node.js";

const now = "2026-08-30T00:00:00.000Z";
const databases: NodeNarrativeDatabase[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

describe("migration 044 (lorebooks)", () => {
  it("installs strict tables, indexes, foreign keys, and project ownership checks", () => {
    const { database, creative, lore } = setup();
    expect(database.currentMigration()).toBe(44);

    const indexes = database.raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name LIKE '%lorebook%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "cocreate_session_lorebooks_book_idx",
        "lorebooks_project_enabled_idx",
        "persona_lorebooks_book_idx",
      ]),
    );

    lore.insertLorebook({
      id: "book",
      projectId: "project",
      name: "雾港志",
      description: null,
      enabledGlobally: true,
      scanTurns: 24,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      version: 0,
    });
    lore.insertLoreEntry({
      id: "entry",
      lorebookId: "book",
      title: "潮汐",
      content: "每月退潮一次。",
      keys: ["退潮"],
      constant: false,
      priority: 0,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      version: 0,
    });

    expect(() =>
      database.raw
        .prepare(
          `INSERT INTO lore_entries(
             id, lorebook_id, title, content, keys_json, constant, priority,
             enabled, created_at, updated_at, version
           ) VALUES ('invalid', 'book', '无触发器', '内容', '[]', 0, 0, 1, ?, ?, 0)`,
        )
        .run(now, now),
    ).toThrow();
    expect(() =>
      database.raw
        .prepare("UPDATE lorebooks SET scan_turns = -1 WHERE id = 'book'")
        .run(),
    ).toThrow();

    creative.insertPersona(persona("other-persona", "other"));
    expect(() =>
      database.raw
        .prepare(
          "INSERT INTO persona_lorebooks(persona_id, lorebook_id) VALUES ('other-persona', 'book')",
        )
        .run(),
    ).toThrowError(/lorebook\.project_mismatch/u);
    expect(database.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    database.raw.prepare("DELETE FROM lorebooks WHERE id = 'book'").run();
    expect(
      database.raw.prepare("SELECT COUNT(*) AS count FROM lore_entries").get(),
    ).toEqual({ count: 0 });
  });

  it("blocks all direct writes after recycle while preserving project purge cascades", () => {
    const { database, projects, lore } = setup();
    lore.insertLorebook({
      id: "guard-book",
      projectId: "project",
      name: "回收站守卫",
      description: null,
      enabledGlobally: true,
      scanTurns: 24,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      version: 0,
    });
    lore.insertLoreEntry({
      id: "guard-entry",
      lorebookId: "guard-book",
      title: "守卫",
      content: "不可改写。",
      keys: ["守卫"],
      constant: false,
      priority: 0,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      version: 0,
    });
    lore.replacePersonaLorebooks("persona", ["guard-book"], 0, now);
    lore.replaceSessionLorebooks("session", ["guard-book"], 0, now);

    const recycled = projects.softDelete(
      "project",
      now,
      "2026-08-30T01:00:00.000Z",
    );
    const rejectedWrites = [
      () =>
        database.raw
          .prepare("UPDATE lorebooks SET name = '改写' WHERE id = 'guard-book'")
          .run(),
      () =>
        database.raw
          .prepare(
            "UPDATE lore_entries SET content = '改写' WHERE id = 'guard-entry'",
          )
          .run(),
      () =>
        database.raw
          .prepare(
            "DELETE FROM persona_lorebooks WHERE persona_id = 'persona' AND lorebook_id = 'guard-book'",
          )
          .run(),
      () =>
        database.raw
          .prepare(
            "DELETE FROM cocreate_session_lorebooks WHERE session_id = 'session' AND lorebook_id = 'guard-book'",
          )
          .run(),
      () =>
        database.raw
          .prepare("DELETE FROM lore_entries WHERE id = 'guard-entry'")
          .run(),
      () =>
        database.raw
          .prepare("DELETE FROM lorebooks WHERE id = 'guard-book'")
          .run(),
    ];
    for (const write of rejectedWrites) {
      expect(write).toThrowError(/project\.not_found/u);
    }

    expect(projects.purge("project", recycled.deletionToken!)).toBe(true);
    for (const table of [
      "lorebooks",
      "lore_entries",
      "persona_lorebooks",
      "cocreate_session_lorebooks",
    ]) {
      expect(
        database.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
      ).toEqual({ count: 0 });
    }
    expect(database.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

function setup() {
  const database = new NodeNarrativeDatabase();
  databases.push(database);
  database.migrate();
  const projects = new SqliteProjectRepository(database);
  projects.insert(createProject({ id: "project", title: "雾港", now }));
  projects.insert(createProject({ id: "other", title: "他乡", now }));
  const creative = new SqliteCreativeRepository(database);
  creative.insertPersona(persona("persona", "project"));
  creative.createSession({
    id: "session",
    branchId: "branch",
    projectId: "project",
    title: "雾港试演",
    speakerPolicy: "natural",
    targetOutlineNodeId: null,
    authorPersonaId: null,
    directorNote: null,
    contextTurns: 24,
    participantIds: ["persona"],
    now,
  });
  return {
    database,
    projects,
    creative,
    lore: new SqliteLoreRepository(database),
  };
}

function persona(id: string, projectId: string): StoryPersona {
  return {
    id,
    projectId,
    kind: "character",
    entityId: null,
    name: id,
    description: null,
    instructions: "",
    voice: {},
    profile: createDefaultPersonaCardProfile(),
    status: "active",
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}
