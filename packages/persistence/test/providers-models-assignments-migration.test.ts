import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { NodeNarrativeDatabase } from "../src/node.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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

const MIGRATIONS_UP_TO_015 = [
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
];
const MIGRATIONS_UP_TO_019 = [
  ...MIGRATIONS_UP_TO_015,
  migration016,
  migration017,
  migration018,
  migration019,
];

const now = "2026-08-10T00:00:00.000Z";
const later = "2026-08-10T01:02:03.000Z";

const databases: NodeNarrativeDatabase[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

function databaseAt015(): NodeNarrativeDatabase {
  const db = new NodeNarrativeDatabase();
  databases.push(db);
  db.migrate(MIGRATIONS_UP_TO_015);
  expect(db.currentMigration()).toBe(15);
  return db;
}

function insertProfile(
  db: NodeNarrativeDatabase,
  profile: {
    id: string;
    name: string;
    protocol: string;
    model: string;
    apiKeyEnv: string;
    enabled?: number;
    endpoint?: string | null;
    anthropicVersion?: string | null;
    extraHeaders?: Record<string, string>;
    capabilities?: Record<string, boolean>;
    createdAt?: string;
  },
): void {
  db.raw
    .prepare(
      `INSERT INTO model_profiles(
        id, name, protocol, base_url, endpoint, model, api_key_env,
        anthropic_version, extra_headers_json, capabilities_json,
        enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      profile.id,
      profile.name,
      profile.protocol,
      `https://api.example.com/${profile.id}`,
      profile.endpoint ?? null,
      profile.model,
      profile.apiKeyEnv,
      profile.anthropicVersion ?? null,
      JSON.stringify(profile.extraHeaders ?? {}),
      JSON.stringify(profile.capabilities ?? {}),
      profile.enabled ?? 1,
      profile.createdAt ?? now,
      later,
    );
}

function insertRoutingRule(
  db: NodeNarrativeDatabase,
  role: string,
  primaryProfileId: string,
): void {
  db.raw
    .prepare(
      `INSERT INTO model_routing_rules(
        id, role, primary_profile_id, fallback_profile_ids_json, enabled, updated_at
      ) VALUES (?, ?, ?, '[]', 1, ?)`,
    )
    .run(`route-${role}`, role, primaryProfileId, later);
}

interface ProviderRow {
  id: string;
  name: string;
  wire_api: string;
  base_url: string;
  endpoint: string | null;
  credential_ref: string;
  anthropic_version: string | null;
  headers_json: string | null;
  query_params_json: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface ModelRow {
  id: string;
  provider_id: string;
  model_id: string;
  task_type: string;
  capabilities_json: string | null;
  metadata_source: string;
  metadata_verified_at: string | null;
  enabled: number;
}

interface AssignmentRow {
  role: string;
  model_id: string;
  updated_at: string;
}

describe("migration 016 (providers-models-assignments)", () => {
  it("creates and verifies a pre-B1 backup before the irreversible migration", () => {
    const directory = mkdtempSync(join(tmpdir(), "narrative-pre-b1-"));
    const databasePath = join(directory, "novel.sqlite");
    const db = new NodeNarrativeDatabase(databasePath);
    try {
      expect(db.migrate(MIGRATIONS_UP_TO_019)).toBe(19);
      expect(db.migrate()).toBe(44);
      const backupName = readdirSync(directory).find(
        (name) =>
          name.startsWith("novel.sqlite.pre-b1-") && name.endsWith(".sqlite"),
      );
      expect(backupName).toBeDefined();
      const backup = new NodeNarrativeDatabase(join(directory, backupName!));
      try {
        expect(backup.currentMigration()).toBe(19);
        expect(backup.raw.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
      } finally {
        backup.close();
      }
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("copies profiles and routing rules into providers/models/assignments", () => {
    const db = databaseAt015();
    insertProfile(db, {
      id: "p-chat",
      name: "OpenAI Chat",
      protocol: "openai-chat",
      model: "gpt-4o",
      apiKeyEnv: "OPENAI_KEY",
      endpoint: "/chat/completions",
      extraHeaders: { "x-tenant": "novel" },
      capabilities: { streaming: true },
    });
    insertProfile(db, {
      id: "p-responses",
      name: "OpenAI Responses",
      protocol: "openai-responses",
      model: "gpt-4.1",
      apiKeyEnv: "OPENAI_RESPONSES_KEY",
    });
    insertProfile(db, {
      id: "p-anthropic",
      name: "Anthropic",
      protocol: "anthropic-messages",
      model: "claude-sonnet-4",
      apiKeyEnv: "ANTHROPIC_KEY",
      anthropicVersion: "2023-06-01",
    });
    insertProfile(db, {
      id: "p-disabled",
      name: "Disabled",
      protocol: "openai-chat",
      model: "old-model",
      apiKeyEnv: "OLD_KEY",
      enabled: 0,
    });
    insertRoutingRule(db, "drafting", "p-chat");
    insertRoutingRule(db, "planning", "p-responses");
    insertRoutingRule(db, "review", "p-anthropic");
    insertRoutingRule(db, "revision", "p-chat");

    db.migrate();
    expect(db.currentMigration()).toBe(44);

    const providers = db.raw
      .prepare("SELECT * FROM providers ORDER BY id")
      .all() as unknown as ProviderRow[];
    expect(providers).toHaveLength(4);
    expect(providers.find((row) => row.id === "p-chat")).toMatchObject({
      name: "OpenAI Chat",
      wire_api: "openai-chat",
      base_url: "https://api.example.com/p-chat",
      endpoint: "/chat/completions",
      credential_ref: "env:OPENAI_KEY",
      anthropic_version: null,
      headers_json: JSON.stringify({ "x-tenant": "novel" }),
      query_params_json: null,
      enabled: 1,
      created_at: now,
      updated_at: later,
    });
    expect(providers.find((row) => row.id === "p-anthropic")).toMatchObject({
      wire_api: "anthropic-messages",
      anthropic_version: "2023-06-01",
      credential_ref: "env:ANTHROPIC_KEY",
    });
    expect(providers.find((row) => row.id === "p-disabled")?.enabled).toBe(0);

    const models = db.raw
      .prepare("SELECT * FROM models ORDER BY id")
      .all() as unknown as ModelRow[];
    expect(models).toHaveLength(4);
    expect(models.find((row) => row.id === "p-chat")).toMatchObject({
      provider_id: "p-chat",
      model_id: "gpt-4o",
      task_type: "writing",
      capabilities_json: JSON.stringify({ streaming: true }),
      metadata_source: "migration",
      metadata_verified_at: null,
      enabled: 1,
    });
    expect(models.find((row) => row.id === "p-disabled")?.enabled).toBe(0);

    const assignments = db.raw
      .prepare("SELECT * FROM model_assignments ORDER BY role")
      .all() as unknown as AssignmentRow[];
    expect(assignments).toEqual([
      { role: "writing", model_id: "p-chat", updated_at: later },
    ]);

    const legacyTables = db.raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('model_profiles', 'model_routing_rules')`,
      )
      .all();
    expect(legacyTables).toEqual([]);

    // Idempotent: migrating again is a no-op.
    expect(db.migrate()).toBe(44);
    expect(
      db.raw.prepare("SELECT COUNT(*) AS count FROM providers").get(),
    ).toEqual({ count: 4 });
  });

  it("inserts a deterministic writing default when no rules exist", () => {
    const db = databaseAt015();
    insertProfile(db, {
      id: "b-later",
      name: "Later",
      protocol: "openai-chat",
      model: "m-b",
      apiKeyEnv: "KEY_B",
      createdAt: "2026-08-09T00:00:00.000Z",
    });
    insertProfile(db, {
      id: "a-first",
      name: "First",
      protocol: "openai-chat",
      model: "m-a",
      apiKeyEnv: "KEY_A",
      createdAt: "2026-08-08T00:00:00.000Z",
    });
    insertProfile(db, {
      id: "c-disabled-earliest",
      name: "Disabled Earliest",
      protocol: "openai-chat",
      model: "m-c",
      apiKeyEnv: "KEY_C",
      enabled: 0,
      createdAt: "2026-08-07T00:00:00.000Z",
    });

    db.migrate();

    const assignments = db.raw
      .prepare("SELECT * FROM model_assignments")
      .all() as unknown as AssignmentRow[];
    // First enabled model by (created_at, id); the disabled one is skipped.
    expect(assignments).toEqual([
      { role: "writing", model_id: "a-first", updated_at: later },
    ]);
  });

  it("keeps an existing writing rule instead of inserting a default", () => {
    const db = databaseAt015();
    insertProfile(db, {
      id: "p-chat",
      name: "Chat",
      protocol: "openai-chat",
      model: "gpt-4o",
      apiKeyEnv: "OPENAI_KEY",
    });
    insertRoutingRule(db, "drafting", "p-chat");

    db.migrate();

    const assignments = db.raw
      .prepare("SELECT * FROM model_assignments")
      .all() as unknown as AssignmentRow[];
    expect(assignments).toEqual([
      { role: "writing", model_id: "p-chat", updated_at: later },
    ]);
  });

  it("inserts no assignments when there are no models at all", () => {
    const db = databaseAt015();
    db.migrate();
    expect(db.currentMigration()).toBe(44);
    expect(
      db.raw.prepare("SELECT COUNT(*) AS count FROM model_assignments").get(),
    ).toEqual({ count: 0 });
  });
});
