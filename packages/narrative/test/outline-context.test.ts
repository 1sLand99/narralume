import { ContextCompiler } from "@narralume/context";
import type { NarrativeSummary, OutlineNode } from "@narralume/domain";
import { describe, expect, it } from "vitest";

import { outlineContextSources } from "../src/outline-context.js";

const now = "2026-08-10T00:00:00.000Z";

describe("outlineContextSources", () => {
  it("preserves manuscript order across double-digit chapters and reordered volumes with opaque IDs", () => {
    const book = node("book", "book", 0, "/book", 0, null);
    const first = node("z-volume", "volume", 0, "/book/z-volume", 1, "book");
    const second = node("a-volume", "volume", 1, "/book/a-volume", 1, "book");
    const chapters = Array.from({ length: 12 }, (_, index) =>
      node(
        `chapter-${index + 1}`,
        "chapter",
        index,
        `${first.path}/chapter-${index + 1}`,
        2,
        first.id,
      ),
    );
    const next = node(
      "random-next",
      "chapter",
      0,
      `${second.path}/random-next`,
      2,
      second.id,
    );
    const near = (outline: OutlineNode[], target: string) =>
      outlineContextSources({
        projectId: "p1",
        outline,
        targetOutlineNodeId: target,
        nearBefore: 1,
        nearAfter: 1,
      }).find((source) => source.id === "outline:near")!.content;
    const original = [book, first, ...chapters, second, next];
    expect(near(original, "chapter-2")).toContain("[node:chapter-1]");
    expect(near(original, "chapter-2")).not.toContain("[node:chapter-12]");
    expect(near(original, "chapter-12")).toContain("[node:random-next]");
    expect(
      near([book, second, next, first, ...chapters], "chapter-1"),
    ).toContain("[node:random-next]");
    chapters[1]!.status = "abandoned";
    expect(near(original, "chapter-3")).toContain("[node:chapter-1]");
    expect(near(original, "chapter-3")).not.toContain("[node:chapter-2]");
  });

  it("keeps a 200-chapter outline independently budgetable around the target", () => {
    const book = node("book", "book", 0, "/book", 0, null);
    const chapters = Array.from({ length: 200 }, (_, index) =>
      node(
        `chapter-${index + 1}`,
        "chapter",
        index,
        `/book/chapter-${index + 1}`,
        1,
        "book",
      ),
    );
    const summaries: NarrativeSummary[] = chapters.map((chapter, index) => ({
      id: `summary-${index + 1}`,
      projectId: "p1",
      scopeType: "chapter",
      scopeId: chapter.id,
      summary: `Committed consequence ${index + 1}`,
      stateDelta: {},
      sourceHash: `hash-${index + 1}`,
      createdAt: now,
    }));
    const sources = outlineContextSources({
      projectId: "p1",
      outline: [book, ...chapters],
      chapterSummaries: summaries,
      targetOutlineNodeId: "chapter-150",
      nearBefore: 5,
      nearAfter: 3,
      farChunkSize: 40,
    });
    expect(
      sources.find((source) => source.id === "outline:near")?.content,
    ).toContain("Chapter 150");
    expect(
      sources.filter((source) => source.id.startsWith("outline:far:")),
    ).toHaveLength(5);
    expect(sources.every((source) => Boolean(source.summary))).toBe(true);

    const compiled = new ContextCompiler(() => new Date(now)).compile({
      projectId: "p1",
      purpose: "long-outline-test",
      budget: {
        contextWindow: 4_000,
        outputReserve: 800,
        fixedInstructionReserve: 400,
        toolReserve: 0,
        schemaReserve: 200,
        safetyReserve: 200,
      },
      sources,
    });
    expect(compiled.text).toContain("Chapter 150");
    expect(
      compiled.receipt.entries.filter((entry) => entry.status === "compressed")
        .length,
    ).toBeGreaterThan(0);
  });
});

function node(
  id: string,
  kind: OutlineNode["kind"],
  ordinal: number,
  path: string,
  depth: number,
  parentId: string | null,
): OutlineNode {
  return {
    id,
    projectId: "p1",
    parentId,
    kind,
    path,
    depth,
    ordinal,
    title: kind === "book" ? "Book" : `Chapter ${ordinal + 1}`,
    summary: `Planned event ${ordinal + 1}`,
    goal: `Goal ${ordinal + 1}`,
    conflict: `Conflict ${ordinal + 1}`,
    outcome: null,
    povEntityId: null,
    storyTime: null,
    status: ordinal < 149 ? "committed" : "planned",
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}
