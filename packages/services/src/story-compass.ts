import type { OutlineNode, StoryLongLine } from "@narralume/domain";

import { ServiceError } from "./service-error.js";

/** Author progress can refer to written chapters, never to future plans as evidence. */
export function validateLongLineReferences(
  outline: readonly OutlineNode[],
  lines: readonly StoryLongLine[],
): void {
  const nodes = new Map(outline.map((node) => [node.id, node]));
  const isActive = (node: OutlineNode): boolean => {
    let current: OutlineNode | undefined = node;
    while (current) {
      if (current.status === "abandoned") return false;
      current = current.parentId ? nodes.get(current.parentId) : undefined;
    }
    return true;
  };
  for (const line of lines) {
    const development = line.development;
    if (!development) continue;
    if (development.scopeNodeId) {
      const scope = nodes.get(development.scopeNodeId);
      if (
        !scope ||
        !["volume", "arc"].includes(scope.kind) ||
        !isActive(scope)
      ) {
        throw new ServiceError(
          "compass.scope.invalid",
          "A story line stage must reference an active volume or arc in this project",
          409,
        );
      }
    }
    for (const id of development.evidenceChapterIds) {
      const chapter = nodes.get(id);
      if (
        !chapter ||
        chapter.kind !== "chapter" ||
        chapter.status !== "committed" ||
        !isActive(chapter)
      ) {
        throw new ServiceError(
          "compass.evidence.invalid",
          "Story line evidence must reference committed chapters in this project",
          409,
        );
      }
    }
  }
}
