/**
 * 公网 Relay 的纯判定层。
 *
 * 浏览器只允许调用 OpenAI Chat Completions。Relay 强制模型、剥掉客户端
 * 鉴权与任意自定义头，再注入 Cloudflare Access service token 和本地 Bridge
 * 共享密钥。上游 API Key 不进入 Cloudflare。
 */

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

export const RELAY_REQUEST_BODY_MAX_BYTES = 512 * 1024;
export const RELAY_MAX_MESSAGES = 128;
export const RELAY_MAX_TOOLS = 16;
export const RELAY_MAX_OUTPUT_TOKENS = 32_000;

const ALLOWED_BODY_FIELDS = new Set([
  "max_tokens",
  "messages",
  "model",
  "prompt_cache_key",
  "reasoning_effort",
  "response_format",
  "stop",
  "stream",
  "stream_options",
  "temperature",
  "tool_choice",
  "tools",
  "top_p",
]);

export interface RelayEnv {
  upstreamBaseUrl: string;
  model: string;
  bridgeAccessClientId: string;
  bridgeAccessClientSecret: string;
  bridgeSharedSecret: string;
}

export interface RelayRequestContext {
  method: string;
  url: string;
  body: unknown;
}

export interface RelayDecisionForward {
  action: "forward";
  upstreamUrl: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface RelayDecisionReject {
  action: "reject";
  status: number;
  code: string;
  message: string;
}

export type RelayDecision = RelayDecisionForward | RelayDecisionReject;

export function decideRelay(
  env: RelayEnv,
  context: RelayRequestContext,
): RelayDecision {
  if (context.method !== "POST") {
    return {
      action: "reject",
      status: 405,
      code: "method_not_allowed",
      message: "The relay only accepts POST requests.",
    };
  }
  if (normalizePath(context.url) !== CHAT_COMPLETIONS_PATH) {
    return {
      action: "reject",
      status: 404,
      code: "path_not_allowed",
      message: "The path is not in the relay allowlist.",
    };
  }
  if (!isJsonObject(context.body)) {
    return {
      action: "reject",
      status: 400,
      code: "invalid_body",
      message: "The request body must be a JSON object.",
    };
  }

  const bodyBytes = jsonByteLength(context.body);
  if (bodyBytes === null) {
    return invalidBody("The request body must be valid JSON.");
  }
  if (bodyBytes > RELAY_REQUEST_BODY_MAX_BYTES) {
    return {
      action: "reject",
      status: 413,
      code: "request_too_large",
      message: `The request body must not exceed ${RELAY_REQUEST_BODY_MAX_BYTES} bytes.`,
    };
  }

  for (const field of Object.keys(context.body)) {
    if (!ALLOWED_BODY_FIELDS.has(field)) {
      return {
        action: "reject",
        status: 400,
        code: "field_not_allowed",
        message: `The request field "${field}" is not allowed.`,
      };
    }
  }

  const validatedBody = validateChatBody(context.body);
  if (!validatedBody) {
    return invalidBody(
      "The request body does not match the public Chat Completions contract.",
    );
  }

  return {
    action: "forward",
    upstreamUrl: new URL(
      "chat/completions",
      `${env.upstreamBaseUrl.replace(/\/+$/u, "")}/`,
    ).toString(),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "cf-access-client-id": env.bridgeAccessClientId,
      "cf-access-client-secret": env.bridgeAccessClientSecret,
      "x-narrative-bridge-token": env.bridgeSharedSecret,
    },
    body: {
      ...validatedBody,
      model: env.model,
    },
  };
}

export function responseHeadersForRelay(
  upstreamHeaders: Iterable<[string, string]>,
  allowedOrigin: string | null,
): Record<string, string> {
  const source = new Map<string, string>();
  for (const [name, value] of upstreamHeaders) {
    source.set(name.toLowerCase(), value);
  }
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  const contentType = source.get("content-type");
  if (contentType) headers["content-type"] = contentType;
  const requestId = source.get("x-request-id");
  if (requestId) headers["x-request-id"] = requestId;
  if (allowedOrigin) {
    headers["access-control-allow-origin"] = allowedOrigin;
    headers["access-control-allow-credentials"] = "true";
    headers.vary = "origin";
  }
  return headers;
}

