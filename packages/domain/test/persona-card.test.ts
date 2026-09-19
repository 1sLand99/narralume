import { createDefaultPersonaCardProfile } from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("PersonaCardProfile", () => {
  it("creates an empty native profile without sharing collection instances", () => {
    const first = createDefaultPersonaCardProfile();
    const second = createDefaultPersonaCardProfile();

    expect(first).toEqual({
      personality: null,
      scenario: null,
      exampleDialogue: null,
      greetings: [],
      creator: {
        name: null,
        notes: null,
        version: null,
        tags: [],
      },
      source: { format: "native", importedAt: null },
    });
    expect(first.greetings).not.toBe(second.greetings);
    expect(first.creator.tags).not.toBe(second.creator.tags);
  });
});
