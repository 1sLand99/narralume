import type { OutlineNode } from "./story.js";

/** Shared by the structure editor and its server-side validation. */
export function movablePlannedChapterIds(
  outline: readonly OutlineNode[],
  occupiedNodeIds: readonly string[],
): Set<string> {
  const byId = new Map(outline.map((node) => [node.id, node]));
  const protectedIds = new Set<string>();
  for (const id of [
    ...occupiedNodeIds,
    ...outline
      .filter((node) => !["planned", "abandoned"].includes(node.status))
      .map((node) => node.id),
  ]) {
    let node = byId.get(id);
    while (node && !protectedIds.has(node.id)) {
      protectedIds.add(node.id);
      node = node.parentId ? byId.get(node.parentId) : undefined;
    }
  }
  return new Set(
    outline
      .filter((node) => {
        if (
          node.kind !== "chapter" ||
          node.status !== "planned" ||
          protectedIds.has(node.id)
        )
          return false;
        let parent = node.parentId ? byId.get(node.parentId) : undefined;
        while (parent) {
          if (parent.status === "abandoned") return false;
          parent = parent.parentId ? byId.get(parent.parentId) : undefined;
        }
        return true;
      })
      .map((node) => node.id),
  );
}

/** A container spans its chapters; a scene or beat belongs to one chapter. */
export function outlineChapterSpan(
  outline: readonly OutlineNode[],
  nodeId: string | null,
): [number, number] | null {
  const node = outline.find((item) => item.id === nodeId);
  if (!node || node.status === "abandoned") return null;
  const indices = outline
    .filter((item) => item.kind === "chapter" && item.status !== "abandoned")
    .flatMap((chapter, index) =>
      chapter.id === node.id ||
      chapter.path.startsWith(`${node.path}/`) ||
      node.path.startsWith(`${chapter.path}/`)
        ? [index]
        : [],
    );
  return indices.length ? [indices[0]!, indices.at(-1)!] : null;
}