function normalizePath(url: string): string {
  let pathname = url.split("?")[0] ?? url;
  if (!pathname.startsWith("/v1/")) pathname = `/v1${pathname}`;
  return pathname.toLowerCase();
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidBody(message: string): RelayDecisionReject {
  return {
    action: "reject",
    status: 400,
    code: "invalid_body",
    message,
  };
}

function jsonByteLength(value: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return null;
  }
}

function validateChatBody(
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  const messages = validateMessages(body.messages);
  if (!messages) return null;

  const maxTokens = validateMaxTokens(body.max_tokens);
  if (!Number.isFinite(maxTokens)) return null;
  const result: Record<string, unknown> = {
    messages,
    max_tokens: maxTokens,
  };

  if (body.stream !== undefined) {
    if (typeof body.stream !== "boolean") return null;
    result.stream = body.stream;
  }
  if (body.stream_options !== undefined) {
    if (
      !hasOnlyKeys(body.stream_options, ["include_usage"]) ||
      typeof body.stream_options.include_usage !== "boolean"
    ) {
      return null;
    }
    result.stream_options = {
      include_usage: body.stream_options.include_usage,
    };
  }
  if (body.temperature !== undefined) {
    if (!isNumberInRange(body.temperature, 0, 2)) return null;
    result.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    if (!isNumberInRange(body.top_p, 0, 1)) return null;
    result.top_p = body.top_p;
  }
  if (body.reasoning_effort !== undefined) {
    if (
      typeof body.reasoning_effort !== "string" ||
      !["none", "minimal", "low", "medium", "high"].includes(
        body.reasoning_effort,
      )
    ) {
      return null;
    }
    result.reasoning_effort = body.reasoning_effort;
  }
  if (body.stop !== undefined) {
    const stop = validateStop(body.stop);
    if (!stop) return null;
    result.stop = stop;
  }
  if (body.prompt_cache_key !== undefined) {
    if (!isBoundedString(body.prompt_cache_key, 1, 128)) return null;
    result.prompt_cache_key = body.prompt_cache_key;
  }
  if (body.response_format !== undefined) {
    const responseFormat = validateResponseFormat(body.response_format);
    if (!responseFormat) return null;
    result.response_format = responseFormat;
  }
  if (body.tools !== undefined) {
    const tools = validateTools(body.tools);
    if (!tools) return null;
    result.tools = tools;
  }
  if (body.tool_choice !== undefined) {
    const toolChoice = validateToolChoice(body.tool_choice);
    if (!toolChoice) return null;
    result.tool_choice = toolChoice;
  }

  return result;
}

function validateMaxTokens(value: unknown): number {
  if (value === undefined) return RELAY_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(value) || (value as number) < 1) return Number.NaN;
  return Math.min(value as number, RELAY_MAX_OUTPUT_TOKENS);
}

function validateMessages(value: unknown): Record<string, unknown>[] | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > RELAY_MAX_MESSAGES
  ) {
    return null;
  }
  const messages: Record<string, unknown>[] = [];
  for (const candidate of value) {
    if (
      !hasOnlyKeys(candidate, [
        "content",
        "name",
        "role",
        "tool_call_id",
        "tool_calls",
      ]) ||
      typeof candidate.role !== "string" ||
      !["assistant", "developer", "system", "tool", "user"].includes(
        candidate.role,
      ) ||
      !(
        candidate.content === null ||
        isBoundedString(candidate.content, 0, RELAY_REQUEST_BODY_MAX_BYTES)
      )
    ) {
      return null;
    }

    const message: Record<string, unknown> = {
      role: candidate.role,
      content: candidate.content,
    };
    if (candidate.name !== undefined) {
      if (!isName(candidate.name)) return null;
      message.name = candidate.name;
    }
    if (candidate.tool_call_id !== undefined) {
      if (!isBoundedString(candidate.tool_call_id, 1, 128)) return null;
      message.tool_call_id = candidate.tool_call_id;
    }
    if (candidate.tool_calls !== undefined) {
      const calls = validateMessageToolCalls(candidate.tool_calls);
      if (!calls) return null;
      message.tool_calls = calls;
    }
    messages.push(message);
  }
  return messages;
}

