import {
  createDefaultPersonaCardProfile,
  createProject,
  type Lorebook,
  type LoreEntry,
  type StoryPersona,
} from "@narralume/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LorePersistenceError,
  SqliteCreativeRepository,
  SqliteLoreRepository,
  SqliteProjectRepository,
} from "../src/index.js";
import { NodeNarrativeDatabase } from "../src/node.js";

const now = "2026-08-30T00:00:00.000Z";
const later = "2026-08-30T01:00:00.000Z";
let database: NodeNarrativeDatabase;
let creative: SqliteCreativeRepository;
let lore: SqliteLoreRepository;

beforeEach(() => {
  database = new NodeNarrativeDatabase();
  database.migrate();
  const projects = new SqliteProjectRepository(database);
  projects.insert(createProject({ id: "project", title: "雾港", now }));
  projects.insert(createProject({ id: "other", title: "他乡", now }));
  creative = new SqliteCreativeRepository(database);
  creative.insertPersona(persona("persona", "project"));
  creative.insertPersona(persona("other-persona", "other"));
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
  creative.createSession({
    id: "other-session",
    branchId: "other-branch",
    projectId: "other",
    title: "他乡试演",
    speakerPolicy: "natural",
    targetOutlineNodeId: null,
    authorPersonaId: null,
    directorNote: null,
    contextTurns: 24,
    participantIds: ["other-persona"],
    now,
  });
  lore = new SqliteLoreRepository(database);
});

afterEach(() => database.close());

describe("SqliteLoreRepository", () => {
  it("round-trips Lorebook and entry CRUD with compare-and-swap versions", () => {
    const insertedBook = lore.insertLorebook(book("book", "project"));
    const insertedEntry = lore.insertLoreEntry(entry("entry", insertedBook.id));

    expect(insertedBook.version).toBe(0);
    expect(insertedEntry.keys).toEqual(["雾港", "退潮"]);
    expect(lore.requireLorebookDetail("book")).toEqual({
      lorebook: insertedBook,
      entries: [insertedEntry],
    });

    const updatedBook = lore.updateLorebook("book", {
      name: "雾港秘志",
      description: "只在退潮时出现。",
      enabledGlobally: false,
      scanTurns: 0,
      enabled: true,
      updatedAt: later,
      expectedVersion: 0,
    });
    expect(updatedBook).toMatchObject({
      name: "雾港秘志",
      scanTurns: 0,
      version: 1,
      updatedAt: later,
    });
    expectLoreCode(
      () =>
        lore.updateLorebook("book", {
          name: "旧写入",
          description: null,
          enabledGlobally: true,
          scanTurns: 24,
          enabled: true,
          updatedAt: later,
          expectedVersion: 0,
        }),
      "lorebook.version.conflict",
    );

    const updatedEntry = lore.updateLoreEntry("entry", {
      title: "潮汐门",
      content: "潮汐门每月开启一次。",
      keys: ["潮汐门"],
      constant: false,
      priority: 90,
      enabled: true,
      updatedAt: later,
      expectedVersion: 0,
    });
    expect(updatedEntry).toMatchObject({
      title: "潮汐门",
      priority: 90,
      version: 1,
    });
    expectLoreCode(
      () => lore.deleteLoreEntry("entry", 0),
      "lore_entry.version.conflict",
    );
    expect(lore.deleteLoreEntry("entry", 1)).toBe(true);
    expect(lore.deleteLorebook("book", 1)).toBe(true);
    expect(lore.getLorebook("book")).toBeNull();
  });

  it("rejects duplicate names and titles with stable codes", () => {
    lore.insertLorebook(book("book", "project"));
    expectLoreCode(
      () =>
        lore.insertLorebook({ ...book("book-2", "project"), name: "雾港志" }),
      "lorebook.name.conflict",
    );
    lore.insertLoreEntry(entry("entry", "book"));
    expectLoreCode(
      () =>
        lore.insertLoreEntry({ ...entry("entry-2", "book"), title: "潮汐" }),
      "lore_entry.title.conflict",
    );
  });

  it("atomically replaces Persona and session bindings while bumping target versions", () => {
    lore.insertLorebook(book("book-a", "project"));
    lore.insertLorebook({
      ...book("book-b", "project"),
      name: "灯塔志",
      enabledGlobally: false,
    });
    lore.insertLorebook(book("other-book", "other"));

    const personaState = lore.replacePersonaLorebooks(
      "persona",
      ["book-b", "book-a"],
      0,
      later,
    );
    expect(personaState).toEqual({
      targetId: "persona",
      lorebookIds: ["book-a", "book-b"],
      version: 1,
      updatedAt: later,
    });
    expect(creative.requirePersona("persona").version).toBe(1);
    expect(lore.listPersonaLorebooks("persona").map(({ id }) => id)).toEqual([
      "book-b",
      "book-a",
    ]);

    expectLoreCode(
      () => lore.replacePersonaLorebooks("persona", ["book-a"], 0, later),
      "persona.version.conflict",
    );
    expectLoreCode(
      () => lore.replacePersonaLorebooks("persona", ["other-book"], 1, later),
      "lorebook.project.mismatch",
    );
    expect(lore.listPersonaLorebooks("persona")).toHaveLength(2);

    const sessionState = lore.replaceSessionLorebooks(
      "session",
      ["book-b"],
      0,
      later,
    );
    expect(sessionState.version).toBe(1);
    expect(creative.requireSession("session").version).toBe(1);
    expectLoreCode(
      () => lore.replaceSessionLorebooks("session", ["other-book"], 1, later),
      "lorebook.project.mismatch",
    );
  });

  it("projects global, Persona, and session candidates without losing overlapping scopes", () => {
    lore.insertLorebook(book("shared", "project"));
    lore.insertLorebook({
      ...book("persona-only", "project"),
      name: "人物私志",
      enabledGlobally: false,
    });
    lore.insertLoreEntry(entry("shared-entry", "shared"));
    lore.insertLoreEntry(entry("private-entry", "persona-only"));
    lore.replacePersonaLorebooks(
      "persona",
      ["shared", "persona-only"],
      0,
      later,
    );
    lore.replaceSessionLorebooks("session", ["shared"], 0, later);

    const candidates = lore.listLoreActivationCandidates(
      "project",
      "persona",
      "session",
    );
    expect(
      candidates
        .filter(({ entry }) => entry.id === "shared-entry")
        .map(({ scope }) => scope),
    ).toEqual(["project", "persona", "session"]);
    expect(
      candidates
        .filter(({ entry }) => entry.id === "private-entry")
        .map(({ scope }) => scope),
    ).toEqual(["persona"]);
    expect(() =>
      lore.listLoreActivationCandidates("project", "other-persona", "session"),
    ).toThrowError(/same project/u);
  });
});

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

function book(id: string, projectId: string): Lorebook {
  return {
    id,
    projectId,
    name: projectId === "project" ? "雾港志" : "他乡志",
    description: null,
    enabledGlobally: true,
    scanTurns: 24,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

function entry(id: string, lorebookId: string): LoreEntry {
  return {
    id,
    lorebookId,
    title: "潮汐",
    content: "雾港每月只退潮一次。",
    keys: ["雾港", "退潮"],
    constant: false,
    priority: 50,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

function expectLoreCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected LorePersistenceError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(LorePersistenceError);
    expect((error as LorePersistenceError).code).toBe(code);
  }
}
