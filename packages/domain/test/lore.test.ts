import {
  activateLoreEntries,
  normalizeLoreMatchText,
  type LoreActivationCandidate,
  type Lorebook,
  type LoreEntry,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const now = "2026-08-30T00:00:00.000Z";

describe("lore activation", () => {
  it("matches NFKC-normalized Chinese text without English word boundaries", () => {
    expect(normalizeLoreMatchText("ＡＢＣ·雾港")).toBe("abc·雾港");

    const result = activateLoreEntries({
      ...activationInput(),
      authorInput: "她回到了ＡＢＣ雾港旧码头。",
      candidates: [
        candidate(
          book("book"),
          entry("entry", "book", { keys: ["abc雾港", "雾港", "无关"] }),
          "project",
          "project",
        ),
      ],
    });

    expect(result.activated.map(({ entryId }) => entryId)).toEqual(["entry"]);
    expect(result.decisions).toEqual([
      {
        entryId: "entry",
        scope: "project",
        status: "activated-key",
        matchedKeys: ["abc雾港", "雾港"],
      },
    ]);
  });

  it("uses each book's own turn window and always adds current author input", () => {
    const result = activateLoreEntries({
      ...activationInput(),
      recentTurns: ["远古门已经关闭", "刚才只谈到了潮声"],
      authorInput: "现在看见了灯塔",
      candidates: [
        candidate(
          book("zero", { scanTurns: 0 }),
          entry("zero-current", "zero", { keys: ["灯塔"] }),
          "project",
          "project",
        ),
        candidate(
          book("zero", { scanTurns: 0 }),
          entry("zero-old", "zero", { keys: ["远古门"] }),
          "project",
          "project",
        ),
        candidate(
          book("short", { scanTurns: 1 }),
          entry("short-old", "short", { keys: ["远古门"] }),
          "project",
          "project",
        ),
        candidate(
          book("long", { scanTurns: 2 }),
          entry("long-old", "long", { keys: ["远古门"] }),
          "project",
          "project",
        ),
        candidate(
          book("short", { scanTurns: 1 }),
          entry("current", "short", { keys: ["灯塔"] }),
          "project",
          "project",
        ),
      ],
    });

    expect(result.activated.map(({ entryId }) => entryId)).toEqual([
      "current",
      "long-old",
      "zero-current",
    ]);
    expect(decisionStatus(result, "short-old")).toBe("excluded-no-match");
    expect(decisionStatus(result, "zero-old")).toBe("excluded-no-match");
  });

  it("reports constant, disabled, no-match, scope, and budget decisions", () => {
    const result = activateLoreEntries({
      ...activationInput(),
      authorInput: "潮声",
      budgetChars: 4,
      candidates: [
        candidate(
          book("book"),
          entry("constant", "book", {
            constant: true,
            content: "常驻",
            keys: [],
            priority: 50,
          }),
          "project",
          "project",
        ),
        candidate(
          book("book"),
          entry("budget", "book", {
            content: "四个字符",
            keys: ["潮声"],
            priority: 40,
          }),
          "project",
          "project",
        ),
        candidate(
          book("disabled-book", { enabled: false }),
          entry("disabled", "disabled-book", { constant: true }),
          "project",
          "project",
        ),
        candidate(
          book("book"),
          entry("disabled-entry", "book", {
            constant: true,
            enabled: false,
          }),
          "project",
          "project",
        ),
        candidate(
          book("book"),
          entry("no-match", "book", { keys: ["月亮"] }),
          "project",
          "project",
        ),
        candidate(
          book("book"),
          entry("wrong-scope", "book", { constant: true }),
          "persona",
          "somebody-else",
        ),
      ],
    });

    expect(result.usedChars).toBe(2);
    expect(decisionStatus(result, "constant")).toBe("activated-constant");
    expect(decisionStatus(result, "budget")).toBe("excluded-budget");
    expect(decisionStatus(result, "disabled")).toBe("excluded-disabled");
    expect(decisionStatus(result, "disabled-entry")).toBe("excluded-disabled");
    expect(decisionStatus(result, "no-match")).toBe("excluded-no-match");
    expect(decisionStatus(result, "wrong-scope")).toBe("excluded-scope");
  });

  it("deduplicates overlapping scopes as session, Persona, then project", () => {
    const sharedBook = book("shared");
    const sharedEntry = entry("shared-entry", "shared", {
      constant: true,
    });
    const result = activateLoreEntries({
      ...activationInput(),
      candidates: [
        candidate(sharedBook, sharedEntry, "project", "project"),
        candidate(sharedBook, sharedEntry, "persona", "persona"),
        candidate(sharedBook, sharedEntry, "session", "session"),
      ],
    });

    expect(result.activated).toHaveLength(1);
    expect(result.activated[0]?.scope).toBe("session");
    expect(result.decisions).toEqual([
      {
        entryId: "shared-entry",
        scope: "session",
        status: "activated-constant",
        matchedKeys: [],
      },
      {
        entryId: "shared-entry",
        scope: "persona",
        status: "excluded-scope",
        matchedKeys: [],
      },
      {
        entryId: "shared-entry",
        scope: "project",
        status: "excluded-scope",
        matchedKeys: [],
      },
    ]);
  });

  it("orders budget allocation by priority, scope proximity, and stable id", () => {
    const inputs = [
      candidate(
        book("b-project"),
        entry("b", "b-project", { constant: true, priority: 10 }),
        "project",
        "project",
      ),
      candidate(
        book("a-persona"),
        entry("a", "a-persona", { constant: true, priority: 10 }),
        "persona",
        "persona",
      ),
      candidate(
        book("c-session"),
        entry("c", "c-session", { constant: true, priority: 10 }),
        "session",
        "session",
      ),
      candidate(
        book("high"),
        entry("z", "high", { constant: true, priority: 11 }),
        "project",
        "project",
      ),
    ];
    const forward = activateLoreEntries({
      ...activationInput(),
      budgetChars: 100,
      candidates: inputs,
    });
    const reverse = activateLoreEntries({
      ...activationInput(),
      budgetChars: 100,
      candidates: [...inputs].reverse(),
    });

    expect(forward.activated.map(({ entryId }) => entryId)).toEqual([
      "z",
      "c",
      "a",
      "b",
    ]);
    expect(reverse).toEqual(forward);
  });

  it("uses exact character boundaries and skips oversized entries without failing", () => {
    const result = activateLoreEntries({
      ...activationInput(),
      budgetChars: 4,
      candidates: [
        candidate(
          book("large"),
          entry("large", "large", {
            constant: true,
            content: "超过四字了",
            priority: 100,
          }),
          "project",
          "project",
        ),
        candidate(
          book("exact"),
          entry("exact", "exact", {
            constant: true,
            content: "正好四字",
            priority: 0,
          }),
          "project",
          "project",
        ),
      ],
    });

    expect(result.usedChars).toBe(4);
    expect(result.activated.map(({ entryId }) => entryId)).toEqual(["exact"]);
    expect(decisionStatus(result, "large")).toBe("excluded-budget");
    expect(decisionStatus(result, "exact")).toBe("activated-constant");
    expect(
      activateLoreEntries({
        ...activationInput(),
        budgetChars: 0,
        candidates: [
          candidate(
            book("zero-budget"),
            entry("zero-budget", "zero-budget", { constant: true }),
            "project",
            "project",
          ),
        ],
      }).activated,
    ).toEqual([]);
  });

  it("rejects conflicting duplicate candidates instead of depending on input order", () => {
    const sharedBook = book("book");
    expect(() =>
      activateLoreEntries({
        ...activationInput(),
        candidates: [
          candidate(
            sharedBook,
            entry("same", "book", { content: "版本一" }),
            "project",
            "project",
          ),
          candidate(
            sharedBook,
            entry("same", "book", { content: "版本二" }),
            "session",
            "session",
          ),
        ],
      }),
    ).toThrowError(/same entry and Lorebook state/u);
  });
});

function activationInput() {
  return {
    projectId: "project",
    personaId: "persona",
    sessionId: "session",
    recentTurns: [] as string[],
    authorInput: null,
    budgetChars: 10_000,
    candidates: [] as LoreActivationCandidate[],
  };
}

function book(id: string, patch: Partial<Lorebook> = {}): Lorebook {
  return {
    id,
    projectId: "project",
    name: id,
    description: null,
    enabledGlobally: true,
    scanTurns: 24,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    version: 0,
    ...patch,
  };
}

function entry(
  id: string,
  lorebookId: string,
  patch: Partial<LoreEntry> = {},
): LoreEntry {
  return {
    id,
    lorebookId,
    title: id,
    content: "内容",
    keys: ["潮声"],
    constant: false,
    priority: 0,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    version: 0,
    ...patch,
  };
}

function candidate(
  lorebook: Lorebook,
  loreEntry: LoreEntry,
  scope: LoreActivationCandidate["scope"],
  scopeId: string,
): LoreActivationCandidate {
  return { lorebook, entry: loreEntry, scope, scopeId };
}

function decisionStatus(
  result: ReturnType<typeof activateLoreEntries>,
  entryId: string,
) {
  return result.decisions.find((decision) => decision.entryId === entryId)
    ?.status;
}
