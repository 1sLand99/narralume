import {
  createDefaultPersonaCardProfile,
  createProject,
  transitionProjectPhase,
} from "@narralume/domain";
import { NodeNarrativeDatabase } from "../src/node.js";
import { afterEach, describe, expect, it } from "vitest";

import { MigrationError, SqliteProjectRepository } from "../src/index.js";
import { migration001 } from "../src/migrations/001-foundation.js";
import { migration002 } from "../src/migrations/002-story-kernel.js";
import { migration003 } from "../src/migrations/003-harness.js";
import { migration004 } from "../src/migrations/004-autopilot.js";
import { migration005 } from "../src/migrations/005-cocreate-studio.js";
import { migration006 } from "../src/migrations/006-delivery.js";
import { migration007 } from "../src/migrations/007-editing-safety.js";
import { migration008 } from "../src/migrations/008-canon-fact-withdrawals.js";
import { migration009 } from "../src/migrations/009-review-workspace.js";
import { migration010 } from "../src/migrations/010-run-streams.js";
import { migration011 } from "../src/migrations/011-long-novel-intelligence.js";
import { migration012 } from "../src/migrations/012-product-lifecycle.js";
import { migration013 } from "../src/migrations/013-resilient-import-analysis.js";
import { migration014 } from "../src/migrations/014-data-safety.js";
import { migration015 } from "../src/migrations/015-llm-call-interruption.js";
import { migration016 } from "../src/migrations/016-providers-models-assignments.js";
import { migration017 } from "../src/migrations/017-profile-fk-to-models.js";
import { migration018 } from "../src/migrations/018-run-observability.js";
import { migration019 } from "../src/migrations/019-physical-call-reservations.js";
import { migration020 } from "../src/migrations/020-model-runtime-convergence.js";
import { migration021 } from "../src/migrations/021-cross-chapter-settlement.js";
import { migration022 } from "../src/migrations/022-project-foundation-requests.js";
import { migration023 } from "../src/migrations/023-chapter-document-identity.js";
import { migration041 } from "../src/migrations/041-review-author-decisions.js";
import { migration042 } from "../src/migrations/042-cocreate-natural-speaker.js";
import { migration043 } from "../src/migrations/043-persona-card-profile.js";

const MIGRATIONS_UP_TO_023 = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
  migration016,
  migration017,
  migration018,
  migration019,
  migration020,
  migration021,
  migration022,
  migration023,
];
const MUTATED_MIGRATION_023_CHECKSUM =
  "87b6b3a74f72bc6d9739689c35c388a7def69badc4c4439d3fb8d0e2a8d43472";

