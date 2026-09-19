import { decodeBase64, encodeBase64 } from "./internal/bytes.js";

const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export class PersonaCardFileError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PersonaCardFileError";
    this.code = code;
  }
}

export function decodePersonaCardBase64(
  source: string,
  maxBytes: number,
): Uint8Array {
  if (
    source.length === 0 ||
    source.length % 4 !== 0 ||
    !CANONICAL_BASE64_PATTERN.test(source)
  ) {
    throw new PersonaCardFileError(
      "persona_card.file.base64_invalid",
      "The imported file is not canonical Base64",
    );
  }
  const padding = source.endsWith("==") ? 2 : source.endsWith("=") ? 1 : 0;
  const decodedLength = (source.length / 4) * 3 - padding;
  if (decodedLength > maxBytes) {
    throw new PersonaCardFileError(
      "persona_card.file.too_large",
      "The imported file exceeds the supported size",
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(source);
  } catch (error) {
    throw base64Error(error);
  }
  if (bytes.byteLength !== decodedLength || encodeBase64(bytes) !== source) {
    throw base64Error();
  }
  return bytes;
}

export function parsePersonaCardJsonBytes(bytes: Uint8Array): unknown {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const invalid = new PersonaCardFileError(
      "persona_card.json.utf8_invalid",
      "The character card JSON is not valid UTF-8",
    );
    invalid.cause = error;
    throw invalid;
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    const malformed = new PersonaCardFileError(
      "persona_card.json.malformed",
      "The character card JSON is malformed",
    );
    malformed.cause = error;
    throw malformed;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PersonaCardFileError(
      "persona_card.json.object_required",
      "The character card JSON must contain one object",
    );
  }
  return value;
}

function base64Error(cause?: unknown): PersonaCardFileError {
  const error = new PersonaCardFileError(
    "persona_card.file.base64_invalid",
    "The imported file is not canonical Base64",
  );
  if (cause !== undefined) error.cause = cause;
  return error;
}
