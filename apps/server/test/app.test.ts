import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";

const resources: {
  app?: Awaited<ReturnType<typeof buildApp>>;
  database?: NodeNarrativeDatabase;
}[] = [];

afterEach(async () => {
  while (resources.length > 0) {
    const resource = resources.pop();
    await resource?.app?.close();
    resource?.database?.close();
  }
});

const testConfig: ServerConfig = {
  dataDirectory: ".",
  databasePath: ":memory:",
  host: "127.0.0.1",
  port: 4317,
  environment: "test",
};

async function setup(
  environmentOverrides: Readonly<Record<string, string | undefined>> = {},
) {
  const database = new NodeNarrativeDatabase();
  const environment = {
    NARRATIVE_LLM_API_KEY: "never-expose-this-secret",
    NARRATIVE_LLM_BASE_URL: "https://api.example.com/v1",
    NARRATIVE_LLM_MODEL: "example-model",
    NARRATIVE_LLM_CONTEXT_WINDOW: "128000",
    NARRATIVE_LLM_MAX_OUTPUT_TOKENS: "32000",
    ...environmentOverrides,
  };
  const app = await buildApp({
    config: testConfig,
    database,
    environment,
    logger: false,
  });
  resources.push({ app, database });
  return app;
}

describe("server API", () => {
  it("reports migration health", async () => {
    const app = await setup();
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      service: "narralume",
      database: { status: "ready", migration: 40 },
    });
  });

  it("seeds environment providers, models and a default writing assignment without returning credentials", async () => {
    const app = await setup();
    const providersResponse = await app.inject({
      method: "GET",
      url: "/api/providers",
    });
    expect(providersResponse.statusCode).toBe(200);
    const providers = providersResponse.json() as {
      id: string;
      wireApi: string;
      credentialRef: string;
    }[];
    expect(providers.map((provider) => provider.wireApi).sort()).toEqual([
      "anthropic-messages",
      "openai-chat",
      "openai-responses",
    ]);
    expect(
      providers.every(
        (provider) => provider.credentialRef === "env:NARRATIVE_LLM_API_KEY",
      ),
    ).toBe(true);
    expect(providersResponse.body).not.toContain("never-expose-this-secret");

    const modelsResponse = await app.inject({
      method: "GET",
      url: "/api/models",
    });
    expect(modelsResponse.statusCode).toBe(200);
    const models = modelsResponse.json() as {
      id: string;
      providerId: string;
      modelId: string;
      taskType: string;
      capabilities: Record<string, boolean>;
      metadataSource: string;
      metadataVerifiedAt: string | null;
    }[];
    expect(models.map((model) => model.id).sort()).toEqual([
      "environment-anthropic",
      "environment-chat",
      "environment-responses",
    ]);
    expect(models.every((model) => model.modelId === "example-model")).toBe(
      true,
    );
    expect(models.every((model) => model.taskType === "writing")).toBe(true);
    expect(
      models.every((model) => model.metadataSource === "environment"),
    ).toBe(true);
    expect(models.every((model) => model.metadataVerifiedAt !== null)).toBe(
      true,
    );
    expect(
      models.every((model) => Object.keys(model.capabilities).length === 0),
    ).toBe(true);

    const assignmentsResponse = await app.inject({
      method: "GET",
      url: "/api/assignments",
    });
    expect(assignmentsResponse.statusCode).toBe(200);
    expect(assignmentsResponse.json()).toEqual([
      expect.objectContaining({
        role: "writing",
        modelId: "environment-chat",
      }),
    ]);
  });

  it("assigns an environment generation model when physical limits are unknown", async () => {
    const app = await setup({
      NARRATIVE_LLM_CONTEXT_WINDOW: undefined,
      NARRATIVE_LLM_MAX_OUTPUT_TOKENS: undefined,
    });
    const models = (
      await app.inject({ method: "GET", url: "/api/models" })
    ).json() as Array<{
      id: string;
      contextWindow: number | null;
      maxOutputTokens: number | null;
    }>;
    expect(models).toContainEqual(
      expect.objectContaining({
        id: "environment-chat",
        contextWindow: null,
        maxOutputTokens: null,
      }),
    );
    expect(
      (await app.inject({ method: "GET", url: "/api/assignments" })).json(),
    ).toEqual([
      expect.objectContaining({
        role: "writing",
        modelId: "environment-chat",
      }),
    ]);
  });

  it("does not mirror the removed embedding environment variable into runtime configuration", async () => {
    const app = await setup({
      NARRATIVE_EMBEDDING_MODEL: "text-embedding-v4",
    });
    const modelsResponse = await app.inject({
      method: "GET",
      url: "/api/models",
    });
    expect(modelsResponse.statusCode).toBe(200);
    expect(modelsResponse.json()).not.toContainEqual(
      expect.objectContaining({ id: "environment-embedding" }),
    );

    const assignmentsResponse = await app.inject({
      method: "GET",
      url: "/api/assignments",
    });
    expect(assignmentsResponse.statusCode).toBe(200);
    expect(assignmentsResponse.json()).not.toContainEqual(
      expect.objectContaining({ role: "embedding" }),
    );
  });

  it("returns stable validation and not-found errors", async () => {
    const app = await setup();
    const invalid = await app.inject({
      method: "POST",
      url: "/api/providers/test",
      payload: {},
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: {
        code: "request.invalid",
        message: expect.stringContaining("providerId"),
      },
    });

    const missing = await app.inject({
      method: "POST",
      url: "/api/providers/test",
      payload: { providerId: "missing", modelId: "missing" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: { code: "provider.not_found" },
    });
  });

  it("does not register legacy model profile and routing endpoints", async () => {
    const app = await setup();
    const deprecatedWrites = [
      { method: "POST", url: "/api/model-profiles" },
      { method: "PUT", url: "/api/model-profiles/anything" },
      { method: "DELETE", url: "/api/model-profiles/environment-chat" },
      { method: "PUT", url: "/api/model-routing/review" },
    ] as const;
    for (const endpoint of deprecatedWrites) {
      const response = await app.inject({
        method: endpoint.method,
        url: endpoint.url,
        payload: {},
      });
      expect(response.statusCode, endpoint.url).toBe(404);
    }
    expect(
      (await app.inject({ method: "GET", url: "/api/model-profiles" }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: "/api/model-routing" }))
        .statusCode,
    ).toBe(404);
  });

  it("separates immutable harness rules from editable prompt and recipe layers", async () => {
    const app = await setup();
    const list = await app.inject({
      method: "GET",
      url: "/api/harness/templates",
    });
    expect(list.statusCode).toBe(200);
    const templates = list.json() as Array<{
      key: string;
      kind: string;
      systemInvariants: string;
      effectiveContent: string;
      version: number;
    }>;
    const draft = templates.find(
      (template) => template.key === "prompt.chapter-draft",
    )!;
    const draftInvariants = JSON.parse(draft.systemInvariants) as {
      "zh-CN": string;
      en: string;
    };
    expect(draftInvariants["zh-CN"]).toContain("锁定正典");
    expect(draftInvariants.en).toContain("locked canon wins");
    const draftDefault = JSON.parse(draft.effectiveContent) as {
      "zh-CN": string;
      en: string;
    };
    expect(draftDefault["zh-CN"]).toContain("先对抗你的本能");
    expect(draftDefault.en).toContain("Fight your instincts");
    const scenePlan = templates.find(
      (template) => template.key === "prompt.scene-plan",
    )!;
    const scenePlanDefault = JSON.parse(scenePlan.effectiveContent) as {
      "zh-CN": string;
      en: string;
    };
    expect(scenePlanDefault["zh-CN"]).toContain("情绪目标");
    expect(scenePlanDefault.en).toContain("emotional goal");
    const updated = await app.inject({
      method: "PUT",
      url: "/api/harness/templates/prompt.chapter-draft",
      payload: {
        content: "增加更多动作间的因果桥梁。",
        expectedVersion: draft.version,
      },
    });
    expect(updated.json()).toMatchObject({
      overrideContent: "增加更多动作间的因果桥梁。",
      systemInvariants: draft.systemInvariants,
    });
    const staleUpdate = await app.inject({
      method: "PUT",
      url: "/api/harness/templates/prompt.chapter-draft",
      payload: {
        content: "旧页面不应覆盖新内容。",
        expectedVersion: draft.version,
      },
    });
    expect(staleUpdate.statusCode, staleUpdate.body).toBe(409);
    expect(staleUpdate.json()).toMatchObject({
      error: { code: "harness_template.version.conflict" },
    });
    const restored = await app.inject({
      method: "POST",
      url: "/api/harness/templates/prompt.chapter-draft/restore",
      payload: { expectedVersion: updated.json().version },
    });
    expect(restored.json()).toMatchObject({ overrideContent: null });
    const cloned = await app.inject({
      method: "POST",
      url: "/api/harness/templates/recipe.chapter-production/clone",
      payload: { key: "recipe.chapter-production.fast", name: "快速章节配方" },
    });
    expect(cloned.statusCode).toBe(201);
    expect(cloned.json()).toMatchObject({
      kind: "recipe",
      clonedFromKey: "recipe.chapter-production",
    });
    const duplicateClone = await app.inject({
      method: "POST",
      url: "/api/harness/templates/recipe.chapter-production/clone",
      payload: { key: "recipe.chapter-production.fast", name: "重复键" },
    });
    expect(duplicateClone.statusCode, duplicateClone.body).toBe(409);
    expect(duplicateClone.json()).toMatchObject({
      error: { code: "harness_template.key.conflict" },
    });
    const missing = await app.inject({
      method: "PUT",
      url: "/api/harness/templates/prompt.missing",
      payload: { content: "不存在", expectedVersion: 0 },
    });
    expect(missing.statusCode, missing.body).toBe(404);
    expect(missing.json()).toMatchObject({
      error: { code: "harness_template.not_found" },
    });
  });
});
