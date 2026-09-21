import type { CanonAuthority, CanonEntity, CanonFact } from "@narralume/domain";

import type { NarrativeDatabase } from "./database.js";
import { PersistenceNotFoundError } from "./project-repository.js";
import { totalReferenceCount } from "./reference-inspector.js";

interface EntityRow {
  id: string;
  project_id: string;
  type: CanonEntity["type"];
  name: string;
  aliases_json: string;
  description: string | null;
  attributes_json: string;
  status: CanonEntity["status"];
  created_at: string;
  updated_at: string;
}

interface FactRow {
  id: string;
  project_id: string;
  subject_id: string;
  predicate: string;
  object_entity_id: string | null;
  value_json: string | null;
  valid_from_node_id: string | null;
  valid_to_node_id: string | null;
  knowledge_scope: CanonFact["knowledgeScope"];
  knowledge_subject_id: string | null;
  authority: CanonAuthority;
  confidence: number;
  source_type: string;
  source_id: string | null;
  supersedes_fact_id: string | null;
  created_at: string;
}

export interface CanonFactConflict {
  fact: CanonFact;
  reason: "different_object" | "different_value";
}

export interface CanonFactWithdrawal {
  factId: string;
  projectId: string;
  reason: string;
  withdrawnAt: string;
}

export class SqliteCanonRepository {
  constructor(private readonly database: NarrativeDatabase) {}

  insertEntity(entity: CanonEntity): CanonEntity {
    this.database.raw
      .prepare(
        `
        INSERT INTO canon_entities(
          id, project_id, type, name, aliases_json, description, attributes_json,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        entity.id,
        entity.projectId,
        entity.type,
        entity.name,
        JSON.stringify(entity.aliases),
        entity.description,
        JSON.stringify(entity.attributes),
        entity.status,
        entity.createdAt,
        entity.updatedAt,
      );
    return entity;
  }

  updateEntity(entity: CanonEntity): CanonEntity {
    const result = this.database.raw
      .prepare(
        `
        UPDATE canon_entities SET name = ?, aliases_json = ?, description = ?,
          attributes_json = ?, status = ?, updated_at = ?
        WHERE project_id = ? AND id = ?
      `,
      )
      .run(
        entity.name,
        JSON.stringify(entity.aliases),
        entity.description,
        JSON.stringify(entity.attributes),
        entity.status,
        entity.updatedAt,
        entity.projectId,
        entity.id,
      );
    if (result.changes !== 1)
      throw new PersistenceNotFoundError("canon_entity", entity.id);
    return entity;
  }

  countEntityReferences(id: string): number {
    const planned = this.database.raw
      .prepare(
        `
      SELECT count(*) AS count FROM outline_nodes, json_each(outline_nodes.metadata_json, '$.plannedEntityIds') AS ref WHERE ref.value = ?
    `,
      )
      .get(id) as { count: number };
    return (
      totalReferenceCount(this.database, "canon_entities", id) + planned.count
    );
  }

  deleteEntity(projectId: string, id: string): boolean {
    return (
      this.database.raw
        .prepare("DELETE FROM canon_entities WHERE project_id = ? AND id = ?")
        .run(projectId, id).changes === 1
    );
  }

  getEntity(projectId: string, id: string): CanonEntity | null {
    const row = this.database.raw
      .prepare("SELECT * FROM canon_entities WHERE project_id = ? AND id = ?")
      .get(projectId, id) as EntityRow | undefined;
    return row ? mapEntity(row) : null;
  }

  requireEntity(projectId: string, id: string): CanonEntity {
    const entity = this.getEntity(projectId, id);
    if (!entity) throw new PersistenceNotFoundError("canon_entity", id);
    return entity;
  }

  listEntities(
    projectId: string,
    options: { type?: CanonEntity["type"]; includeRetired?: boolean } = {},
  ): CanonEntity[] {
    const where = ["project_id = ?"];
    const parameters: (string | number)[] = [projectId];
    if (options.type) {
      where.push("type = ?");
      parameters.push(options.type);
    }
    if (!options.includeRetired) where.push("status = 'active'");
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM canon_entities WHERE ${where.join(" AND ")} ORDER BY type, name`,
      )
      .all(...parameters) as unknown as EntityRow[];
    return rows.map(mapEntity);
  }

