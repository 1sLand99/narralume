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

describe("cocreate optimistic concurrency (CR-27)", () => {
  it("rejects stale persona, session, participant, and branch writes", async () => {
    const { app } = await setup();
    const project = await inject<{ id: string }>(app, "POST", "/api/projects", {
      requestId: globalThis.crypto.randomUUID(),
      title: "并发故事房",
      premise: "两个页面同时编辑同一故事房。",
    });
    const narrator = await createPersona(app, project.id, "旁白");
    const character = await createPersona(app, project.id, "沈砚");

    const updatedPersona = await inject<Persona>(
      app,
      "PUT",
      `/api/personas/${narrator.id}`,
      {
        ...personaPatch(narrator),
        name: "潮声旁白",
        expectedVersion: narrator.version,
      },
    );
    expect(updatedPersona).toMatchObject({ name: "潮声旁白", version: 1 });
    await expectConflict(
      app,
      "PUT",
      `/api/personas/${narrator.id}`,
      {
        ...personaPatch(narrator),
        name: "旧页面旁白",
        expectedVersion: narrator.version,
      },
      "persona.version.conflict",
    );

    const room = await inject<RoomDetail>(
      app,
      "POST",
      `/api/projects/${project.id}/cocreate/sessions`,
      {
        title: "第一现场",
        speakerPolicy: "natural",
        participantIds: [narrator.id],
      },
    );
    const renamed = await inject<Session>(
      app,
      "PUT",
      `/api/cocreate/sessions/${room.session.id}`,
      {
        title: "灯下现场",
        expectedVersion: room.session.version,
      },
    );
    expect(renamed).toMatchObject({ title: "灯下现场", version: 1 });
    await expectConflict(
      app,
      "PUT",
      `/api/cocreate/sessions/${room.session.id}/participants`,
      {
        expectedVersion: room.session.version,
        participants: [participant(character.id)],
      },
      "cocreate.session.version.conflict",
    );

    const participantsUpdated = await inject<RoomDetail>(
      app,
      "PUT",
      `/api/cocreate/sessions/${room.session.id}/participants`,
      {
        expectedVersion: renamed.version,
        participants: [participant(narrator.id), participant(character.id)],
      },
    );
    expect(participantsUpdated.session.version).toBe(2);
    expect(
      participantsUpdated.participants.map((value) => value.personaId),
    ).toEqual([narrator.id, character.id]);

    const turn = await inject<{ turn: { id: string } }>(
      app,
      "POST",
      `/api/cocreate/sessions/${room.session.id}/turns`,
      {
        requestId: "concurrency-turn",
        role: "user",
        content: "沈砚把信放在灯下。",
        generateReply: false,
      },
    );

    await expectConflict(
      app,
      "POST",
      `/api/cocreate/sessions/${room.session.id}/branches`,
      {
        fromTurnId: turn.turn.id,
        name: "旧页面分支",
        expectedVersion: participantsUpdated.session.version,
      },
      "cocreate.session.version.conflict",
    );
    const beforeBranch = await getRoom(app, room.session.id);
    const branch = await inject<{ id: string }>(
      app,
      "POST",
      `/api/cocreate/sessions/${room.session.id}/branches`,
      {
        fromTurnId: turn.turn.id,
        name: "不拆信",
        expectedVersion: beforeBranch.session.version,
      },
    );
    let detail = await getRoom(app, room.session.id);
    expect(detail).toMatchObject({
      session: { activeBranchId: branch.id, version: 4 },
    });
    expect(detail.branches).toHaveLength(2);

    await expectConflict(
      app,
      "POST",
      `/api/cocreate/sessions/${room.session.id}/branch-selection`,
      {
        branchId: room.session.activeBranchId,
        expectedVersion: beforeBranch.session.version,
      },
      "cocreate.session.version.conflict",
    );
    detail = await getRoom(app, room.session.id);
    expect(detail.session.activeBranchId).toBe(branch.id);

    const selected = await inject<RoomDetail>(
      app,
      "POST",
      `/api/cocreate/sessions/${room.session.id}/branch-selection`,
      {
        branchId: room.session.activeBranchId,
        expectedVersion: detail.session.version,
      },
    );
    expect(selected.session).toMatchObject({
      activeBranchId: room.session.activeBranchId,
      version: 5,
    });

    const personas = await inject<Persona[]>(
      app,
      "GET",
      `/api/projects/${project.id}/personas`,
    );
    expect(personas.find((value) => value.id === narrator.id)).toMatchObject({
      name: "潮声旁白",
      version: 1,
    });
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
  return { app, database };
}

async function createPersona(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
  name: string,
) {
  return inject<Persona>(app, "POST", `/api/projects/${projectId}/personas`, {
    kind: "character",
    name,
    instructions: `${name}的行为约束`,
  });
}

function personaPatch(persona: Persona) {
  return {
    kind: persona.kind,
    entityId: null,
    name: persona.name,
    description: null,
    instructions: persona.instructions,
    voice: {},
    profile: persona.profile,
    status: "active",
  };
}

function participant(personaId: string) {
  return { personaId, enabled: true, talkativeness: 0.5 };
}

function getRoom(app: Awaited<ReturnType<typeof buildApp>>, sessionId: string) {
  return inject<RoomDetail>(app, "GET", `/api/cocreate/sessions/${sessionId}`);
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

async function inject<T>(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: "GET" | "POST" | "PUT",
  url: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  const response = await app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
  });
  expect(response.statusCode, response.body).toBe(
    method === "POST" && (url === "/api/projects" || url.endsWith("/personas"))
      ? 201
      : method === "POST" && url.endsWith("/sessions")
        ? 201
        : method === "POST" && url.endsWith("/turns")
          ? 201
          : method === "POST" && url.endsWith("/branches")
            ? 201
            : 200,
  );
  return response.json() as T;
}

interface Persona {
  id: string;
  kind: "author" | "narrator" | "character";
  name: string;
  instructions: string;
  profile: Record<string, unknown>;
  version: number;
}

interface Session {
  id: string;
  title: string;
  activeBranchId: string;
  version: number;
}

interface RoomDetail {
  session: Session;
  participants: { personaId: string }[];
  branches: { id: string }[];
}
