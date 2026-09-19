import type {
  LoreActivationCandidate,
  Lorebook,
  LoreEntry,
} from "@narralume/domain";

import type { NarrativeDatabase } from "./database.js";
import { PersistenceNotFoundError } from "./project-repository.js";

export interface LorebookDetail {
  lorebook: Lorebook;
  entries: LoreEntry[];
}

export interface LorebookBindingState {
  targetId: string;
  lorebookIds: string[];
  version: number;
  updatedAt: string;
}

export class SqliteLoreRepository {
  constructor(private readonly database: NarrativeDatabase) {}

  insertLorebook(lorebook: Lorebook): Lorebook {
    const result = this.database.raw
      .prepare(
        `INSERT INTO lorebooks(
           id, project_id, name, description, enabled_globally, scan_turns,
           enabled, created_at, updated_at, version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, name) DO NOTHING`,
      )
      .run(
        lorebook.id,
        lorebook.projectId,
        lorebook.name,
        lorebook.description,
        lorebook.enabledGlobally ? 1 : 0,
        lorebook.scanTurns,
        lorebook.enabled ? 1 : 0,
        lorebook.createdAt,
        lorebook.updatedAt,
        lorebook.version,
      );
    if (result.changes !== 1) {
      throw new LorePersistenceError(
        "lorebook.name.conflict",
        "A Lorebook with this name already exists in the project",
      );
    }
    return this.requireLorebook(lorebook.id);
  }

  getLorebook(id: string): Lorebook | null {
    const row = this.database.raw
      .prepare("SELECT * FROM lorebooks WHERE id = ?")
      .get(id) as LorebookRow | undefined;
    return row ? mapLorebook(row) : null;
  }

  requireLorebook(id: string): Lorebook {
    const lorebook = this.getLorebook(id);
    if (!lorebook) throw new PersistenceNotFoundError("lorebook", id);
    return lorebook;
  }

  listLorebooks(projectId: string): Lorebook[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM lorebooks WHERE project_id = ?
         ORDER BY enabled DESC, enabled_globally DESC, name, id`,
      )
      .all(projectId) as unknown as LorebookRow[];
    return rows.map(mapLorebook);
  }

  requireLorebookDetail(id: string): LorebookDetail {
    return {
      lorebook: this.requireLorebook(id),
      entries: this.listLoreEntries(id),
    };
  }

  updateLorebook(
    id: string,
    input: Pick<
      Lorebook,
      | "name"
      | "description"
      | "enabledGlobally"
      | "scanTurns"
      | "enabled"
      | "updatedAt"
    > & { expectedVersion: number },
  ): Lorebook {
    return this.database.transaction(() => {
      const current = this.requireLorebook(id);
      this.requireVersion(
        current.version,
        input.expectedVersion,
        "lorebook.version.conflict",
      );
      const duplicate = this.database.raw
        .prepare(
          `SELECT 1 AS present FROM lorebooks
           WHERE project_id = ? AND name = ? AND id <> ? LIMIT 1`,
        )
        .get(current.projectId, input.name, id);
      if (duplicate) {
        throw new LorePersistenceError(
          "lorebook.name.conflict",
          "A Lorebook with this name already exists in the project",
        );
      }
      const result = this.database.raw
        .prepare(
          `UPDATE lorebooks SET name = ?, description = ?, enabled_globally = ?,
             scan_turns = ?, enabled = ?, updated_at = ?, version = version + 1
           WHERE id = ? AND version = ?`,
        )
        .run(
          input.name,
          input.description,
          input.enabledGlobally ? 1 : 0,
          input.scanTurns,
          input.enabled ? 1 : 0,
          input.updatedAt,
          id,
          input.expectedVersion,
        );
      if (result.changes !== 1) {
        this.throwVersionConflict("lorebook.version.conflict");
      }
      return this.requireLorebook(id);
    });
  }

  deleteLorebook(id: string, expectedVersion: number): boolean {
    return this.database.transaction(() => {
      const current = this.requireLorebook(id);
      this.requireVersion(
        current.version,
        expectedVersion,
        "lorebook.version.conflict",
      );
      const result = this.database.raw
        .prepare("DELETE FROM lorebooks WHERE id = ? AND version = ?")
        .run(id, expectedVersion);
      if (result.changes !== 1) {
        this.throwVersionConflict("lorebook.version.conflict");
      }
      return true;
    });
  }

  insertLoreEntry(entry: LoreEntry): LoreEntry {
    this.requireLorebook(entry.lorebookId);
    const result = this.database.raw
      .prepare(
        `INSERT INTO lore_entries(
           id, lorebook_id, title, content, keys_json, constant, priority,
           enabled, created_at, updated_at, version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(lorebook_id, title) DO NOTHING`,
      )
      .run(
        entry.id,
        entry.lorebookId,
        entry.title,
        entry.content,
        JSON.stringify(entry.keys),
        entry.constant ? 1 : 0,
        entry.priority,
        entry.enabled ? 1 : 0,
        entry.createdAt,
        entry.updatedAt,
        entry.version,
      );
    if (result.changes !== 1) {
      throw new LorePersistenceError(
        "lore_entry.title.conflict",
        "A Lore entry with this title already exists in the Lorebook",
      );
    }
    return this.requireLoreEntry(entry.id);
  }

  getLoreEntry(id: string): LoreEntry | null {
    const row = this.database.raw
      .prepare("SELECT * FROM lore_entries WHERE id = ?")
      .get(id) as LoreEntryRow | undefined;
    return row ? mapLoreEntry(row) : null;
  }

  requireLoreEntry(id: string): LoreEntry {
    const entry = this.getLoreEntry(id);
    if (!entry) throw new PersistenceNotFoundError("lore-entry", id);
    return entry;
  }

  listLoreEntries(lorebookId: string): LoreEntry[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM lore_entries WHERE lorebook_id = ?
         ORDER BY priority DESC, id`,
      )
      .all(lorebookId) as unknown as LoreEntryRow[];
    return rows.map(mapLoreEntry);
  }

