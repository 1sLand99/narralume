import {
  sha256Hex,
  type OutlineNode,
  type RunSnapshot,
} from "@narralume/domain";
import {
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";

/** Workflow status changes are not structural changes; abandonment is. */
export function outlineStructureFingerprint(
  outline: readonly OutlineNode[],
): string {
  return sha256Hex(
    JSON.stringify(
      outline
        .map((node) => ({
          id: node.id,
          parentId: node.parentId,
          kind: node.kind,
          ordinal: node.ordinal,
          abandoned: node.status === "abandoned",
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ),
  );
}

export function chapterOutlineIsCurrent(
  database: NarrativeDatabase,
  snapshot: RunSnapshot,
): boolean {
  const context = snapshot.steps.find(
    (step) => step.kind === "context.compile" && step.status === "succeeded",
  );
  if (!context) return true; // No materialized chapter context to invalidate yet.
  return (
    context.outputArtifact?.outlineStructureFingerprint ===
    outlineStructureFingerprint(
      new SqliteStoryRepository(database).listOutline(snapshot.run.projectId),
    )
  );
}

export function requireCurrentChapterOutline(
  database: NarrativeDatabase,
  snapshot: RunSnapshot,
): void {
  if (!chapterOutlineIsCurrent(database, snapshot)) {
    throw new OutlineContextError();
  }
}

class OutlineContextError extends Error {
  readonly code = "outline.context.stale";
  readonly retryable = false;
  readonly statusCode = 409;
  // Harness errors are persisted as JSON; the message must be enumerable.
  override readonly message =
    "The outline structure changed; regenerate the chapter using the current order";
}