const databases: NodeNarrativeDatabase[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

function database(): NodeNarrativeDatabase {
  const value = new NodeNarrativeDatabase();
  value.migrate();
  databases.push(value);
  return value;
}

describe("NodeNarrativeDatabase", () => {
  it("applies the B1 migrations idempotently and enforces checksums", () => {
    const db = database();
    expect(db.currentMigration()).toBe(44);
    expect(db.migrate()).toBe(44);
    expect(
      db.raw
        .prepare("SELECT checksum FROM schema_migrations WHERE version = 23")
        .get(),
    ).toEqual({
      checksum:
        "b1f666c4425d817f593b39ca166e595fde19b8f67c11d066bfaf2d5e9fd2da66",
    });
    expect(() =>
      db.migrate([{ version: 20, name: "changed", sql: "SELECT 1;" }]),
    ).toThrow(MigrationError);
  });

  it("backfills author-decision flags for existing blocked review issues", () => {
    const db = new NodeNarrativeDatabase();
    databases.push(db);
    db.raw.exec(`
      CREATE TABLE review_issues (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE review_reports (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        verdict TEXT NOT NULL
      ) STRICT;
      CREATE TABLE run_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        output_artifact_json TEXT
      ) STRICT;
      INSERT INTO review_issues(id) VALUES ('decision-issue'), ('ordinary-issue');
      INSERT INTO review_reports(id, run_id, step_id, verdict)
      VALUES ('report-1', 'run-1', 'review-1', 'block');
      INSERT INTO run_steps(id, run_id, output_artifact_json)
      VALUES (
        'review-1',
        'run-1',
        '{"issues":[{"id":"decision-issue","requiresAuthorDecision":true},{"id":"ordinary-issue","requiresAuthorDecision":false}]}'
      );
    `);

    expect(db.migrate([migration041])).toBe(41);
    expect(
      db.raw
        .prepare(
          "SELECT id, requires_author_decision FROM review_issues ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: "decision-issue", requires_author_decision: 1 },
      { id: "ordinary-issue", requires_author_decision: 0 },
    ]);
  });

  it("replaces legacy auto speaker sessions with natural speaker sessions", () => {
    const db = new NodeNarrativeDatabase();
    databases.push(db);
    db.raw.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        deleted_at TEXT
      ) STRICT;
      CREATE TABLE story_personas (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL
      ) STRICT;
      CREATE TABLE outline_nodes (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE cocreate_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','paused','archived')),
        speaker_policy TEXT NOT NULL CHECK (speaker_policy IN ('manual','round_robin','auto')),
        active_branch_id TEXT,
        target_outline_node_id TEXT REFERENCES outline_nodes(id) ON DELETE SET NULL,
        author_persona_id TEXT REFERENCES story_personas(id) ON DELETE SET NULL,
        director_note TEXT,
        context_turns INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE cocreate_participants (
        session_id TEXT NOT NULL REFERENCES cocreate_sessions(id) ON DELETE CASCADE,
        persona_id TEXT NOT NULL REFERENCES story_personas(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        talkativeness REAL NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(session_id, persona_id)
      ) WITHOUT ROWID;
      CREATE TABLE story_branches (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES cocreate_sessions(id) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO projects(id, deleted_at) VALUES ('p1', NULL);
      INSERT INTO story_personas(id, project_id, kind)
      VALUES ('n1', 'p1', 'narrator');
      INSERT INTO cocreate_sessions(
        id, project_id, title, status, speaker_policy, active_branch_id,
        target_outline_node_id, author_persona_id, director_note,
        context_turns, created_at, updated_at, version
      ) VALUES (
        's1', 'p1', 'Legacy room', 'active', 'auto', NULL,
        NULL, NULL, NULL, 24, '2026-01-01', '2026-01-01', 0
      );
      INSERT INTO cocreate_participants(
        session_id, persona_id, position, enabled, talkativeness, created_at
      ) VALUES ('s1', 'n1', 0, 1, 0.5, '2026-01-01');
    `);

    expect(db.migrate([migration042])).toBe(42);
    expect(
      db.raw
        .prepare("SELECT speaker_policy FROM cocreate_sessions WHERE id = 's1'")
        .get(),
    ).toEqual({ speaker_policy: "natural" });
    expect(db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO cocreate_sessions(
            id, project_id, title, status, speaker_policy, active_branch_id,
            target_outline_node_id, author_persona_id, director_note,
            context_turns, created_at, updated_at, version
          ) VALUES ('s2', 'p1', 'No auto', 'active', 'auto', NULL, NULL,
            NULL, NULL, 24, '2026-01-01', '2026-01-01', 0)`,
        )
        .run(),
    ).toThrow();
  });

  it("backfills existing personas with a valid native card profile", () => {
    const db = new NodeNarrativeDatabase();
    databases.push(db);
    db.raw.exec(`
      CREATE TABLE story_personas (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      ) STRICT;
      INSERT INTO story_personas(id, name) VALUES ('legacy', '旧角色');
    `);

    expect(db.migrate([migration043])).toBe(43);
    const row = db.raw
      .prepare("SELECT profile_json FROM story_personas WHERE id = 'legacy'")
      .get() as { profile_json: string };
    expect(JSON.parse(row.profile_json)).toEqual(
      createDefaultPersonaCardProfile(),
    );
    expect(() =>
      db.raw
        .prepare(
          "UPDATE story_personas SET profile_json = 'not-json' WHERE id = 'legacy'",
        )
        .run(),
    ).toThrow();
  });

  it("installs project write guards while preserving run cleanup updates", () => {
    const db = database();
    const triggers = db.raw
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'trigger' AND name LIKE '%-project-write-guard-%'`,
      )
      .all() as { name: string }[];
    const names = new Set(triggers.map((trigger) => trigger.name));

    expect(names).toContain("timeline-events-project-write-guard-insert");
    expect(names).toContain("document-versions-project-write-guard-update");
    expect(names).toContain("runs-project-write-guard-insert");
    expect(names).not.toContain("runs-project-write-guard-update");
  });

  it("upgrades the originally applied migration 23 without rewriting its checksum", () => {
    const db = new NodeNarrativeDatabase();
    databases.push(db);
    expect(db.migrate(MIGRATIONS_UP_TO_023)).toBe(23);
    const project = createProject({
      id: "migration-24-project",
      title: "迁移样本",
      premise: "旧正文检索段应由下一版迁移清理。",
      now: "2026-08-12T00:00:00.000Z",
    });
    new SqliteProjectRepository(db).insert(project);
    db.raw
      .prepare(
        `INSERT INTO text_segments(
          id, project_id, source_type, source_id, title, content, authority,
          metadata_json, created_at, updated_at
        ) VALUES (?, ?, 'document_version', ?, ?, ?, 'confirmed', '{}', ?, ?)`,
      )
      .run(
        "legacy-document-version",
        project.id,
        "legacy-version",
        "旧版本",
        "应被清理",
        project.createdAt,
        project.createdAt,
      );

    expect(db.migrate()).toBe(44);
    expect(
      db.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM text_segments WHERE source_type = 'document_version'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("repairs databases that applied the briefly mutated migration 23", () => {
    const db = new NodeNarrativeDatabase();
    databases.push(db);
    expect(db.migrate(MIGRATIONS_UP_TO_023)).toBe(23);
    db.raw
      .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 23")
      .run(MUTATED_MIGRATION_023_CHECKSUM);

    expect(db.migrate()).toBe(44);
    expect(
      db.raw
        .prepare("SELECT checksum FROM schema_migrations WHERE version = 23")
        .get(),
    ).toEqual({
      checksum:
        "b1f666c4425d817f593b39ca166e595fde19b8f67c11d066bfaf2d5e9fd2da66",
    });
  });

  it("converges the schema without legacy model selection tables or columns", () => {
    const db = database();
    const tables = db.raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'model_profiles', 'model_routing_rules', 'run_model_snapshots',
           'model_assignment_snapshots'
         ) ORDER BY name`,
      )
      .all() as unknown as { name: string }[];
    expect(tables.map((row) => row.name)).toEqual([
      "model_assignment_snapshots",
    ]);
    const runColumns = db.raw
      .prepare("PRAGMA table_info(runs)")
      .all() as unknown as {
      name: string;
    }[];
    expect(runColumns.map((row) => row.name)).not.toContain("profile_id");
    const callColumns = db.raw
      .prepare("PRAGMA table_info(llm_calls)")
      .all() as unknown as { name: string }[];
    expect(callColumns.map((row) => row.name)).toContain("model_id");
    expect(callColumns.map((row) => row.name)).not.toContain("profile_id");
  });

  it("rolls back outer and nested transactions", () => {
    const db = database();
    expect(() =>
      db.transaction(() => {
        db.raw.exec("CREATE TABLE rollback_probe(id TEXT PRIMARY KEY) STRICT;");
        db.transaction(() => {
          db.raw.prepare("INSERT INTO rollback_probe(id) VALUES (?)").run("x");
        });
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(
      db.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='rollback_probe'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("rolls back an invalid foreign-keys-off migration before recording its version", () => {
    const db = new NodeNarrativeDatabase();
    databases.push(db);
    const foundation = {
      version: 1,
      name: "foreign-key-foundation",
      sql: `
        CREATE TABLE parent(id TEXT PRIMARY KEY) STRICT;
        CREATE TABLE child(
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL REFERENCES parent(id)
        ) STRICT;
        INSERT INTO parent(id) VALUES ('parent-1');
        INSERT INTO child(id, parent_id) VALUES ('child-1', 'parent-1');
      `,
    };
    const invalidRebuild = {
      version: 2,
      name: "invalid-parent-rebuild",
      foreignKeysOff: true,
      sql: `
        DROP TABLE parent;
        CREATE TABLE parent(id TEXT PRIMARY KEY) STRICT;
      `,
    };

    expect(db.migrate([foundation])).toBe(1);
    expect(() => db.migrate([foundation, invalidRebuild])).toThrow(
      /broke 1 foreign key references/,
    );

    expect(db.currentMigration()).toBe(1);
    expect(db.raw.prepare("SELECT * FROM parent").all()).toEqual([
      { id: "parent-1" },
    ]);
    expect(db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.raw.prepare("PRAGMA foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });
  });
});

describe("repositories", () => {
  it("round-trips projects and validates phase updates in the domain", () => {
    const db = database();
    const projects = new SqliteProjectRepository(db);
    const created = createProject({
      id: "p-1",
      title: "潮汐灯塔",
      premise: "灯灭时，港口会遗忘一个人。",
      now: "2026-08-10T00:00:00.000Z",
    });
    projects.insert(created);
    expect(projects.get("p-1")).toEqual(created);
    projects.update(
      transitionProjectPhase(created, "foundation", "2026-08-10T00:01:00.000Z"),
    );
    expect(projects.get("p-1")?.phase).toBe("foundation");
  });
});
