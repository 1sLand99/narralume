export type JsonReadResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "invalid_json" | "request_too_large" };

export function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  return (
    contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
  );
}

export async function readJsonWithLimit(
  request: Request,
  maximumBytes: number,
): Promise<JsonReadResult> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    return { ok: false, reason: "request_too_large" };
  }
  if (!request.body) return { ok: false, reason: "invalid_json" };

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let json = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel("request body limit exceeded");
        return { ok: false, reason: "request_too_large" };
      }
      json += decoder.decode(chunk.value, { stream: true });
    }
    json += decoder.decode();
    return { ok: true, value: JSON.parse(json) as unknown };
  } catch {
    return { ok: false, reason: "invalid_json" };
  } finally {
    reader.releaseLock();
  }
}
