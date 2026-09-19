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

describe("lorebook API", () => {
  it("supports CRUD, Persona/session bindings, project guards, and versions", async () => {
    const { app } = await setup();
    const project = await createProject(app, "世界书作品");
    const otherProject = await createProject(app, "其它作品");
    const persona = await request<{ id: string; version: number }>(
      app,
      "POST",
      "/api/projects/" + project.id + "/personas",
      { kind: "character", name: "守灯人", instructions: "只说已知事实" },
      201,
    );
    const room = await request<{
      session: { id: string; version: number };
    }>(
      app,
      "POST",
      "/api/projects/" + project.id + "/cocreate/sessions",
      {
        title: "潮汐房",
        speakerPolicy: "natural",
        participantIds: [persona.id],
      },
      201,
    );
    const lorebook = await request<{ id: string; version: number }>(
      app,
      "POST",
      "/api/projects/" + project.id + "/lorebooks",
      {
        name: "潮汐规则",
        description: "非正典参考",
        enabledGlobally: false,
        scanTurns: 24,
        enabled: true,
      },
      201,
    );
    const entry = await request<{ id: string; version: number }>(
      app,
      "POST",
      "/api/lorebooks/" + lorebook.id + "/entries",
      {
        title: "盐钟",
        content: "盐钟只在退潮时走动。",
        keys: ["盐钟"],
        constant: false,
        priority: 10,
        enabled: true,
      },
      201,
    );

    const updatedBook = await request<{
      version: number;
      enabledGlobally: boolean;
    }>(
      app,
      "PUT",
      "/api/lorebooks/" + lorebook.id,
      {
        name: "潮汐规则",
        description: "项目维护的非正典参考",
        enabledGlobally: true,
        scanTurns: 16,
        enabled: true,
        expectedVersion: lorebook.version,
      },
      200,
    );
    expect(updatedBook).toMatchObject({ version: 1, enabledGlobally: true });
    const updatedEntry = await request<{ version: number; constant: boolean }>(
      app,
      "PUT",
      "/api/lore-entries/" + entry.id,
      {
        title: "盐钟",
        content: "盐钟只在退潮后的第十三分钟走动。",
        keys: [],
        constant: true,
        priority: 20,
        enabled: true,
        expectedVersion: entry.version,
      },
      200,
    );
    expect(updatedEntry).toMatchObject({ version: 1, constant: true });

    const personaBinding = await request<{
      lorebookIds: string[];
      version: number;
    }>(
      app,
      "PUT",
      "/api/personas/" + persona.id + "/lorebooks",
      { lorebookIds: [lorebook.id], expectedVersion: persona.version },
      200,
    );
    expect(personaBinding).toMatchObject({
      lorebookIds: [lorebook.id],
      version: 1,
    });
    const roomBinding = await request<{
      lorebookIds: string[];
      version: number;
    }>(
      app,
      "PUT",
      "/api/cocreate/sessions/" + room.session.id + "/lorebooks",
      { lorebookIds: [lorebook.id], expectedVersion: room.session.version },
      200,
    );
    expect(roomBinding).toMatchObject({
      lorebookIds: [lorebook.id],
      version: 1,
    });

    const otherBook = await request<{ id: string }>(
      app,
      "POST",
      "/api/projects/" + otherProject.id + "/lorebooks",
      { name: "越界世界书" },
      201,
    );
    const mismatch = await app.inject({
      method: "PUT",
      url: "/api/personas/" + persona.id + "/lorebooks",
      payload: {
        lorebookIds: [otherBook.id],
        expectedVersion: personaBinding.version,
      },
    });
    expect(mismatch.statusCode, mismatch.body).toBe(422);
    expect(mismatch.json()).toMatchObject({
      error: { code: "lorebook.project.mismatch" },
    });

    const stale = await app.inject({
      method: "PUT",
      url: "/api/lorebooks/" + lorebook.id,
      payload: {
        name: "过期修改",
        description: null,
        enabledGlobally: false,
        scanTurns: 24,
        enabled: true,
        expectedVersion: 0,
      },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({
      error: { code: "lorebook.version.conflict" },
    });

    await request(
      app,
      "DELETE",
      "/api/lore-entries/" + entry.id,
      { expectedVersion: updatedEntry.version },
      200,
    );
    await request(
      app,
      "DELETE",
      "/api/lorebooks/" + lorebook.id,
      { expectedVersion: updatedBook.version },
      200,
    );
    const books = await request<unknown[]>(
      app,
      "GET",
      "/api/projects/" + project.id + "/lorebooks",
      undefined,
      200,
    );
    expect(books).toEqual([]);
  });
});

async function setup() {
  const database = new NodeNarrativeDatabase();
  const app = await buildApp({
    config,
    database,
    environment: {
      NARRATIVE_LLM_API_KEY: "server-only-test-key",
      NARRATIVE_LLM_BASE_URL: "https://api.example.com/v1",
      NARRATIVE_LLM_MODEL: "test-model",
    },
    enableRunWorker: false,
    logger: false,
  });
  resources.push({ app, database });
  return { app };
}

async function createProject(
  app: Awaited<ReturnType<typeof buildApp>>,
  title: string,
) {
  return request<{ id: string }>(
    app,
    "POST",
    "/api/projects",
    { requestId: crypto.randomUUID(), title },
    201,
  );
}

async function request<T = unknown>(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload: Record<string, unknown> | undefined,
  expectedStatus: number,
): Promise<T> {
  const response =
    payload === undefined
      ? await app.inject({ method, url })
      : await app.inject({ method, url, payload });
  expect(response.statusCode, response.body).toBe(expectedStatus);
  return response.json() as T;
}
