import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";

const config: ServerConfig = {
  dataDirectory: ".",
  databasePath: ":memory:",
  host: "127.0.0.1",
  port: 4317,
  environment: "test",
};

const resources: {
  app: Awaited<ReturnType<typeof buildApp>>;
  database: NodeNarrativeDatabase;
}[] = [];

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop();
    await resource?.app.close();
    resource?.database.close();
  }
});

describe("named creative resource conflicts", () => {
  it("returns actionable conflicts for duplicate creation and rename", async () => {
    const database = new NodeNarrativeDatabase();
    const app = await buildApp({
      config,
      database,
      environment: {
        NARRATIVE_LLM_API_KEY: "server-only-test-key",
        NARRATIVE_LLM_BASE_URL: "https://api.example.com/v1",
        NARRATIVE_LLM_MODEL: "test-model",
        NARRATIVE_LLM_CONTEXT_WINDOW: "128000",
        NARRATIVE_LLM_MAX_OUTPUT_TOKENS: "32000",
      },
      enableRunWorker: false,
      logger: false,
    });
    resources.push({ app, database });

    const project = await request<{ id: string }>(
      app,
      "POST",
      "/api/projects",
      {
        requestId: globalThis.crypto.randomUUID(),
        title: "同名资源校验",
        premise: "每类创作资源都应给出明确的重名反馈。",
      },
    );

    const firstPersona = await request<VersionedResource>(
      app,
      "POST",
      `/api/projects/${project.id}/personas`,
      personaPayload("潮声旁白"),
    );
    await expectConflict(
      app,
      "POST",
      `/api/projects/${project.id}/personas`,
      personaPayload("潮声旁白"),
      "persona.name.conflict",
    );
    const secondPersona = await request<VersionedResource>(
      app,
      "POST",
      `/api/projects/${project.id}/personas`,
      personaPayload("灯塔旁白"),
    );
    await expectConflict(
      app,
      "PUT",
      `/api/personas/${secondPersona.id}`,
      {
        ...personaPayload("潮声旁白"),
        status: "active",
        expectedVersion: secondPersona.version,
      },
      "persona.name.conflict",
    );
    expect(firstPersona.version).toBe(0);

    const firstStyle = await request<VersionedResource>(
      app,
      "POST",
      `/api/projects/${project.id}/styles`,
      stylePayload("克制潮声", true),
    );
    await expectConflict(
      app,
      "POST",
      `/api/projects/${project.id}/styles`,
      stylePayload("克制潮声", true),
      "style.name.conflict",
    );
    const styles = await request<
      Array<VersionedResource & { active: boolean }>
    >(app, "GET", `/api/projects/${project.id}/styles`);
    expect(styles).toEqual([
      expect.objectContaining({ id: firstStyle.id, active: true, version: 0 }),
    ]);
    const secondStyle = await request<VersionedResource>(
      app,
      "POST",
      `/api/projects/${project.id}/styles`,
      stylePayload("灯塔冷光", false),
    );
    await expectConflict(
      app,
      "PUT",
      `/api/styles/${secondStyle.id}`,
      {
        ...stylePayload("克制潮声", false),
        status: "active",
        expectedVersion: secondStyle.version,
      },
      "style.name.conflict",
    );

    await request(
      app,
      "POST",
      `/api/projects/${project.id}/writing-skills`,
      skillPayload("不可逆场景"),
    );
    await expectConflict(
      app,
      "POST",
      `/api/projects/${project.id}/writing-skills`,
      skillPayload("不可逆场景"),
      "skill.name.conflict",
    );
    const secondSkill = await request<VersionedResource>(
      app,
      "POST",
      `/api/projects/${project.id}/writing-skills`,
      skillPayload("物证推进"),
    );
    await expectConflict(
      app,
      "PUT",
      `/api/writing-skills/${secondSkill.id}`,
      {
        ...skillPayload("不可逆场景"),
        expectedVersion: secondSkill.version,
      },
      "skill.name.conflict",
    );
  });
});

function personaPayload(name: string) {
  return {
    kind: "narrator",
    entityId: null,
    name,
    description: null,
    instructions: "只描述可观察的动作与物证。",
    voice: {},
    profile: {
      personality: null,
      scenario: null,
      exampleDialogue: null,
      greetings: [],
      creator: { name: null, notes: null, version: null, tags: [] },
      source: { format: "native", importedAt: null },
    },
  };
}

function stylePayload(name: string, active: boolean) {
  return {
    name,
    description: "让意象服从人物动作。",
    rules: ["动作先于解释"],
    examples: [],
    negativeRules: ["不替人物总结情绪"],
    active,
  };
}

function skillPayload(name: string) {
  return {
    name,
    description: "建立可检验的场景变化。",
    instructions: "场景末尾必须出现选择、发现或代价之一。",
    scopes: ["chapter"],
    priority: 80,
    enabled: true,
  };
}

async function expectConflict(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: "POST" | "PUT",
  url: string,
  payload: Record<string, unknown>,
  code: string,
) {
  const response = await app.inject({ method, url, payload });
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json()).toMatchObject({ error: { code } });
}

async function request<T = unknown>(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: "GET" | "POST",
  url: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  const response =
    payload === undefined
      ? await app.inject({ method, url })
      : await app.inject({ method, url, payload });
  expect(response.statusCode, response.body).toBe(
    method === "POST" ? 201 : 200,
  );
  return response.json() as T;
}

interface VersionedResource {
  id: string;
  version: number;
}