  updateLoreEntry(
    id: string,
    input: Pick<
      LoreEntry,
      | "title"
      | "content"
      | "keys"
      | "constant"
      | "priority"
      | "enabled"
      | "updatedAt"
    > & { expectedVersion: number },
  ): LoreEntry {
    return this.database.transaction(() => {
      const current = this.requireLoreEntry(id);
      this.requireVersion(
        current.version,
        input.expectedVersion,
        "lore_entry.version.conflict",
      );
      const duplicate = this.database.raw
        .prepare(
          `SELECT 1 AS present FROM lore_entries
           WHERE lorebook_id = ? AND title = ? AND id <> ? LIMIT 1`,
        )
        .get(current.lorebookId, input.title, id);
      if (duplicate) {
        throw new LorePersistenceError(
          "lore_entry.title.conflict",
          "A Lore entry with this title already exists in the Lorebook",
        );
      }
      const result = this.database.raw
        .prepare(
          `UPDATE lore_entries SET title = ?, content = ?, keys_json = ?,
             constant = ?, priority = ?, enabled = ?, updated_at = ?,
             version = version + 1 WHERE id = ? AND version = ?`,
        )
        .run(
          input.title,
          input.content,
          JSON.stringify(input.keys),
          input.constant ? 1 : 0,
          input.priority,
          input.enabled ? 1 : 0,
          input.updatedAt,
          id,
          input.expectedVersion,
        );
      if (result.changes !== 1) {
        this.throwVersionConflict("lore_entry.version.conflict");
      }
      return this.requireLoreEntry(id);
    });
  }

  deleteLoreEntry(id: string, expectedVersion: number): boolean {
    return this.database.transaction(() => {
      const current = this.requireLoreEntry(id);
      this.requireVersion(
        current.version,
        expectedVersion,
        "lore_entry.version.conflict",
      );
      const result = this.database.raw
        .prepare("DELETE FROM lore_entries WHERE id = ? AND version = ?")
        .run(id, expectedVersion);
      if (result.changes !== 1) {
        this.throwVersionConflict("lore_entry.version.conflict");
      }
      return true;
    });
  }

