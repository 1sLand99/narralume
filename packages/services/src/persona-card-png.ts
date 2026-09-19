import extractPngChunks from "png-chunks-extract";
import crc32 from "crc-32";
import { PERSONA_CARD_LIMITS } from "@narralume/contracts";

const PNG_SIGNATURE = Uint8Array.of(
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
);
const PNG_HEADER_BYTES = PNG_SIGNATURE.length;
const PNG_CHUNK_OVERHEAD_BYTES = 12;
const MAX_CCV3_TEXT_BYTES = Math.ceil(PERSONA_CARD_LIMITS.jsonBytes / 3) * 4;
const MAX_PNG_DIMENSION = 8_192;
const MAX_PNG_PIXELS = 16_777_216;
const crc32Buffer = crc32.buf;

export class PersonaCardPngError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PersonaCardPngError";
    this.code = code;
  }
}

/**
 * Extracts the CCv3 base64 payload from the single uncompressed PNG tEXt
 * chunk allowed by the Character Card V3 transport profile.
 *
 * The explicit preflight is intentional: png-chunks-extract allocates from a
 * chunk's declared length before checking that the bytes exist. We validate
 * all lengths, ordering, CRCs and the exact IEND boundary before handing the
 * image to that narrow dependency.
 */
export function extractCcv3Base64FromPng(input: Uint8Array): string {
  preflightPng(input);

  let encoded: string | null = null;
  try {
    for (const chunk of extractPngChunks(input)) {
      if (chunk.name === "zTXt" || chunk.name === "iTXt") {
        const keyword = readPngTextKeyword(chunk.data);
        if (keyword === "ccv3") {
          throw new PersonaCardPngError(
            "persona_card.png.compressed_ccv3_unsupported",
            "The ccv3 payload must use an uncompressed PNG tEXt chunk",
          );
        }
        continue;
      }
      if (chunk.name !== "tEXt") continue;

      const separator = chunk.data.indexOf(0);
      if (separator < 1) continue;
      const keyword = decodeLatin1(chunk.data.subarray(0, separator));
      if (keyword !== "ccv3") continue;
      if (encoded !== null) {
        throw new PersonaCardPngError(
          "persona_card.png.duplicate_ccv3",
          "The PNG must contain exactly one ccv3 tEXt chunk",
        );
      }
      const payload = chunk.data.subarray(separator + 1);
      if (
        payload.byteLength === 0 ||
        payload.byteLength > MAX_CCV3_TEXT_BYTES
      ) {
        throw new PersonaCardPngError(
          "persona_card.png.ccv3_size_invalid",
          "The PNG ccv3 payload is empty or exceeds the supported size",
        );
      }
      encoded = decodeLatin1(payload);
    }
  } catch (error) {
    if (error instanceof PersonaCardPngError) throw error;
    throw invalidPng(error);
  }

  if (encoded === null) {
    throw new PersonaCardPngError(
      "persona_card.png.ccv3_missing",
      "The PNG does not contain a ccv3 tEXt chunk",
    );
  }
  return encoded;
}

function preflightPng(input: Uint8Array): void {
  if (input.byteLength > PERSONA_CARD_LIMITS.pngBytes) {
    throw new PersonaCardPngError(
      "persona_card.png.too_large",
      "The PNG exceeds the 10 MiB import limit",
    );
  }
  if (input.byteLength < PNG_HEADER_BYTES + PNG_CHUNK_OVERHEAD_BYTES) {
    throw invalidPng();
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (input[index] !== PNG_SIGNATURE[index]) throw invalidPng();
  }

  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let offset = PNG_HEADER_BYTES;
  let chunkIndex = 0;
  let sawIhdr = false;
  let sawIend = false;

  while (offset < input.byteLength) {
    const remaining = input.byteLength - offset;
    if (remaining < PNG_CHUNK_OVERHEAD_BYTES) throw invalidPng();
    const length = view.getUint32(offset, false);
    if (length > remaining - PNG_CHUNK_OVERHEAD_BYTES) throw invalidPng();

    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const crcOffset = dataOffset + length;
    const chunkEnd = crcOffset + 4;
    const typeBytes = input.subarray(typeOffset, dataOffset);
    const type = decodeAsciiChunkType(typeBytes);

    if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) {
      throw invalidPng();
    }
    if (type === "IHDR") {
      if (sawIhdr || chunkIndex !== 0 || length !== 13) throw invalidPng();
      const width = view.getUint32(dataOffset, false);
      const height = view.getUint32(dataOffset + 4, false);
      if (
        width === 0 ||
        height === 0 ||
        width > MAX_PNG_DIMENSION ||
        height > MAX_PNG_DIMENSION ||
        width * height > MAX_PNG_PIXELS
      ) {
        throw new PersonaCardPngError(
          "persona_card.png.dimensions_unsupported",
          "The PNG dimensions exceed the supported character-card image limits",
        );
      }
      sawIhdr = true;
    }
    if (sawIend) throw invalidPng();

    const actualCrc = view.getInt32(crcOffset, false);
    const expectedCrc = crc32Buffer(input.subarray(typeOffset, crcOffset));
    if (actualCrc !== expectedCrc) throw invalidPng();

    if (type === "IEND") {
      if (length !== 0 || chunkEnd !== input.byteLength) throw invalidPng();
      sawIend = true;
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }

  if (!sawIhdr || !sawIend || offset !== input.byteLength) throw invalidPng();
}

function readPngTextKeyword(data: Uint8Array): string | null {
  const separator = data.indexOf(0);
  if (separator < 1) return null;
  return decodeLatin1(data.subarray(0, separator));
}

function decodeAsciiChunkType(input: Uint8Array): string {
  if (input.byteLength !== 4) throw invalidPng();
  for (const byte of input) {
    const isUpper = byte >= 0x41 && byte <= 0x5a;
    const isLower = byte >= 0x61 && byte <= 0x7a;
    if (!isUpper && !isLower) throw invalidPng();
  }
  return String.fromCharCode(...input);
}

function decodeLatin1(input: Uint8Array): string {
  let output = "";
  const window = 8_192;
  for (let offset = 0; offset < input.byteLength; offset += window) {
    output += String.fromCharCode(...input.subarray(offset, offset + window));
  }
  return output;
}

function invalidPng(cause?: unknown): PersonaCardPngError {
  const error = new PersonaCardPngError(
    "persona_card.png.invalid",
    "The PNG is malformed or failed its integrity check",
  );
  if (cause !== undefined) error.cause = cause;
  return error;
}
