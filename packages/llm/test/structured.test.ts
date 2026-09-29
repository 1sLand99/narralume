import { describe, expect, it } from "vitest";

import {
  AnthropicMessagesAdapter,
  ModelGateway,
  OpenAIChatAdapter,
  StructuredOutputError,
  structuredTierPlan,
  type FetchLike,
  type ModelRequest,
  type ValidationResult,
} from "../src/index.js";
import { jsonResponse } from "./helpers.js";

const request: ModelRequest = {
  model: "writer",
  messages: [{ role: "user", content: "return ok" }],
  responseSchema: {
    name: "probe",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean", const: true } },
    },
  },
};

describe("structured generation", () => {
  it.each(["{", '{"ok":true}'])(
    "does not repair or accept truncated structured output: %s",
    async (content) => {
      const transport = recordingFetch([
        jsonResponse({
          id: "truncated",
          choices: [{ message: { content }, finish_reason: "length" }],
          usage: { prompt_tokens: 10, completion_tokens: 3000 },
        }),
      ]);
      await expect(
        gatewayWith(transport.fetch).generateStructured(
          request,
          validateProbe,
          { maxRepairAttempts: 3 },
        ),
      ).rejects.toMatchObject({ finishReason: "length", attempts: 1 });
      expect(transport.bodies).toHaveLength(1);
    },
  );

  it("uses prompt-only structured output until capabilities are explicitly verified", () => {
    expect(structuredTierPlan({})).toEqual(["prompt"]);
    expect(
      structuredTierPlan({
        structuredOutput: true,
        structuredOutputNative: true,
        structuredOutputJsonMode: false,
      }),
    ).toEqual(["native", "prompt"]);
    expect(
      structuredTierPlan({
        structuredOutput: true,
        structuredOutputNative: false,
        structuredOutputJsonMode: true,
      }),
    ).toEqual(["json-mode", "prompt"]);
    expect(structuredTierPlan({ structuredOutput: false })).toEqual([]);
  });

  it("uses native schema output when it validates", async () => {
    const gateway = gatewayWith(async () => chat('{"ok":true}'));
    const result = await gateway.generateStructured(request, validateProbe);
    expect(result).toMatchObject({
      value: { ok: true },
      mode: "native",
      attempts: 1,
    });
  });

  it("recovers from native validation failure via json-mode", async () => {
    const transport = recordingFetch([
      chat('{"ok":false}'),
      chat('{"ok":true}'),
    ]);
    const attempts: string[] = [];
    const result = await gatewayWith(transport.fetch).generateStructured(
      request,
      validateProbe,
      {
        onAttempt: (event) => attempts.push(event.mode),
      },
    );
    expect(result).toMatchObject({
      value: { ok: true },
      mode: "json-mode",
      attempts: 2,
    });
    expect(attempts).toEqual(["native", "json-mode"]);
    // The second request must use json_object format plus a JSON system hint.
    expect(transport.bodies[1]?.response_format).toEqual({
      type: "json_object",
    });
    expect(transport.bodies[1]?.messages).toContainEqual({
      role: "system",
      content: "Respond with a single JSON object.",
    });
  });

  it("recovers from a native compatibility error via json-mode", async () => {
    const transport = recordingFetch([
      jsonResponse(
        { error: { message: "response_format json_schema unavailable" } },
        400,
      ),
      chat('{"ok":true}'),
    ]);
    const result = await gatewayWith(transport.fetch).generateStructured(
      request,
      validateProbe,
    );
    expect(result).toMatchObject({
      value: { ok: true },
      mode: "json-mode",
      attempts: 2,
    });
    expect(transport.bodies[0]?.response_format).toMatchObject({
      type: "json_schema",
    });
    expect(transport.bodies[1]?.response_format).toEqual({
      type: "json_object",
    });
  });

  it("falls back to schema prompting when json-mode is also unsupported", async () => {
    const transport = recordingFetch([
      jsonResponse(
        { error: { message: "response_format json_schema unavailable" } },
        400,
      ),
      jsonResponse(
        { error: { message: "response_format json_object unavailable" } },
        400,
      ),
      chat('{"ok":true}'),
    ]);
    const attempts: string[] = [];
    const result = await gatewayWith(transport.fetch).generateStructured(
      request,
      validateProbe,
      { onAttempt: (event) => attempts.push(event.mode) },
    );
    expect(result).toMatchObject({
      value: { ok: true },
      mode: "prompt",
      attempts: 3,
    });
    expect(attempts).toEqual(["native", "json-mode", "prompt"]);
    expect(transport.bodies[2]?.response_format).toBeUndefined();
  });

  it("falls back to prompt then repair when json-mode output is invalid", async () => {
    const transport = recordingFetch([
      chat('{"ok":false}'),
      chat('{"ok":false}'),
      chat('{"ok":false}'),
      chat('```json\n{"ok":true}\n```'),
    ]);
    const attempts: string[] = [];
    const result = await gatewayWith(transport.fetch).generateStructured(
      request,
      validateProbe,
      {
        maxRepairAttempts: 1,
        onAttempt: (event) => attempts.push(event.mode),
      },
    );
    expect(result).toMatchObject({
      value: { ok: true },
      mode: "repair",
      attempts: 4,
      usage: { inputTokens: 8, outputTokens: 8, totalTokens: 16 },
    });
    expect(attempts).toEqual(["native", "json-mode", "prompt", "repair"]);
    // Prompt and repair tiers carry no response_format.
    expect(transport.bodies[2]?.response_format).toBeUndefined();
    expect(transport.bodies[3]?.response_format).toBeUndefined();
    expect(
      JSON.stringify(transport.bodies[2]?.messages).includes(
        "Return exactly one JSON value",
      ),
    ).toBe(true);
  });

  it("fails explicitly after the configured repair budget", async () => {
    const gateway = gatewayWith(async () => chat('{"ok":false}'));
    const error = await gateway
      .generateStructured(request, validateProbe, { maxRepairAttempts: 1 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StructuredOutputError);
    expect(error).toMatchObject({
      attempts: 4,
      validationIssues: ["ok must be exactly true"],
      usage: { inputTokens: 8, outputTokens: 8, totalTokens: 16 },
    });
  });

  it("keeps the repair budget capped regardless of the configured value", async () => {
    const transport = recordingFetch(
      Array.from({ length: 6 }, () => chat('{"ok":false}')),
    );
    const error = await gatewayWith(transport.fetch)
      .generateStructured(request, validateProbe, { maxRepairAttempts: 10 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StructuredOutputError);
    // native + json-mode + prompt + 3 capped repairs
    expect(error).toMatchObject({ attempts: 6 });
    expect(transport.bodies).toHaveLength(6);
  });

  it("preferPrompt still skips straight to prompt mode", async () => {
    const transport = recordingFetch([chat('{"ok":true}')]);
    const result = await gatewayWith(transport.fetch).generateStructured(
      request,
      validateProbe,
      { preferPrompt: true },
    );
    expect(result).toMatchObject({
      value: { ok: true },
      mode: "prompt",
      attempts: 1,
    });
    expect(transport.bodies[0]?.response_format).toBeUndefined();
  });

  it("skips the json-mode tier on anthropic (native → prompt)", async () => {
    const transport = recordingFetch([
      anthropic('{"ok":false}'),
      anthropic('{"ok":true}'),
    ]);
    const gateway = new ModelGateway(
      new AnthropicMessagesAdapter({
        protocol: "anthropic-messages",
        baseUrl: "https://api.anthropic.example/v1",
        apiKey: "test",
        fetch: transport.fetch,
        maxRetries: 0,
      }),
    );
    expect(gateway.supportsStructuredMode("json-mode")).toBe(false);
    const attempts: string[] = [];
    const result = await gateway.generateStructured(request, validateProbe, {
      onAttempt: (event) => attempts.push(event.mode),
    });
    expect(result).toMatchObject({
      value: { ok: true },
      mode: "prompt",
      attempts: 2,
    });
    expect(attempts).toEqual(["native", "prompt"]);
    // Native attempt used output_config.format; the prompt attempt did not.
    expect(transport.bodies[0]?.output_config).toMatchObject({
      format: { type: "json_schema" },
    });
    expect(transport.bodies[1]?.output_config).toBeUndefined();
  });
});

function gatewayWith(fetch: FetchLike): ModelGateway {
  return new ModelGateway(
    new OpenAIChatAdapter({
      protocol: "openai-chat",
      baseUrl: "https://api.example.com/v1",
      apiKey: "test",
      fetch,
      maxRetries: 0,
    }),
  );
}

function recordingFetch(queue: Response[]): {
  fetch: FetchLike;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  const fetch: FetchLike = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra request");
    return next;
  };
  return { fetch, bodies };
}

function chat(content: string): Response {
  return jsonResponse({
    id: "chat-structured",
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 2 },
  });
}

function anthropic(text: string): Response {
  return jsonResponse({
    id: "msg-structured",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 2, output_tokens: 2 },
  });
}

function validateProbe(value: unknown): ValidationResult<{ ok: true }> {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).ok === true &&
    Object.keys(value).length === 1
  ) {
    return { success: true, data: { ok: true } };
  }
  return { success: false, issues: ["ok must be exactly true"] };
}
