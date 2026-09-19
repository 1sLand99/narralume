import type { NarrativeModelClient } from "@narralume/narrative";
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

type App = Awaited<ReturnType<typeof buildApp>>;

const ENVIRONMENT = {
  NARRATIVE_LLM_API_KEY: "server-only-test-key",
  NARRATIVE_LLM_BASE_URL: "https://api.example.com/v1",
  NARRATIVE_LLM_MODEL: "test-model",
};

async function setup(model: NarrativeModelClient = scriptedModel()) {
  const database = new NodeNarrativeDatabase();
  const app = await buildApp({
    config,
    database,
    environment: ENVIRONMENT,
    narrativeModelClient: model,
    enableRunWorker: false,
    logger: false,
  });
  resources.push({ app, database });
  return { app, database };
}

async function createProject(app: App, title: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      requestId: globalThis.crypto.randomUUID(),
      title,
      premise: `${title}的前提。`,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { id: string }).id;
}

async function createPersona(
  app: App,
  projectId: string,
  name: string,
  kind: "author" | "narrator" | "character" = "narrator",
) {
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/personas`,
    payload: { kind, name, instructions: "克制、具体" },
  });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { id: string }).id;
}

async function createManualRoom(
  app: App,
  projectId: string,
  title: string,
  participantIds: string[],
) {
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/cocreate/sessions`,
    payload: { title, speakerPolicy: "manual", participantIds },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as {
    session: { id: string };
    turns: { id: string }[];
  };
}

function scriptedModel(): NarrativeModelClient {
  const usage = {
    inputTokens: 10,
    outputTokens: 10,
    calls: 1,
    costUsd: 0,
    wallTimeMs: 1,
  };
  return {
    async text() {
      return { text: "unused", usage };
    },
    async structured() {
      throw new Error("unexpected model call");
    },
  } as unknown as NarrativeModelClient;
}

