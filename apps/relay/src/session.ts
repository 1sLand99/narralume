const COOKIE_NAME = "__Host-narralume_session";
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const encoder = new TextEncoder();

export function isValidSessionSigningKey(secret: string): boolean {
  return /^[0-9a-f]{64}$/u.test(secret);
}

export interface VerifiedSession {
  exp: number;
  id: string;
  sub: string;
  v: 1;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );
}

export async function issueSession(
  secret: string,
  subject: string,
  nowMs = Date.now(),
): Promise<string> {
  const key = await hmacKey(secret);
  const subjectSignature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`subject:${subject}`),
  );
  const nowSeconds = Math.floor(nowMs / 1_000);
  const windowStart =
    Math.floor(nowSeconds / SESSION_TTL_SECONDS) * SESSION_TTL_SECONDS;
  const sessionSignature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`session:${subject}:${windowStart}`),
  );
  const payload: VerifiedSession = {
    exp: windowStart + SESSION_TTL_SECONDS,
    id: base64UrlEncode(new Uint8Array(sessionSignature)),
    sub: base64UrlEncode(new Uint8Array(subjectSignature)),
    v: 1,
  };
  const encodedPayload = base64UrlEncode(
    encoder.encode(JSON.stringify(payload)),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(encodedPayload),
  );
  return `${encodedPayload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifySession(
  token: string | null,
  secret: string,
  subject: string,
  nowMs = Date.now(),
): Promise<VerifiedSession | null> {
  if (!token) return null;
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) return null;
  const signature = base64UrlDecode(encodedSignature);
  const payloadBytes = base64UrlDecode(encodedPayload);
  if (!signature || !payloadBytes) return null;
  const validSignature = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature,
    encoder.encode(encodedPayload),
  );
  if (!validSignature) return null;
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(payloadBytes),
    ) as Partial<VerifiedSession>;
    const subjectSignature = await crypto.subtle.sign(
      "HMAC",
      await hmacKey(secret),
      encoder.encode(`subject:${subject}`),
    );
    const expectedSubject = base64UrlEncode(new Uint8Array(subjectSignature));
    const valid =
      payload.v === 1 &&
      typeof payload.id === "string" &&
      payload.id.length > 0 &&
      payload.sub === expectedSubject &&
      typeof payload.exp === "number" &&
      payload.exp > Math.floor(nowMs / 1000);
    return valid ? (payload as VerifiedSession) : null;
  } catch {
    return null;
  }
}

export function sessionFromCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE_NAME) return value.join("=") || null;
  }
  return null;
}

export function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}