  listPersonaLorebooks(personaId: string): Lorebook[] {
    const rows = this.database.raw
      .prepare(
        `SELECT lorebook.* FROM lorebooks lorebook
         JOIN persona_lorebooks binding ON binding.lorebook_id = lorebook.id
         WHERE binding.persona_id = ? ORDER BY lorebook.name, lorebook.id`,
      )
      .all(personaId) as unknown as LorebookRow[];
    return rows.map(mapLorebook);
  }

  listSessionLorebooks(sessionId: string): Lorebook[] {
    const rows = this.database.raw
      .prepare(
        `SELECT lorebook.* FROM lorebooks lorebook
         JOIN cocreate_session_lorebooks binding ON binding.lorebook_id = lorebook.id
         WHERE binding.session_id = ? ORDER BY lorebook.name, lorebook.id`,
      )
      .all(sessionId) as unknown as LorebookRow[];
    return rows.map(mapLorebook);
  }

  replacePersonaLorebooks(
    personaId: string,
    lorebookIds: readonly string[],
    expectedVersion: number,
    updatedAt: string,
  ): LorebookBindingState {
    return this.replaceBindings({
      targetTable: "story_personas",
      targetEntity: "story_persona",
      targetIdColumn: "persona_id",
      bindingTable: "persona_lorebooks",
      targetId: personaId,
      lorebookIds,
      expectedVersion,
      updatedAt,
      conflictCode: "persona.version.conflict",
    });
  }

  replaceSessionLorebooks(
    sessionId: string,
    lorebookIds: readonly string[],
    expectedVersion: number,
    updatedAt: string,
  ): LorebookBindingState {
    return this.replaceBindings({
      targetTable: "cocreate_sessions",
      targetEntity: "cocreate_session",
      targetIdColumn: "session_id",
      bindingTable: "cocreate_session_lorebooks",
      targetId: sessionId,
      lorebookIds,
      expectedVersion,
      updatedAt,
      conflictCode: "cocreate.session.version.conflict",
    });
  }

  listLoreActivationCandidates(
    projectId: string,
    personaId: string,
    sessionId: string,
  ): LoreActivationCandidate[] {
    const persona = this.requireBindingTarget(
      "story_personas",
      "story_persona",
      personaId,
    );
    const session = this.requireBindingTarget(
      "cocreate_sessions",
      "cocreate_session",
      sessionId,
    );
    if (persona.project_id !== projectId || session.project_id !== projectId) {
      throw new LorePersistenceError(
        "lorebook.project.mismatch",
        "The Lorebook activation targets must belong to the same project",
      );
    }

    const personaBookIds = new Set(
      this.listPersonaLorebooks(personaId).map(({ id }) => id),
    );
    const sessionBookIds = new Set(
      this.listSessionLorebooks(sessionId).map(({ id }) => id),
    );
    const candidates: LoreActivationCandidate[] = [];
    for (const lorebook of this.listLorebooks(projectId)) {
      const scopes: Array<Pick<LoreActivationCandidate, "scope" | "scopeId">> =
        [];
      if (lorebook.enabledGlobally) {
        scopes.push({ scope: "project", scopeId: projectId });
      }
      if (personaBookIds.has(lorebook.id)) {
        scopes.push({ scope: "persona", scopeId: personaId });
      }
      if (sessionBookIds.has(lorebook.id)) {
        scopes.push({ scope: "session", scopeId: sessionId });
      }
      for (const entry of this.listLoreEntries(lorebook.id)) {
        for (const scope of scopes) {
          candidates.push({ lorebook, entry, ...scope });
        }
      }
    }
    return candidates;
  }

