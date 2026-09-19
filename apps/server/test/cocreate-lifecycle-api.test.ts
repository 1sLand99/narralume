import { SqliteCreativeRepository } from "@narralume/persistence";
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

describe("cocreate lifecycle boundary", () => {
  it.each(["paused", "archived"] as const)(
    "keeps a %s session read-only and starts no background work (CR-63)",
    async (status) => {
      const { app, database } = await setup();
      const project = await inject<{ id: string }>(
        app,
        "POST",
        "/api/projects",
        {
          requestId: globalThis.crypto.randomUUID(),
          title: `共创${status}`,
        },
        201,
      );
      const persona = await inject<{ id: string }>(
        app,
        "POST",
        `/api/projects/${project.id}/personas`,
        {
          kind: "narrator",
          name: "潮声旁白",
          instructions: "克制、具体",
        },
        201,
      );
      const room = await inject<RoomDetail>(
        app,
        "POST",
        `/api/projects/${project.id}/cocreate/sessions`,
        {
          title: "灯下故事房",
          speakerPolicy: "natural",
          participantIds: [persona.id],
        },
        201,
      );
      const userTurn = await inject<{ turn: { id: string } }>(
        app,
        "POST",
        `/api/cocreate/sessions/${room.session.id}/turns`,
        {
          requestId: `${status}-user-turn`,
          role: "user",
          content: "沈砚把信放在灯下。",
          generateReply: false,
        },
        201,
      );
      const assistantTurn = new SqliteCreativeRepository(database).insertTurn({
        id: `${status}-assistant-turn`,
        sessionId: room.session.id,
        branchId: room.session.activeBranchId,
        role: "assistant",
        personaId: persona.id,
        content: "纸面浮出一层盐粒。",
        now: new Date().toISOString(),
      });
      let current = await getRoom(app, room.session.id);
      const branch = await inject<{ id: string }>(
        app,
        "POST",
        `/api/cocreate/sessions/${room.session.id}/branches`,
        {
          fromTurnId: userTurn.turn.id,
          name: "不拆信",
          expectedVersion: current.session.version,
        },
        201,
      );
      current = await getRoom(app, room.session.id);
      const inactive = await inject<{ version: number }>(
        app,
        "PUT",
        `/api/cocreate/sessions/${room.session.id}`,
        { status, expectedVersion: current.session.version },
        200,
      );

      await expectInactive(
        app,
        "PUT",
        `/api/cocreate/sessions/${room.session.id}/participants`,
        {
          expectedVersion: inactive.version,
          participants: [
            { personaId: persona.id, enabled: true, talkativeness: 0.5 },
          ],
        },
      );
      await expectInactive(
        app,
        "POST",
        `/api/turns/${assistantTurn.id}/swipes`,
        { requestId: `${status}-swipe` },
      );
      await expectInactive(
        app,
        "POST",
        `/api/turns/${assistantTurn.id}/actions`,
        { action: "revert" },
      );
      await expectInactive(
        app,
        "POST",
        `/api/cocreate/sessions/${room.session.id}/branches`,
        {
          fromTurnId: userTurn.turn.id,
          name: "暂停后分支",
          expectedVersion: inactive.version,
        },
      );
      await expectInactive(
        app,
        "POST",
        `/api/cocreate/sessions/${room.session.id}/branch-selection`,
        {
          branchId: room.session.activeBranchId,
          expectedVersion: inactive.version,
        },
      );
      await expectInactive(
        app,
        "POST",
        `/api/cocreate/sessions/${room.session.id}/adoptions`,
        {
          requestId: `${status}-adoption`,
          branchId: room.session.activeBranchId,
          fromTurnId: userTurn.turn.id,
          toTurnId: assistantTurn.id,
          title: "不应创建的正式场景",
        },
      );

      const after = await getRoom(app, room.session.id);
      expect(after.session).toMatchObject({
        status,
        version: inactive.version,
      });
      expect(after.branches.map((item) => item.id)).toEqual(
        expect.arrayContaining([room.session.activeBranchId, branch.id]),
      );
      expect(after.turns.every((turn) => turn.status === "active")).toBe(true);
      const runs = await inject<unknown[]>(
        app,
        "GET",
        `/api/projects/${project.id}/runs`,
        undefined,
        200,
      );
      expect(runs).toEqual([]);
    },
  );

  it("rejects new AI work before persisting changes when the writing model is unavailable (CR-58)", async () => {
    const { app, database } = await setup();
    const project = await inject<{ id: string }>(
      app,
      "POST",
      "/api/projects",
      {
        requestId: globalThis.crypto.randomUUID(),
        title: "共创模型门禁",
      },
      201,
    );
    const bible = await inject<{ outline: { id: string }[] }>(
      app,
      "GET",
      `/api/projects/${project.id}/story-bible`,
      undefined,
      200,
    );
    const chapter = await inject<{ id: string }>(
      app,
      "POST",
      `/api/projects/${project.id}/outline`,
      {
        parentId: bible.outline[0]!.id,
        kind: "chapter",
        ordinal: 0,
        title: "雨夜追逐",
        summary: "沈砚追查匿名信的来源。",
      },
      201,
    );
    const persona = await inject<{ id: string }>(
      app,
      "POST",
      `/api/projects/${project.id}/personas`,
      {
        kind: "narrator",
        name: "雨夜旁白",
        instructions: "只写可观察的动作。",
      },
      201,
    );
    const room = await inject<RoomDetail>(
      app,
      "POST",
      `/api/projects/${project.id}/cocreate/sessions`,
      {
        title: "雨夜故事房",
        speakerPolicy: "natural",
        targetOutlineNodeId: chapter.id,
        participantIds: [persona.id],
      },
      201,
    );
    const userTurn = await inject<{ turn: { id: string } }>(
      app,
      "POST",
      `/api/cocreate/sessions/${room.session.id}/turns`,
      {
        requestId: "model-gate-user-turn",
        role: "user",
        content: "沈砚冲进雨幕。",
        generateReply: false,
      },
      201,
    );
    const assistantTurn = new SqliteCreativeRepository(database).insertTurn({
      id: "model-gate-assistant-turn",
      sessionId: room.session.id,
      branchId: room.session.activeBranchId,
      role: "assistant",
      personaId: persona.id,
      content: "路灯在积水里断成三截。",
      now: new Date().toISOString(),
    });
    database.raw
      .prepare("DELETE FROM model_assignments WHERE role = 'writing'")
      .run();

    await expectModelUnavailable(
      app,
      `/api/cocreate/sessions/${room.session.id}/turns`,
      {
        requestId: "model-gate-ai-turn",
        role: "user",
        content: "让她追上送信人。",
        generateReply: true,
      },
    );
    await expectModelUnavailable(app, `/api/turns/${assistantTurn.id}/swipes`, {
      requestId: "model-gate-swipe",
    });
    await expectModelUnavailable(
      app,
      `/api/cocreate/sessions/${room.session.id}/adoptions`,
      {
        requestId: "model-gate-adoption",
        branchId: room.session.activeBranchId,
        fromTurnId: userTurn.turn.id,
        toTurnId: assistantTurn.id,
        title: "不应创建的正式场景",
      },
    );

    const after = await getRoom(app, room.session.id);
    expect(after.turns.map((turn) => turn.id)).toEqual([
      userTurn.turn.id,
      assistantTurn.id,
    ]);
    const runs = await inject<unknown[]>(
      app,
      "GET",
      `/api/projects/${project.id}/runs`,
      undefined,
      200,
    );
    expect(runs).toEqual([]);
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

async function getRoom(
  app: Awaited<ReturnType<typeof buildApp>>,
  sessionId: string,
) {
  return inject<RoomDetail>(
    app,
    "GET",
    `/api/cocreate/sessions/${sessionId}`,
    undefined,
    200,
  );
}

async function expectInactive(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: "POST" | "PUT",
  url: string,
  payload: Record<string, unknown>,
) {
  const response = await app.inject({ method, url, payload });
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json()).toMatchObject({
    error: { code: "cocreate.session.inactive" },
  });
}

async function expectModelUnavailable(
  app: Awaited<ReturnType<typeof buildApp>>,
  url: string,
  payload: Record<string, unknown>,
) {
  const response = await app.inject({ method: "POST", url, payload });
  expect(response.statusCode, response.body).toBe(422);
  expect(response.json()).toMatchObject({
    error: { code: "model.assignment.unavailable" },
  });
}

async function inject<T>(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: "GET" | "POST" | "PUT",
  url: string,
  payload: Record<string, unknown> | undefined,
  expected: number,
): Promise<T> {
  const response = await app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
  });
  expect(response.statusCode, response.body).toBe(expected);
  return response.json() as T;
}

interface RoomDetail {
  session: {
    id: string;
    status: string;
    activeBranchId: string;
    version: number;
  };
  branches: { id: string }[];
  turns: { id: string; status: string }[];
}