describe("cocreate manual speaker guards (CR-85)", () => {
  it("rejects creating any session without AI participants", async () => {
    const { app } = await setup();
    const projectId = await createProject(app, "手动房间");

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/cocreate/sessions`,
      payload: {
        title: "零参与者",
        speakerPolicy: "manual",
        participantIds: [],
      },
    });
    expect(created.statusCode, created.body).toBe(422);
    expect(created.json()).toMatchObject({
      error: { code: "cocreate.participants.required" },
    });

    const natural = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/cocreate/sessions`,
      payload: {
        title: "自然接话房间",
        speakerPolicy: "natural",
        participantIds: [],
      },
    });
    expect(natural.statusCode, natural.body).toBe(422);
    expect(natural.json()).toMatchObject({
      error: { code: "cocreate.participants.required" },
    });
  });

  it("accepts at most eight AI participants and rejects author identities", async () => {
    const { app } = await setup();
    const projectId = await createProject(app, "参与者边界");
    const participantIds: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      participantIds.push(
        await createPersona(app, projectId, `旁白${index + 1}`),
      );
    }

    const maximum = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/cocreate/sessions`,
      payload: {
        title: "八人在场",
        speakerPolicy: "natural",
        participantIds: participantIds.slice(0, 8),
      },
    });
    expect(maximum.statusCode, maximum.body).toBe(201);

    const tooMany = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/cocreate/sessions`,
      payload: {
        title: "九人在场",
        speakerPolicy: "natural",
        participantIds,
      },
    });
    expect(tooMany.statusCode, tooMany.body).toBe(400);
    expect(tooMany.json()).toMatchObject({
      error: { code: "request.invalid" },
    });

    const authorId = await createPersona(app, projectId, "作者身份", "author");
    const authorAsAi = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/cocreate/sessions`,
      payload: {
        title: "作者冒充 AI",
        speakerPolicy: "natural",
        participantIds: [authorId],
      },
    });
    expect(authorAsAi.statusCode, authorAsAi.body).toBe(409);
    expect(authorAsAi.json()).toMatchObject({
      error: { code: "cocreate.participant.kind.invalid" },
    });
  });

  it("rejects an enabled participant impersonating the selected natural speaker", async () => {
    const modelState: { wrongSpeakerId: string; issues: string[] } = {
      wrongSpeakerId: "",
      issues: [],
    };
    const { app } = await setup(impersonatingModel(modelState));
    const projectId = await createProject(app, "发言者冒名");
    const selectedId = await createPersona(app, projectId, "潮声旁白");
    modelState.wrongSpeakerId = await createPersona(app, projectId, "门外旁白");
    const room = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/cocreate/sessions`,
      payload: {
        title: "自然接话房间",
        speakerPolicy: "natural",
        participantIds: [selectedId, modelState.wrongSpeakerId],
      },
    });
    expect(room.statusCode, room.body).toBe(201);
    const sessionId = (room.json() as { session: { id: string } }).session.id;

    const posted = await app.inject({
      method: "POST",
      url: `/api/cocreate/sessions/${sessionId}/turns`,
      payload: {
        requestId: "reject-impersonation",
        role: "user",
        content: "潮声旁白，请描述灯芯的变化。",
        generateReply: true,
        policy: { maxRetries: 0 },
      },
    });
    expect(posted.statusCode, posted.body).toBe(202);
    const created = posted.json() as {
      run: { id: string; policy: Record<string, unknown> };
    };
    expect(created.run.policy).toMatchObject({
      speakerPersonaId: selectedId,
      speakerSelectionReason: "mention",
    });

    let snapshot: {
      run: { status: string };
      steps: {
        kind: string;
        status: string;
        error: { code: string } | null;
      }[];
    } | null = null;
    for (let index = 0; index < 3; index += 1) {
      const advanced = await app.inject({
        method: "POST",
        url: `/api/runs/${created.run.id}/advance`,
        payload: { projectId },
      });
      expect(advanced.statusCode, advanced.body).toBe(200);
      snapshot = (advanced.json() as { snapshot: typeof snapshot }).snapshot;
      if (["failed", "cancelled", "completed"].includes(snapshot!.run.status)) {
        break;
      }
    }
    expect(snapshot?.run.status).toBe("failed");
    expect(
      snapshot?.steps.find((step) => step.kind === "cocreate.respond"),
    ).toMatchObject({
      status: "failed",
      error: { code: "model.structured_output" },
    });
    expect(modelState.issues.join("\n")).toContain(
      `speakerPersonaId: 本轮必须为 ${selectedId}`,
    );

    const detail = await app.inject({
      method: "GET",
      url: `/api/cocreate/sessions/${sessionId}`,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(
      (detail.json() as { turns: { role: string }[] }).turns.map(
        (turn) => turn.role,
      ),
    ).toEqual(["user"]);
  });

  it("rejects a reply-generating turn without speaker and writes nothing", async () => {
    const { app } = await setup();
    const projectId = await createProject(app, "手动发言");
    const personaId = await createPersona(app, projectId, "旁白");
    const room = await createManualRoom(app, projectId, "房间", [personaId]);

    const rejected = await app.inject({
      method: "POST",
      url: `/api/cocreate/sessions/${room.session.id}/turns`,
      payload: {
        requestId: "missing-speaker",
        role: "user",
        content: "写一段潮声。",
        generateReply: true,
      },
    });
    expect(rejected.statusCode, rejected.body).toBe(422);
    expect(rejected.json()).toMatchObject({
      error: { code: "cocreate.speaker.required" },
    });

    // 失败的请求不能写入用户回合
    const detail = await app.inject({
      method: "GET",
      url: `/api/cocreate/sessions/${room.session.id}`,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect((detail.json() as { turns: unknown[] }).turns).toHaveLength(0);

    // 显式指定发言者则正常接受
    const accepted = await app.inject({
      method: "POST",
      url: `/api/cocreate/sessions/${room.session.id}/turns`,
      payload: {
        requestId: "explicit-speaker",
        role: "user",
        content: "写一段潮声。",
        generateReply: true,
        speakerPersonaId: personaId,
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(202);
  });

  it("rejects retired participants before creating a reply run or user turn", async () => {
    const { app } = await setup();
    const projectId = await createProject(app, "退役发言者");
    const personaId = await createPersona(app, projectId, "旧旁白");
    const room = await createManualRoom(app, projectId, "旧房间", [personaId]);

    const retired = await app.inject({
      method: "PUT",
      url: `/api/personas/${personaId}`,
      payload: {
        kind: "narrator",
        entityId: null,
        name: "旧旁白",
        description: null,
        instructions: "克制、具体",
        voice: {},
        profile: nativeProfile(),
        status: "retired",
        expectedVersion: 0,
      },
    });
    expect(retired.statusCode, retired.body).toBe(200);

    const rejected = await app.inject({
      method: "POST",
      url: `/api/cocreate/sessions/${room.session.id}/turns`,
      payload: {
        requestId: "retired-speaker",
        role: "user",
        content: "继续生成。",
        generateReply: true,
        speakerPersonaId: personaId,
      },
    });
    expect(rejected.statusCode, rejected.body).toBe(422);
    expect(rejected.json()).toMatchObject({
      error: { code: "cocreate.participants.empty" },
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/cocreate/sessions/${room.session.id}`,
    });
    expect((detail.json() as { turns: unknown[] }).turns).toHaveLength(0);
  });
});

function impersonatingModel(state: {
  wrongSpeakerId: string;
  issues: string[];
}): NarrativeModelClient {
  const usage = {
    inputTokens: 10,
    outputTokens: 10,
    calls: 1,
    costUsd: 0,
    wallTimeMs: 1,
  };
  return {
    async text() {
      return { text: "unused", usage };
    },
    async structured(_run, _step, purpose, _request, _contract, validate) {
      if (purpose !== "cocreate-response") {
        throw new Error(`unexpected purpose ${purpose}`);
      }
      const checked = validate({
        speakerPersonaId: state.wrongSpeakerId,
        content: "门外旁白试图冒名接话。",
        intent: "冒充本轮发言者",
        emotionalShift: "无",
        suggestedCanonFacts: [],
      });
      if (checked.success) {
        throw new Error("The selected-speaker validator accepted an imposter");
      }
      state.issues = [...checked.issues];
      throw {
        code: "model.structured_output",
        message: "The model returned a different speaker Persona",
        retryable: false,
      };
    },
  } as NarrativeModelClient;
}

function nativeProfile() {
  return {
    personality: null,
    scenario: null,
    exampleDialogue: null,
    greetings: [],
    creator: { name: null, notes: null, version: null, tags: [] },
    source: { format: "native", importedAt: null },
  } as const;
}
