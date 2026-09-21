import type {
  OutlineChangeRequest,
  OutlineChangePreview,
} from "@narralume/contracts";
import {
  createOutlineNode,
  movablePlannedChapterIds,
  outlineChapterSpan,
  sha256Hex,
  type OutlineNode,
} from "@narralume/domain";
import {
  SqliteCanonRepository,
  SqliteDocumentRepository,
  SqliteNarrativeStateRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";
import { StoryServiceError } from "./story-service.js";

export function previewOutlineChange(
  database: NarrativeDatabase,
  projectId: string,
  change: OutlineChangeRequest,
): OutlineChangePreview {
  return database.transaction(
    () => prepareChange(database, projectId, change).preview,
  );
}

export function applyOutlineChange(
  database: NarrativeDatabase,
  projectId: string,
  change: OutlineChangeRequest,
  previewFingerprint: string,
): OutlineNode[] {
  return database.transaction(() => {
    const { before, after, preview } = prepareChange(
      database,
      projectId,
      change,
    );
    if (preview.fingerprint !== previewFingerprint) {
      throw new StoryServiceError(
        "outline.preview.stale",
        "The outline change or its impact changed; preview again before saving",
        409,
      );
    }
    const byId = new Map(before.map((node) => [node.id, node]));
    const changed = after.filter((node) => {
      const old = byId.get(node.id)!;
      return (
        node.parentId !== old.parentId ||
        node.ordinal !== old.ordinal ||
        node.path !== old.path ||
        node.depth !== old.depth
      );
    });
    if (!changed.length) return before;
    const now = new Date(
      Math.max(
        Date.now(),
        ...before.map((node) => Date.parse(node.updatedAt) + 1),
      ),
    ).toISOString();
    const story = new SqliteStoryRepository(database);
    // Reserve unused ordinals to avoid immediate sibling UNIQUE checks. Paths
    // and all descendants are then written in the same transaction.
    const temporaryStart = Math.max(...before.map((node) => node.ordinal)) + 1;
    changed
      .filter(
        (node) =>
          node.parentId !== byId.get(node.id)!.parentId ||
          node.ordinal !== byId.get(node.id)!.ordinal,
      )
      .forEach((node, index) =>
        story.updateOutlineOrdinal(
          projectId,
          node.id,
          temporaryStart + index,
          now,
        ),
      );
    changed.forEach((node) =>
      story.updateOutlinePlacement(projectId, node, now),
    );
    return story.listOutline(projectId);
  });
}

function prepareChange(
  database: NarrativeDatabase,
  projectId: string,
  change: OutlineChangeRequest,
) {
  const story = new SqliteStoryRepository(database);
  const before = story.listOutline(projectId);
  const documents = new SqliteDocumentRepository(database).list(
    projectId,
    undefined,
    true,
  );
  const occupied = documents.flatMap((document) =>
    document.outlineNodeId ? [document.outlineNodeId] : [],
  );
  const movable = movablePlannedChapterIds(before, occupied);
  const after = proposedOutline(story, projectId, before, movable, change);
  const oldChapters = before.filter(
    (node) => node.kind === "chapter" && node.status !== "abandoned",
  );
  const newChapters = after.filter(
    (node) => node.kind === "chapter" && node.status !== "abandoned",
  );
  const newIndices = new Map(
    newChapters.map((node, index) => [node.id, index]),
  );
  // Moving an unwritten chapter must not change its position relative to
  // established or currently produced chapters, even across containers.
  const beforePositions = new Map(
    before.map((node, index) => [node.id, index]),
  );
  const afterPositions = new Map(after.map((node, index) => [node.id, index]));
  const occupiedIds = new Set(occupied);
  const fixedNodes = before.filter(
    (node) =>
      node.status !== "abandoned" &&
      ((node.kind === "chapter" && !movable.has(node.id)) ||
        (["scene", "beat"].includes(node.kind) &&
          (node.status !== "planned" || occupiedIds.has(node.id)))),
  );
  for (const fixed of fixedNodes) {
    const oldIndex = beforePositions.get(fixed.id)!;
    const newIndex = afterPositions.get(fixed.id)!;
    if (
      oldChapters.some((node) => {
        const wasBefore = beforePositions.get(node.id)! < oldIndex;
        const willBeBefore = afterPositions.get(node.id)! < newIndex;
        return wasBefore !== willBeBefore;
      })
    )
      protectedMove();
  }
  const changedChapters = oldChapters.flatMap((node, index) => {
    const nextIndex = newIndices.get(node.id)!;
    const next = newChapters[nextIndex]!;
    return index === nextIndex && node.parentId === next.parentId
      ? []
      : [
          {
            id: node.id,
            title: node.title,
            fromParentId: node.parentId!,
            toParentId: next.parentId!,
            fromPosition: index + 1,
            toPosition: nextIndex + 1,
          },
        ];
  });
  const state = new SqliteNarrativeStateRepository(
    database,
    new SqliteCanonRepository(database),
    story,
  );
  const foreshadows = state.listForeshadows(projectId);
  const foreshadowWindows = foreshadows
    .filter((clue) => !["resolved", "abandoned"].includes(clue.status))
    .flatMap((clue) => {
      const oldWindow = windowChapters(
        before,
        clue.targetFromNodeId,
        clue.targetToNodeId,
      );
      const newWindow = windowChapters(
        after,
        clue.targetFromNodeId,
        clue.targetToNodeId,
      );
      if (JSON.stringify(oldWindow) === JSON.stringify(newWindow)) return [];
      return [
        {
          id: clue.id,
          title: clue.title,
          fromNodeId: clue.targetFromNodeId,
          toNodeId: clue.targetToNodeId,
          beforeChapterIds: oldWindow.ids,
          afterChapterIds: newWindow.ids,
          inverted: newWindow.inverted,
        },
      ];
    });
  const runs = new SqliteRunRepository(database);
  const affected = changedChapters.length
    ? runs.listActiveRuns(projectId).flatMap((run) => {
        const steps = runs.getSnapshot(run.id).steps;
        const context = steps.find(
          (step) =>
            ["context.compile", "outline.generate"].includes(step.kind) &&
            ["running", "succeeded"].includes(step.status),
        );
        return context
          ? [
              {
                id: run.id,
                outlineNodeId: run.targetOutlineNodeId,
                reason:
                  context.kind === "context.compile"
                    ? ("chapter_context" as const)
                    : ("rolling_plan" as const),
                status: run.status,
                contextStatus: context.status,
              },
            ]
          : [];
      })
    : [];
  const fingerprint = sha256Hex(
    JSON.stringify({
      change,
      before,
      occupied: [...occupied].sort(),
      foreshadows,
      affected,
    }),
  );
  const preview: OutlineChangePreview = {
    fingerprint,
    changedChapters,
    affectedRuns: affected.map(({ id, outlineNodeId, reason }) => ({
      id,
      outlineNodeId,
      reason,
    })),
    foreshadowWindows,
  };
  return { before, after, preview };
}

function proposedOutline(
  story: SqliteStoryRepository,
  projectId: string,
  outline: readonly OutlineNode[],
  movable: ReadonlySet<string>,
  change: OutlineChangeRequest,
): OutlineNode[] {
  const proposed = new Map(outline.map((node) => [node.id, { ...node }]));
  const parent = story.requireOutlineNode(projectId, change.parentId);
  const siblings = outline.filter((node) => node.parentId === parent.id);
  if (change.kind === "reorder") {
    const byId = new Map(siblings.map((node) => [node.id, node]));
    if (
      change.nodes.length !== siblings.length ||
      new Set(change.nodes.map((node) => node.id)).size !== siblings.length ||
      change.nodes.some((node) => !byId.has(node.id))
    ) {
      throw new StoryServiceError(
        "outline.reorder.invalid",
        "The order must contain every child of the selected parent exactly once",
        409,
      );
    }
    if (
      change.nodes.some(
        (node) => byId.get(node.id)!.updatedAt !== node.expectedUpdatedAt,
      )
    )
      versionConflict();
    change.nodes.forEach((node, index) => {
      const oldIndex = siblings.findIndex((item) => item.id === node.id);
      if (
        oldIndex !== index &&
        siblings
          .slice(Math.min(index, oldIndex), Math.max(index, oldIndex) + 1)
          .some((item) => !movable.has(item.id))
      )
        protectedMove();
      proposed.get(node.id)!.ordinal = siblings[index]!.ordinal;
    });
  } else {
    const node = story.requireOutlineNode(projectId, change.nodeId);
    if (
      node.updatedAt !== change.expectedUpdatedAt ||
      parent.updatedAt !== change.expectedParentUpdatedAt
    )
      versionConflict();
    if (!movable.has(node.id)) protectedMove();
    if (
      node.parentId === parent.id ||
      !["book", "volume", "arc"].includes(parent.kind)
    ) {
      throw new StoryServiceError(
        "outline.move.target_invalid",
        "Select a different book, volume or arc in this project",
        409,
      );
    }
    let ancestor: OutlineNode | undefined = parent;
    while (ancestor) {
      if (ancestor.status === "abandoned" || ancestor.id === node.id)
        throw new StoryServiceError(
          "outline.move.target_invalid",
          "The destination is unavailable or belongs to the moved subtree",
          409,
        );
      ancestor = ancestor.parentId
        ? proposed.get(ancestor.parentId)
        : undefined;
    }
    const insertion =
      change.beforeNodeId === null
        ? siblings.length
        : siblings.findIndex((item) => item.id === change.beforeNodeId);
    if (insertion < 0)
      throw new StoryServiceError(
        "outline.move.target_invalid",
        "The insertion point is not a child of the destination",
        409,
      );
    const placement = createOutlineNode({
      ...node,
      parent,
      ordinal: insertion,
      now: node.updatedAt,
    });
    outline
      .filter((item) => item.parentId === node.parentId && item.id !== node.id)
      .forEach((item, index) => {
        proposed.get(item.id)!.ordinal = index;
      });
    const targetOrder = [...siblings];
    targetOrder.splice(insertion, 0, node);
    targetOrder.forEach((item, index) => {
      proposed.get(item.id)!.ordinal = index;
    });
    for (const item of outline) {
      if (item.id === node.id)
        proposed.set(item.id, {
          ...node,
          parentId: parent.id,
          ordinal: insertion,
          path: placement.path,
          depth: placement.depth,
        });
      else if (item.path.startsWith(`${node.path}/`))
        proposed.set(item.id, {
          ...item,
          path: placement.path + item.path.slice(node.path.length),
          depth: item.depth + placement.depth - node.depth,
        });
    }
  }
  return orderedOutline([...proposed.values()]);
}

function orderedOutline(outline: readonly OutlineNode[]): OutlineNode[] {
  const children = new Map<string | null, OutlineNode[]>();
  for (const node of outline) {
    const group = children.get(node.parentId) ?? [];
    group.push(node);
    children.set(node.parentId, group);
  }
  const visit = (parentId: string | null): OutlineNode[] =>
    (children.get(parentId) ?? [])
      .sort((a, b) => a.ordinal - b.ordinal)
      .flatMap((node) => [node, ...visit(node.id)]);
  return visit(null);
}

function windowChapters(
  outline: readonly OutlineNode[],
  fromId: string | null,
  toId: string | null,
) {
  const chapters = outline.filter(
    (node) => node.kind === "chapter" && node.status !== "abandoned",
  );
  const from = outlineChapterSpan(outline, fromId),
    to = outlineChapterSpan(outline, toId);
  if ((!fromId && !toId) || (fromId && !from) || (toId && !to))
    return { ids: [] as string[], inverted: false };
  const start = from?.[0] ?? 0,
    end = to?.[1] ?? chapters.length - 1;
  return {
    ids:
      start > end ? [] : chapters.slice(start, end + 1).map((node) => node.id),
    inverted: start > end,
  };
}

function protectedMove(): never {
  throw new StoryServiceError(
    "outline.reorder.protected",
    "Only unwritten planned chapters can move, without crossing protected chapters or outline nodes",
    409,
  );
}
function versionConflict(): never {
  throw new StoryServiceError(
    "outline.version.conflict",
    "The outline changed; refresh before moving chapters",
    409,
  );
}
