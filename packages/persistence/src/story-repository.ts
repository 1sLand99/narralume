import type { OutlineNode, OutlineStatus } from "@narralume/domain";

import type { NarrativeDatabase } from "./database.js";
import { PersistenceNotFoundError } from "./project-repository.js";
import { totalReferenceCount } from "./reference-inspector.js";

interface OutlineRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  kind: OutlineNode["kind"];
  path: string;
  depth: number;
  ordinal: number;
  title: string;
  summary: string | null;
  goal: string | null;
  conflict: string | null;
  outcome: string | null;
  pov_entity_id: string | null;
  story_time: string | null;
  status: OutlineStatus;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export interface AuthorIntent {
  projectId: string;
  promise: string | null;
  themes: readonly string[];
  audience: string | null;
  tone: string | null;
  boundaries: readonly string[];
  endingDirection: string | null;
  currentFocus: string | null;
  lockedFields: readonly string[];
  updatedAt: string;
}

export class SqliteStoryRepository {
  constructor(private readonly database: NarrativeDatabase) {}

  insertOutlineNode(node: OutlineNode): OutlineNode {
    if (node.parentId) this.requireOutlineNode(node.projectId, node.parentId);
    this.database.raw
      .prepare(
        `
        INSERT INTO outline_nodes(
          id, project_id, parent_id, kind, path, depth, ordinal, title, summary, goal,
          conflict, outcome, pov_entity_id, story_time, status, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        node.id,
        node.projectId,
        node.parentId,
        node.kind,
        node.path,
        node.depth,
        node.ordinal,
        node.title,
        node.summary,
        node.goal,
        node.conflict,
        node.outcome,
        node.povEntityId,
        node.storyTime,
        node.status,
        JSON.stringify(node.metadata),
        node.createdAt,
        node.updatedAt,
      );
    return node;
  }

  getOutlineNode(projectId: string, id: string): OutlineNode | null {
    const row = this.database.raw
      .prepare("SELECT * FROM outline_nodes WHERE project_id = ? AND id = ?")
      .get(projectId, id) as OutlineRow | undefined;
    return row ? mapOutline(row) : null;
  }

  requireOutlineNode(projectId: string, id: string): OutlineNode {
    const node = this.getOutlineNode(projectId, id);
    if (!node) throw new PersistenceNotFoundError("outline_node", id);
    return node;
  }

  listOutline(projectId: string): OutlineNode[] {
    const rows = this.database.raw
      .prepare(
        `
        WITH RECURSIVE tree(id, sort_path) AS (
          SELECT id, printf('%08d', ordinal)
          FROM outline_nodes
          WHERE project_id = ? AND parent_id IS NULL
          UNION ALL
          SELECT child.id, tree.sort_path || '.' || printf('%08d', child.ordinal)
          FROM outline_nodes child
          JOIN tree ON child.parent_id = tree.id
          WHERE child.project_id = ?
        )
        SELECT node.* FROM tree JOIN outline_nodes node ON node.id = tree.id
        ORDER BY tree.sort_path
      `,
      )
      .all(projectId, projectId) as unknown as OutlineRow[];
    return rows.map(mapOutline);
  }

  listOutlineChildren(projectId: string, parentId: string): OutlineNode[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM outline_nodes WHERE project_id = ? AND parent_id = ?
         ORDER BY ordinal, created_at`,
      )
      .all(projectId, parentId) as unknown as OutlineRow[];
    return rows.map(mapOutline);
  }

  updateOutlineDetails(
    projectId: string,
    id: string,
    patch: Partial<
      Pick<
        OutlineNode,
        | "title"
        | "summary"
        | "goal"
        | "conflict"
        | "outcome"
        | "povEntityId"
        | "storyTime"
        | "metadata"
      >
    >,
    updatedAt: string,
  ): OutlineNode {
    const current = this.requireOutlineNode(projectId, id);
    const next = { ...current, ...patch, updatedAt };
    this.database.raw
      .prepare(
        `UPDATE outline_nodes SET title = ?, summary = ?, goal = ?, conflict = ?,
           outcome = ?, pov_entity_id = ?, story_time = ?, metadata_json = ?,
           updated_at = ? WHERE project_id = ? AND id = ?`,
      )
      .run(
        next.title,
        next.summary,
        next.goal,
        next.conflict,
        next.outcome,
        next.povEntityId,
        next.storyTime,
        JSON.stringify(next.metadata),
        updatedAt,
        projectId,
        id,
      );
    return this.requireOutlineNode(projectId, id);
  }