  private replaceBindings(input: ReplaceBindingsInput): LorebookBindingState {
    return this.database.transaction(() => {
      const target = this.requireBindingTarget(
        input.targetTable,
        input.targetEntity,
        input.targetId,
      );
      this.requireVersion(
        target.version,
        input.expectedVersion,
        input.conflictCode,
      );
      const lorebookIds = [...input.lorebookIds].toSorted(compareStrings);
      if (new Set(lorebookIds).size !== lorebookIds.length) {
        throw new LorePersistenceError(
          "lorebook.binding.duplicate",
          "Lorebook bindings must be unique",
        );
      }
      for (const lorebookId of lorebookIds) {
        const lorebook = this.requireLorebook(lorebookId);
        if (lorebook.projectId !== target.project_id) {
          throw new LorePersistenceError(
            "lorebook.project.mismatch",
            "The Lorebook and binding target must belong to the same project",
          );
        }
      }

      this.database.raw
        .prepare(
          `DELETE FROM ${input.bindingTable} WHERE ${input.targetIdColumn} = ?`,
        )
        .run(input.targetId);
      const insert = this.database.raw.prepare(
        `INSERT INTO ${input.bindingTable}(${input.targetIdColumn}, lorebook_id)
         VALUES (?, ?)`,
      );
      for (const lorebookId of lorebookIds) {
        insert.run(input.targetId, lorebookId);
      }

      const updated = this.database.raw
        .prepare(
          `UPDATE ${input.targetTable} SET updated_at = ?, version = version + 1
           WHERE id = ? AND version = ?`,
        )
        .run(input.updatedAt, input.targetId, input.expectedVersion);
      if (updated.changes !== 1) {
        this.throwVersionConflict(input.conflictCode);
      }
      return {
        targetId: input.targetId,
        lorebookIds,
        version: input.expectedVersion + 1,
        updatedAt: input.updatedAt,
      };
    });
  }

  private requireBindingTarget(
    table: "story_personas" | "cocreate_sessions",
    entity: "story_persona" | "cocreate_session",
    id: string,
  ): BindingTargetRow {
    const row = this.database.raw
      .prepare(
        `SELECT id, project_id, updated_at, version FROM ${table} WHERE id = ?`,
      )
      .get(id) as BindingTargetRow | undefined;
    if (!row) throw new PersistenceNotFoundError(entity, id);
    return row;
  }

  private requireVersion(
    actualVersion: number,
    expectedVersion: number,
    code: string,
  ): void {
    if (actualVersion !== expectedVersion) this.throwVersionConflict(code);
  }

  private throwVersionConflict(code: string): never {
    throw new LorePersistenceError(
      code,
      "The resource was updated elsewhere; refresh and try again",
    );
  }
}

export class LorePersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LorePersistenceError";
  }
}

interface ReplaceBindingsInput {
  targetTable: "story_personas" | "cocreate_sessions";
  targetEntity: "story_persona" | "cocreate_session";
  targetIdColumn: "persona_id" | "session_id";
  bindingTable: "persona_lorebooks" | "cocreate_session_lorebooks";
  targetId: string;
  lorebookIds: readonly string[];
  expectedVersion: number;
  updatedAt: string;
  conflictCode: string;
}

interface BindingTargetRow {
  id: string;
  project_id: string;
  updated_at: string;
  version: number;
}

interface LorebookRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  enabled_globally: number;
  scan_turns: number;
  enabled: number;
  created_at: string;
  updated_at: string;
  version: number;
}

interface LoreEntryRow {
  id: string;
  lorebook_id: string;
  title: string;
  content: string;
  keys_json: string;
  constant: number;
  priority: number;
  enabled: number;
  created_at: string;
  updated_at: string;
  version: number;
}

function mapLorebook(row: LorebookRow): Lorebook {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    enabledGlobally: Boolean(row.enabled_globally),
    scanTurns: row.scan_turns,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function mapLoreEntry(row: LoreEntryRow): LoreEntry {
  return {
    id: row.id,
    lorebookId: row.lorebook_id,
    title: row.title,
    content: row.content,
    keys: JSON.parse(row.keys_json) as string[],
    constant: Boolean(row.constant),
    priority: row.priority,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
