import { describe, expect, it } from "vitest";

import {
  authoredInstructions,
  editableInstructionOf,
  workCraftLayer,
} from "../src/prompt-language.js";

const FALLBACK = {
  "zh-CN": "默认中文写作层。",
  en: "Default English craft layer.",
} as const;

const INVARIANTS = {
  "zh-CN": "锁定正典优先；只输出正文。",
  en: "Locked canon wins; output prose only.",
} as const;

describe("editableInstructionOf", () => {
  it("picks the requested language from bilingual JSON content", () => {
    const content = JSON.stringify({
      "zh-CN": "中文层",
      en: "English layer",
    });
    expect(editableInstructionOf(content, "en")).toBe("English layer");
    expect(editableInstructionOf(content, "zh-CN")).toBe("中文层");
  });

  it("treats plain text as Chinese-only content", () => {
    expect(editableInstructionOf("纯文本指令", "zh-CN")).toBe("纯文本指令");
    expect(editableInstructionOf("纯文本指令", "en")).toBeNull();
  });

  it("returns null for blank or language-missing content", () => {
    expect(editableInstructionOf("   ", "zh-CN")).toBeNull();
    const missingEn = JSON.stringify({ "zh-CN": "仅中文" });
    expect(editableInstructionOf(missingEn, "en")).toBeNull();
  });
});

describe("authoredInstructions", () => {
  it("falls back to the shipped default and appends invariants", () => {
    const result = authoredInstructions({
      language: "zh-CN",
      templateContent: null,
      fallback: FALLBACK,
      invariants: INVARIANTS,
    });
    expect(result).toBe("默认中文写作层。\n锁定正典优先；只输出正文。");
  });

  it("lets the template override fully replace the craft layer", () => {
    const override = JSON.stringify({
      "zh-CN": "作者自定义写作法。",
      en: "Author craft layer.",
    });
    const zh = authoredInstructions({
      language: "zh-CN",
      templateContent: override,
      fallback: FALLBACK,
      invariants: INVARIANTS,
    });
    expect(zh).toBe("作者自定义写作法。\n锁定正典优先；只输出正文。");
    const en = authoredInstructions({
      language: "en",
      templateContent: override,
      fallback: FALLBACK,
      invariants: INVARIANTS,
    });
    expect(en).toContain("Author craft layer.");
    expect(en).not.toContain("Default English craft layer.");
  });

  it("keeps invariants intact even when the override omits them", () => {
    const result = authoredInstructions({
      language: "zh-CN",
      templateContent: JSON.stringify({ "zh-CN": "随便写。", en: "" }),
      fallback: FALLBACK,
      invariants: INVARIANTS,
    });
    expect(result.endsWith("锁定正典优先；只输出正文。")).toBe(true);
  });

  it("falls back to defaults when the stored override is unusable", () => {
    const result = authoredInstructions({
      language: "en",
      templateContent: JSON.stringify({ "zh-CN": "只有中文。" }),
      fallback: FALLBACK,
      invariants: INVARIANTS,
    });
    expect(result).toBe(
      "Default English craft layer.\nLocked canon wins; output prose only.",
    );
  });

  it("inserts the craft block between the step layer and invariants", () => {
    const result = authoredInstructions({
      language: "zh-CN",
      templateContent: null,
      fallback: FALLBACK,
      invariants: INVARIANTS,
      craft: "先对抗你的本能。",
    });
    expect(result).toBe(
      [
        "默认中文写作层。",
        "<writing-craft>",
        "先对抗你的本能。",
        "</writing-craft>",
        "锁定正典优先；只输出正文。",
      ].join("\n"),
    );
  });

  it("omits the craft block when craft is missing or blank", () => {
    const base = {
      language: "zh-CN" as const,
      templateContent: null,
      fallback: FALLBACK,
      invariants: INVARIANTS,
    };
    expect(authoredInstructions({ ...base, craft: null })).toBe(
      "默认中文写作层。\n锁定正典优先；只输出正文。",
    );
    expect(authoredInstructions({ ...base, craft: "   " })).toBe(
      "默认中文写作层。\n锁定正典优先；只输出正文。",
    );
  });
});

describe("workCraftLayer", () => {
  it("resolves the shipped default when no template exists", () => {
    expect(
      workCraftLayer({
        language: "zh-CN",
        templateContent: null,
        fallback: FALLBACK,
      }),
    ).toBe("默认中文写作层。");
  });

  it("follows the user override of the chapter-draft template", () => {
    expect(
      workCraftLayer({
        language: "zh-CN",
        templateContent: JSON.stringify({
          "zh-CN": "作者自定义写作法。",
          en: "Author craft layer.",
        }),
        fallback: FALLBACK,
      }),
    ).toBe("作者自定义写作法。");
  });

  it("falls back to the default when the override lacks the language", () => {
    expect(
      workCraftLayer({
        language: "en",
        templateContent: JSON.stringify({ "zh-CN": "只有中文。" }),
        fallback: FALLBACK,
      }),
    ).toBe("Default English craft layer.");
  });
});
