import { describe, expect, it } from "vitest";

import {
  decodePersonaCardBase64,
  parsePersonaCardJsonBytes,
  PersonaCardFileError,
} from "../src/persona-card-file.js";

describe("persona card file boundary", () => {
  it("accepts canonical base64 within the byte limit", () => {
    expect(decodePersonaCardBase64("eyJvayI6dHJ1ZX0=", 11)).toEqual(
      new TextEncoder().encode('{"ok":true}'),
    );
  });

  it.each(["", "YQ", "YQ===", "YR==", "YQ==\n"])(
    "rejects malformed or non-canonical base64 %j",
    (source) => {
      expectCode(
        () => decodePersonaCardBase64(source, 100),
        "persona_card.file.base64_invalid",
      );
    },
  );

  it("rejects a file before allocating bytes beyond its limit", () => {
    expectCode(
      () => decodePersonaCardBase64("YWJjZA==", 3),
      "persona_card.file.too_large",
    );
  });

  it("requires fatal UTF-8, valid JSON and an object root", () => {
    expectCode(
      () => parsePersonaCardJsonBytes(Uint8Array.of(0xc3, 0x28)),
      "persona_card.json.utf8_invalid",
    );
    expectCode(
      () => parsePersonaCardJsonBytes(new TextEncoder().encode("{")),
      "persona_card.json.malformed",
    );
    expectCode(
      () => parsePersonaCardJsonBytes(new TextEncoder().encode("[]")),
      "persona_card.json.object_required",
    );
    expect(
      parsePersonaCardJsonBytes(new TextEncoder().encode('{"ok":true}')),
    ).toEqual({
      ok: true,
    });
  });
});

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(PersonaCardFileError);
    expect((error as PersonaCardFileError).code).toBe(code);
  }
}
