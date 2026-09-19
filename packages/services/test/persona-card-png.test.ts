import { buf as crc32Buffer } from "crc-32";
import { describe, expect, it } from "vitest";

import {
  extractCcv3Base64FromPng,
  PersonaCardPngError,
} from "../src/persona-card-png.js";

const encoder = new TextEncoder();
const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

describe("CCv3 PNG transport", () => {
  it("extracts one valid uncompressed ccv3 tEXt payload", () => {
    const encoded = "eyJzcGVjIjoiY2hhcmFjdGVyX2NhcmRfdjMifQ==";
    const png = makePng([
      makeChunk(
        "tEXt",
        concat(encoder.encode("ccv3"), [0], encoder.encode(encoded)),
      ),
    ]);

    expect(extractCcv3Base64FromPng(png)).toBe(encoded);
  });

  it("rejects a declared chunk length before the extractor can allocate it", () => {
    const png = makePng([]);
    const corrupted = png.slice();
    new DataView(corrupted.buffer).setUint32(8, 0xffff_ffff, false);

    expectCode(
      () => extractCcv3Base64FromPng(corrupted),
      "persona_card.png.invalid",
    );
  });

  it("rejects duplicate and compressed ccv3 payloads", () => {
    const text = makeChunk(
      "tEXt",
      concat(encoder.encode("ccv3"), [0], encoder.encode("e30=")),
    );
    expectCode(
      () => extractCcv3Base64FromPng(makePng([text, text])),
      "persona_card.png.duplicate_ccv3",
    );

    const compressed = makeChunk(
      "zTXt",
      concat(encoder.encode("ccv3"), [0, 0, 1, 2, 3]),
    );
    expectCode(
      () => extractCcv3Base64FromPng(makePng([compressed])),
      "persona_card.png.compressed_ccv3_unsupported",
    );
  });

  it("rejects CRC errors and bytes after IEND", () => {
    const png = makePng([
      makeChunk(
        "tEXt",
        concat(encoder.encode("ccv3"), [0], encoder.encode("e30=")),
      ),
    ]);
    const badCrc = png.slice();
    badCrc[badCrc.length - 17] = badCrc[badCrc.length - 17]! ^ 0xff;
    expectCode(
      () => extractCcv3Base64FromPng(badCrc),
      "persona_card.png.invalid",
    );
    expectCode(
      () => extractCcv3Base64FromPng(concat(png, [1])),
      "persona_card.png.invalid",
    );
  });

  it("rejects image dimensions that could cause a decode bomb", () => {
    const png = makePng([]);
    const oversized = png.slice();
    const view = new DataView(oversized.buffer);
    view.setUint32(16, 100_000, false);
    const ihdrBody = oversized.subarray(12, 29);
    view.setInt32(29, crc32Buffer(ihdrBody), false);
    expectCode(
      () => extractCcv3Base64FromPng(oversized),
      "persona_card.png.dimensions_unsupported",
    );
  });
});

function makePng(extra: readonly Uint8Array[]): Uint8Array {
  const ihdr = new Uint8Array(13);
  ihdr[3] = 1;
  ihdr[7] = 1;
  ihdr[8] = 8;
  ihdr[9] = 6;
  return concat(
    signature,
    makeChunk("IHDR", ihdr),
    ...extra,
    makeChunk("IEND", []),
  );
}

function makeChunk(
  type: string,
  data: Uint8Array | readonly number[],
): Uint8Array {
  const typeBytes = encoder.encode(type);
  const dataBytes = Uint8Array.from(data);
  const body = concat(typeBytes, dataBytes);
  const output = new Uint8Array(12 + dataBytes.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, dataBytes.length, false);
  output.set(body, 4);
  view.setInt32(8 + dataBytes.length, crc32Buffer(body), false);
  return output;
}

function concat(
  ...parts: readonly (Uint8Array | readonly number[])[]
): Uint8Array {
  const arrays = parts.map((part) => Uint8Array.from(part));
  const output = new Uint8Array(
    arrays.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of arrays) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(PersonaCardPngError);
    expect((error as PersonaCardPngError).code).toBe(code);
  }
}
