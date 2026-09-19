import {
  ImportPersonaCardJsonRequestSchema,
  ImportPersonaCardPngRequestSchema,
  PERSONA_CARD_LIMITS,
} from "@narralume/contracts";
import { describe, expect, it } from "vitest";

describe("persona card import API contracts", () => {
  it("defaults a create target to a project character", () => {
    expect(
      ImportPersonaCardJsonRequestSchema.parse({
        requestId: "import-1",
        filename: "card.json",
        contentBase64: "e30=",
        target: { mode: "create" },
      }),
    ).toMatchObject({
      target: { mode: "create", kind: "character", entityId: null },
    });
  });

  it("requires optimistic concurrency for replacement", () => {
    expect(
      ImportPersonaCardJsonRequestSchema.safeParse({
        requestId: "import-1",
        filename: "card.json",
        contentBase64: "e30=",
        target: { mode: "replace", personaId: "persona-1" },
      }).success,
    ).toBe(false);
  });

  it("caps request Base64 before service decoding", () => {
    const oversized = "A".repeat(
      4 * Math.ceil(PERSONA_CARD_LIMITS.pngBytes / 3) + 1,
    );
    expect(
      ImportPersonaCardPngRequestSchema.safeParse({
        requestId: "import-1",
        filename: "card.png",
        contentBase64: oversized,
        target: { mode: "create" },
      }).success,
    ).toBe(false);
  });
});
