import {
  ActivateLoreEntriesInputSchema,
  CharacterCardV3InputSchema,
  CharacterCardV3LorebookSchema,
  CreateLorebookRequestSchema,
  CreateLoreEntryRequestSchema,
  DeleteLorebookRequestSchema,
  LOREBOOK_LIMITS,
  LoreActivationResultSchema,
  LorebookBindingStateSchema,
  ReplaceLorebookBindingsRequestSchema,
  UpdateLorebookRequestSchema,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("Lorebook contracts", () => {
  it("applies safe Lorebook defaults and rejects unknown fields", () => {
    expect(CreateLorebookRequestSchema.parse({ name: "雾港志" })).toEqual({
      name: "雾港志",
      description: null,
      enabledGlobally: false,
      scanTurns: 24,
      enabled: true,
    });
    expect(
      CreateLorebookRequestSchema.safeParse({
        name: "雾港志",
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      UpdateLorebookRequestSchema.safeParse({
        name: "雾港志",
        description: null,
        enabledGlobally: true,
        scanTurns: LOREBOOK_LIMITS.scanTurnsMax + 1,
        enabled: true,
        expectedVersion: 0,
      }).success,
    ).toBe(false);
  });

  it("requires normalized-unique keys unless an entry is constant", () => {
    expect(
      CreateLoreEntryRequestSchema.safeParse({
        title: "守门人",
        content: "她只在退潮后出现。",
      }).success,
    ).toBe(false);
    expect(
      CreateLoreEntryRequestSchema.parse({
        title: "守门人",
        content: "她只在退潮后出现。",
        constant: true,
      }).keys,
    ).toEqual([]);
    expect(
      CreateLoreEntryRequestSchema.safeParse({
        title: "守门人",
        content: "她只在退潮后出现。",
        keys: ["ＡＢＣ", "abc"],
      }).success,
    ).toBe(false);
  });

  it("validates CAS delete and unique binding contracts", () => {
    expect(DeleteLorebookRequestSchema.parse({ expectedVersion: 2 })).toEqual({
      expectedVersion: 2,
    });
    expect(
      ReplaceLorebookBindingsRequestSchema.safeParse({
        lorebookIds: ["book", "book"],
        expectedVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      LorebookBindingStateSchema.parse({
        targetId: "persona",
        lorebookIds: ["book-b", "book-a"],
        version: 2,
        updatedAt: "2026-08-30T00:00:00.000Z",
      }).version,
    ).toBe(2);
  });

  it("strictly models CCv3 character_book, including V3 optional fields", () => {
    const lorebook = ccv3Lorebook();
    expect(
      CharacterCardV3LorebookSchema.parse(lorebook).entries[0],
    ).toMatchObject({
      use_regex: false,
      case_sensitive: false,
      position: "before_char",
    });
    expect(
      CharacterCardV3LorebookSchema.safeParse({
        ...lorebook,
        entries: [{ ...lorebook.entries[0], unknown: true }],
      }).success,
    ).toBe(false);
    expect(
      CharacterCardV3LorebookSchema.safeParse({ entries: [] }).success,
    ).toBe(false);
  });

  it("counts imported character-book text against the CCv3 aggregate limit", () => {
    const oversized = inputCard({
      ...ccv3Lorebook(),
      entries: Array.from({ length: 3 }, (_, index) => ({
        ...ccv3Lorebook().entries[0],
        id: index,
        content: "界".repeat(90_000),
      })),
    });

    expect(CharacterCardV3InputSchema.safeParse(oversized).success).toBe(false);
    expect(
      CharacterCardV3InputSchema.safeParse(inputCard(ccv3Lorebook())).success,
    ).toBe(true);
  });

  it("validates activation candidates, decisions, and budget accounting", () => {
    const candidate = activationCandidate();
    expect(
      ActivateLoreEntriesInputSchema.parse({
        projectId: "project",
        personaId: "persona",
        sessionId: "session",
        recentTurns: ["雾港"],
        authorInput: null,
        budgetChars: 100,
        candidates: [candidate],
      }).candidates,
    ).toHaveLength(1);
    expect(
      ActivateLoreEntriesInputSchema.safeParse({
        projectId: "project",
        personaId: "persona",
        sessionId: "session",
        recentTurns: [],
        authorInput: null,
        budgetChars: 100,
        candidates: [
          {
            ...candidate,
            entry: { ...candidate.entry, lorebookId: "some-other-book" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      LoreActivationResultSchema.parse({
        activated: [
          {
            entryId: "entry",
            lorebookId: "book",
            scope: "session",
            title: "雾港",
            content: "退潮后显露。",
            priority: 10,
            matchedKeys: ["雾港"],
          },
        ],
        decisions: [
          {
            entryId: "entry",
            scope: "session",
            status: "activated-key",
            matchedKeys: ["雾港"],
          },
        ],
        usedChars: 7,
      }).decisions[0]?.status,
    ).toBe("activated-key");
  });
});

function ccv3Lorebook() {
  return {
    name: "雾港志",
    description: "退潮后才可见的港口。",
    scan_depth: 24,
    token_budget: 1000,
    recursive_scanning: false,
    extensions: {},
    entries: [
      {
        keys: ["雾港"],
        content: "雾港每月只退潮一次。",
        extensions: {},
        enabled: true,
        insertion_order: 10,
        use_regex: false,
        case_sensitive: false,
        constant: false,
        name: "潮汐",
        priority: 20,
        id: "tide",
        comment: "兼容字段",
        selective: false,
        secondary_keys: ["退潮"],
        position: "before_char" as const,
      },
    ],
  };
}

function inputCard(characterBook: ReturnType<typeof ccv3Lorebook>) {
  return {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "沈砚",
      description: "守门人",
      personality: "克制",
      scenario: "退潮",
      first_mes: "你来了。",
      mes_example: "{{char}}：潮线不会说谎。",
      creator_notes: "测试",
      system_prompt: "",
      post_history_instructions: "",
      alternate_greetings: [],
      tags: [],
      creator: "测试",
      character_version: "1",
      extensions: {},
      group_only_greetings: [],
      character_book: characterBook,
    },
  };
}

function activationCandidate() {
  const timestamp = "2026-08-30T00:00:00.000Z";
  return {
    lorebook: {
      id: "book",
      projectId: "project",
      name: "雾港志",
      description: null,
      enabledGlobally: false,
      scanTurns: 24,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 0,
    },
    entry: {
      id: "entry",
      lorebookId: "book",
      title: "雾港",
      content: "退潮后显露。",
      keys: ["雾港"],
      constant: false,
      priority: 10,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 0,
    },
    scope: "session" as const,
    scopeId: "session",
  };
}