function validateMessageToolCalls(
  value: unknown,
): Record<string, unknown>[] | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > RELAY_MAX_TOOLS
  )
    return null;
  const calls: Record<string, unknown>[] = [];
  for (const candidate of value) {
    if (
      !hasOnlyKeys(candidate, ["function", "id", "type"]) ||
      candidate.type !== "function" ||
      !isBoundedString(candidate.id, 1, 128) ||
      !hasOnlyKeys(candidate.function, ["arguments", "name"]) ||
      !isName(candidate.function.name) ||
      !isBoundedString(
        candidate.function.arguments,
        0,
        RELAY_REQUEST_BODY_MAX_BYTES,
      )
    ) {
      return null;
    }
    calls.push({
      id: candidate.id,
      type: "function",
      function: {
        name: candidate.function.name,
        arguments: candidate.function.arguments,
      },
    });
  }
  return calls;
}

function validateTools(value: unknown): Record<string, unknown>[] | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > RELAY_MAX_TOOLS
  )
    return null;
  const tools: Record<string, unknown>[] = [];
  for (const candidate of value) {
    if (
      !hasOnlyKeys(candidate, ["function", "type"]) ||
      candidate.type !== "function" ||
      !hasOnlyKeys(candidate.function, [
        "description",
        "name",
        "parameters",
        "strict",
      ]) ||
      !isName(candidate.function.name) ||
      !isJsonObject(candidate.function.parameters)
    ) {
      return null;
    }
    const fn: Record<string, unknown> = {
      name: candidate.function.name,
      parameters: candidate.function.parameters,
    };
    if (candidate.function.description !== undefined) {
      if (!isBoundedString(candidate.function.description, 0, 2_048))
        return null;
      fn.description = candidate.function.description;
    }
    if (candidate.function.strict !== undefined) {
      if (typeof candidate.function.strict !== "boolean") return null;
      fn.strict = candidate.function.strict;
    }
    tools.push({ type: "function", function: fn });
  }
  return tools;
}

function validateToolChoice(value: unknown): unknown | null {
  if (
    typeof value === "string" &&
    ["auto", "none", "required"].includes(value)
  ) {
    return value;
  }
  if (
    hasOnlyKeys(value, ["function", "type"]) &&
    value.type === "function" &&
    hasOnlyKeys(value.function, ["name"]) &&
    isName(value.function.name)
  ) {
    return { type: "function", function: { name: value.function.name } };
  }
  return null;
}

function validateResponseFormat(
  value: unknown,
): Record<string, unknown> | null {
  if (!isJsonObject(value)) return null;
  if (hasOnlyKeys(value, ["type"]) && value.type === "json_object") {
    return { type: "json_object" };
  }
  if (
    !hasOnlyKeys(value, ["json_schema", "type"]) ||
    value.type !== "json_schema" ||
    !hasOnlyKeys(value.json_schema, [
      "description",
      "name",
      "schema",
      "strict",
    ]) ||
    !isName(value.json_schema.name) ||
    !isJsonObject(value.json_schema.schema)
  ) {
    return null;
  }
  const jsonSchema: Record<string, unknown> = {
    name: value.json_schema.name,
    schema: value.json_schema.schema,
  };
  if (value.json_schema.description !== undefined) {
    if (!isBoundedString(value.json_schema.description, 0, 2_048)) return null;
    jsonSchema.description = value.json_schema.description;
  }
  if (value.json_schema.strict !== undefined) {
    if (typeof value.json_schema.strict !== "boolean") return null;
    jsonSchema.strict = value.json_schema.strict;
  }
  return { type: "json_schema", json_schema: jsonSchema };
}

function validateStop(value: unknown): string | string[] | null {
  if (isBoundedString(value, 1, 200)) return value;
  if (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 4 &&
    value.every((item) => isBoundedString(item, 1, 200))
  ) {
    return value as string[];
  }
  return null;
}

function hasOnlyKeys(
  value: unknown,
  allowed: readonly string[],
): value is Record<string, unknown> {
  return (
    isJsonObject(value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
}

function isBoundedString(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum
  );
}

function isName(value: unknown): value is string {
  return isBoundedString(value, 1, 64) && /^[A-Za-z0-9_-]+$/u.test(value);
}

function isNumberInRange(value: unknown, minimum: number, maximum: number) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}