  searchEntities(projectId: string, query: string, limit = 20): CanonEntity[] {
    const normalized = query.trim();
    if (!normalized) return [];
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const rows =
      normalized.length >= 3
        ? (this.database.raw
            .prepare(
              `
            SELECT entity.*
            FROM canon_entities_fts fts
            JOIN canon_entities entity ON entity.rowid = fts.rowid
            WHERE canon_entities_fts MATCH ? AND entity.project_id = ?
            ORDER BY bm25(canon_entities_fts), entity.name
            LIMIT ?
          `,
            )
            .all(
              ftsPhrase(normalized),
              projectId,
              boundedLimit,
            ) as unknown as EntityRow[])
        : (this.database.raw
            .prepare(
              `
            SELECT * FROM canon_entities
            WHERE project_id = ? AND (name LIKE ? OR aliases_json LIKE ?)
            ORDER BY name LIMIT ?
          `,
            )
            .all(
              projectId,
              `%${escapeLike(normalized)}%`,
              `%${escapeLike(normalized)}%`,
              boundedLimit,
            ) as unknown as EntityRow[]);
    return rows.map(mapEntity);
  }

  insertFact(fact: CanonFact): CanonFact {
    this.requireEntity(fact.projectId, fact.subjectId);
    if (fact.objectEntityId)
      this.requireEntity(fact.projectId, fact.objectEntityId);
    if (fact.knowledgeSubjectId)
      this.requireEntity(fact.projectId, fact.knowledgeSubjectId);
    if (fact.validFromNodeId)
      this.requireProjectReference(
        "outline_nodes",
        fact.projectId,
        fact.validFromNodeId,
        "outline_node",
      );
    if (fact.validToNodeId)
      this.requireProjectReference(
        "outline_nodes",
        fact.projectId,
        fact.validToNodeId,
        "outline_node",
      );
    if (fact.supersedesFactId)
      this.requireProjectReference(
        "canon_facts",
        fact.projectId,
        fact.supersedesFactId,
        "canon_fact",
      );
    this.database.raw
      .prepare(
        `
        INSERT INTO canon_facts(
          id, project_id, subject_id, predicate, object_entity_id, value_json,
          valid_from_node_id, valid_to_node_id, knowledge_scope, knowledge_subject_id,
          authority, confidence, source_type, source_id, supersedes_fact_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        fact.id,
        fact.projectId,
        fact.subjectId,
        fact.predicate,
        fact.objectEntityId,
        fact.objectEntityId ? null : JSON.stringify(fact.value),
        fact.validFromNodeId,
        fact.validToNodeId,
        fact.knowledgeScope,
        fact.knowledgeSubjectId,
        fact.authority,
        fact.confidence,
        fact.sourceType,
        fact.sourceId,
        fact.supersedesFactId,
        fact.createdAt,
      );
    return fact;
  }

  getFact(projectId: string, id: string): CanonFact | null {
    const row = this.database.raw
      .prepare("SELECT * FROM canon_facts WHERE project_id = ? AND id = ?")
      .get(projectId, id) as FactRow | undefined;
    return row ? mapFact(row) : null;
  }

  requireFact(projectId: string, id: string): CanonFact {
    const fact = this.getFact(projectId, id);
    if (!fact) throw new PersistenceNotFoundError("canon_fact", id);
    return fact;
  }

  listEffectiveFacts(
    projectId: string,
    options: { subjectId?: string; includeCandidates?: boolean } = {},
  ): CanonFact[] {
    const where = [
      "fact.project_id = ?",
      "NOT EXISTS (SELECT 1 FROM canon_facts newer WHERE newer.supersedes_fact_id = fact.id)",
      "NOT EXISTS (SELECT 1 FROM canon_fact_withdrawals withdrawal WHERE withdrawal.fact_id = fact.id)",
    ];
    const parameters: string[] = [projectId];
    if (options.subjectId) {
      where.push("fact.subject_id = ?");
      parameters.push(options.subjectId);
    }
    if (!options.includeCandidates) where.push("fact.authority != 'candidate'");
    const rows = this.database.raw
      .prepare(
        `SELECT fact.* FROM canon_facts fact WHERE ${where.join(" AND ")} ORDER BY fact.created_at`,
      )
      .all(...parameters) as unknown as FactRow[];
    return rows.map(mapFact);
  }

  listFactHistory(
    projectId: string,
    options: { subjectId?: string; includeCandidates?: boolean } = {},
  ): CanonFact[] {
    const where = [
      "fact.project_id = ?",
      "NOT EXISTS (SELECT 1 FROM canon_fact_withdrawals withdrawal WHERE withdrawal.fact_id = fact.id)",
    ];
    const parameters: string[] = [projectId];
    if (options.subjectId) {
      where.push("fact.subject_id = ?");
      parameters.push(options.subjectId);
    }
    if (!options.includeCandidates) where.push("fact.authority != 'candidate'");
    const rows = this.database.raw
      .prepare(
        `SELECT fact.* FROM canon_facts fact WHERE ${where.join(" AND ")} ORDER BY fact.created_at, fact.id`,
      )
      .all(...parameters) as unknown as FactRow[];
    return rows.map(mapFact);
  }

  withdrawFact(input: CanonFactWithdrawal): CanonFactWithdrawal {
    this.requireFact(input.projectId, input.factId);
    this.database.raw
      .prepare(
        `INSERT INTO canon_fact_withdrawals(fact_id, project_id, reason, withdrawn_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.factId, input.projectId, input.reason, input.withdrawnAt);
    return input;
  }

  promoteFact(
    projectId: string,
    candidateId: string,
    newId: string,
    authority: Exclude<CanonAuthority, "candidate">,
    now: string,
  ): CanonFact {
    return this.database.transaction(() => {
      const candidate = this.getFact(projectId, candidateId);
      if (!candidate)
        throw new PersistenceNotFoundError("canon_fact", candidateId);
      const promoted: CanonFact = {
        ...candidate,
        id: newId,
        authority,
        confidence: Math.max(
          candidate.confidence,
          authority === "inferred" ? 0.75 : 1,
        ),
        supersedesFactId: candidate.id,
        createdAt: now,
      };
      return this.insertFact(promoted);
    });
  }

  findConflicts(fact: CanonFact): CanonFactConflict[] {
    return this.listEffectiveFacts(fact.projectId, {
      subjectId: fact.subjectId,
      includeCandidates: false,
    })
      .filter(
        (existing) =>
          existing.predicate === fact.predicate && existing.id !== fact.id,
      )
      .flatMap((existing): CanonFactConflict[] => {
        if (fact.objectEntityId || existing.objectEntityId) {
          return fact.objectEntityId !== existing.objectEntityId
            ? [{ fact: existing, reason: "different_object" }]
            : [];
        }
        return stableJson(fact.value) !== stableJson(existing.value)
          ? [{ fact: existing, reason: "different_value" }]
          : [];
      });
  }

  private requireProjectReference(
    table: "outline_nodes" | "canon_facts",
    projectId: string,
    id: string,
    entity: string,
  ): void {
    const found = this.database.raw
      .prepare(`SELECT id FROM ${table} WHERE project_id = ? AND id = ?`)
      .get(projectId, id);
    if (!found) throw new PersistenceNotFoundError(entity, id);
  }
}

function mapEntity(row: EntityRow): CanonEntity {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    name: row.name,
    aliases: parseStringArray(row.aliases_json),
    description: row.description,
    attributes: parseObject(row.attributes_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFact(row: FactRow): CanonFact {
  return {
    id: row.id,
    projectId: row.project_id,
    subjectId: row.subject_id,
    predicate: row.predicate,
    objectEntityId: row.object_entity_id,
    value:
      row.value_json === null ? null : (JSON.parse(row.value_json) as unknown),
    validFromNodeId: row.valid_from_node_id,
    validToNodeId: row.valid_to_node_id,
    knowledgeScope: row.knowledge_scope,
    knowledgeSubjectId: row.knowledge_subject_id,
    authority: row.authority,
    confidence: row.confidence,
    sourceType: row.source_type,
    sourceId: row.source_id,
    supersedesFactId: row.supersedes_fact_id,
    createdAt: row.created_at,
  };
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function ftsPhrase(query: string): string {
  return `"${query.replaceAll('"', '""')}"`;
}

function escapeLike(query: string): string {
  return query.replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}