  updateOutlineStatus(
    projectId: string,
    id: string,
    status: OutlineStatus,
    updatedAt: string,
  ): OutlineNode {
    const result = this.database.raw
      .prepare(
        "UPDATE outline_nodes SET status = ?, updated_at = ? WHERE project_id = ? AND id = ?",
      )
      .run(status, updatedAt, projectId, id);
    if (result.changes !== 1)
      throw new PersistenceNotFoundError("outline_node", id);
    return this.requireOutlineNode(projectId, id);
  }

  updateOutlineOrdinal(
    projectId: string,
    id: string,
    ordinal: number,
    updatedAt: string,
  ): void {
    const result = this.database.raw
      .prepare(
        "UPDATE outline_nodes SET ordinal = ?, updated_at = ? WHERE project_id = ? AND id = ?",
      )
      .run(ordinal, updatedAt, projectId, id);
    if (result.changes !== 1)
      throw new PersistenceNotFoundError("outline_node", id);
  }

  updateOutlinePlacement(
    projectId: string,
    node: Pick<OutlineNode, "id" | "parentId" | "ordinal" | "path" | "depth">,
    updatedAt: string,
  ): void {
    const result = this.database.raw
      .prepare(
        "UPDATE outline_nodes SET parent_id = ?, ordinal = ?, path = ?, depth = ?, updated_at = ? WHERE project_id = ? AND id = ?",
      )
      .run(
        node.parentId,
        node.ordinal,
        node.path,
        node.depth,
        updatedAt,
        projectId,
        node.id,
      );
    if (result.changes !== 1)
      throw new PersistenceNotFoundError("outline_node", node.id);
  }

  countOutlineReferences(id: string): number {
    const compassReferences = this.database.raw
      .prepare(
        `
      SELECT COUNT(*) AS count FROM story_compasses compass, json_each(compass.long_lines_json) line
      WHERE json_extract(line.value, '$.development.scopeNodeId') = ?
        OR EXISTS (SELECT 1 FROM json_each(line.value, '$.development.evidenceChapterIds') evidence WHERE evidence.value = ?)
    `,
      )
      .get(id, id) as { count: number };
    return (
      totalReferenceCount(this.database, "outline_nodes", id) +
      compassReferences.count
    );
  }

  deleteOutlineNode(projectId: string, id: string): boolean {
    return (
      this.database.raw
        .prepare("DELETE FROM outline_nodes WHERE project_id = ? AND id = ?")
        .run(projectId, id).changes === 1
    );
  }

  upsertAuthorIntent(intent: AuthorIntent): AuthorIntent {
    this.database.raw
      .prepare(
        `
        INSERT INTO author_intents(
          project_id, promise, themes_json, audience, tone, boundaries_json,
          ending_direction, current_focus, locked_fields_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          promise = excluded.promise,
          themes_json = excluded.themes_json,
          audience = excluded.audience,
          tone = excluded.tone,
          boundaries_json = excluded.boundaries_json,
          ending_direction = excluded.ending_direction,
          current_focus = excluded.current_focus,
          locked_fields_json = excluded.locked_fields_json,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        intent.projectId,
        intent.promise,
        JSON.stringify(intent.themes),
        intent.audience,
        intent.tone,
        JSON.stringify(intent.boundaries),
        intent.endingDirection,
        intent.currentFocus,
        JSON.stringify(intent.lockedFields),
        intent.updatedAt,
      );
    return intent;
  }

  getAuthorIntent(projectId: string): AuthorIntent | null {
    const row = this.database.raw
      .prepare("SELECT * FROM author_intents WHERE project_id = ?")
      .get(projectId) as
      | {
          project_id: string;
          promise: string | null;
          themes_json: string;
          audience: string | null;
          tone: string | null;
          boundaries_json: string;
          ending_direction: string | null;
          current_focus: string | null;
          locked_fields_json: string;
          updated_at: string;
        }
      | undefined;
    return row
      ? {
          projectId: row.project_id,
          promise: row.promise,
          themes: parseStringArray(row.themes_json),
          audience: row.audience,
          tone: row.tone,
          boundaries: parseStringArray(row.boundaries_json),
          endingDirection: row.ending_direction,
          currentFocus: row.current_focus,
          lockedFields: parseStringArray(row.locked_fields_json),
          updatedAt: row.updated_at,
        }
      : null;
  }
}

function mapOutline(row: OutlineRow): OutlineNode {
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    kind: row.kind,
    path: row.path,
    depth: row.depth,
    ordinal: row.ordinal,
    title: row.title,
    summary: row.summary,
    goal: row.goal,
    conflict: row.conflict,
    outcome: row.outcome,
    povEntityId: row.pov_entity_id,
    storyTime: row.story_time,
    status: row.status,
    metadata: parseObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
