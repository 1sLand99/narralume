import { createHash } from "node:crypto";

import type { NarrativeModelClient } from "@narralume/narrative";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";

const config: ServerConfig = {
  dataDirectory: ".",
  databasePath: ":memory:",
  host: "127.0.0.1",
  port: 4321,
  environment: "test",
};

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

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

describe("project backup fidelity (R8)", () => {
  it("restores every author-visible section with matching export/restore counts", async () => {
    const { app } = await setup();
    const project = await request<{ id: string; updatedAt: string }>(
      app,
      "POST",
      "/api/projects",
      {
        requestId: globalThis.crypto.randomUUID(),
        title: "全量备份样本",
        premise: "所有可见数据都应原样回来。",
      },
    );
    const projectId = project.id;

    // 封面（资料与封面同一事务提交）。
    const withCover = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}`,
      payload: {
        title: "全量备份样本",
        subtitle: null,
        premise: "所有可见数据都应原样回来。",
        archived: false,
        expectedUpdatedAt: project.updatedAt,
        cover: {
          action: "put",
          mediaType: "image/png",
          imageBase64: PNG_SIGNATURE.toString("base64"),
          width: 1200,
          height: 1800,
          crop: { x: 0.4, y: 0.55, zoom: 1.2 },
        },
      },
    });
    expect(withCover.statusCode, withCover.body).toBe(200);

    const bible = await request<{
      outline: { id: string; kind: string }[];
      documents: { id: string; kind: string }[];
    }>(app, "GET", `/api/projects/${projectId}/story-bible`, undefined, 200);
    const book = bible.outline.find((node) => node.kind === "book")!;
    const chapter = await request<{ id: string }>(
      app,
      "POST",
      `/api/projects/${projectId}/outline`,
      {
        parentId: book.id,
        kind: "chapter",
        ordinal: 0,
        title: "第一章 备份之夜",
        metadata: {},
      },
    );

    const entityA = await request<{ id: string }>(
      app,
      "POST",
      `/api/projects/${projectId}/entities`,
      { type: "character", name: "林昼", aliases: [], attributes: {} },
    );
    const entityB = await request<{ id: string }>(
      app,
      "POST",
      `/api/projects/${projectId}/entities`,
      { type: "location", name: "旧邮局", aliases: [], attributes: {} },
    );
    const fact = await request<{ fact: { id: string } }>(
      app,
      "POST",
      `/api/projects/${projectId}/facts`,
      {
        subjectId: entityA.id,
        predicate: "居住在",
        objectEntityId: entityB.id,
        knowledgeScope: "omniscient",
        authority: "confirmed",
        sourceType: "manual",
      },
    );
    expect(fact.fact.id).toBeTruthy();
    await request(app, "POST", `/api/projects/${projectId}/relationships`, {
      fromEntityId: entityA.id,
      toEntityId: entityB.id,
      relation: "守望",
      intensity: 0.8,
      state: {},
      outlineNodeId: chapter.id,
      storyTime: "第一夜",
      sourceId: null,
      supersedesEventId: null,
    });
    await request(app, "POST", `/api/projects/${projectId}/timeline`, {
      title: "灯塔熄灭",
      description: null,
      outlineNodeId: chapter.id,
      storyTimeStart: "第一夜",
      storyTimeEnd: null,
      sequence: 1,
      participants: [entityA.id],
      causes: [],
      visibility: "omniscient",
      sourceId: null,
    });
    await request(app, "POST", `/api/projects/${projectId}/foreshadows`, {
      title: "未寄出的信",
      description: "信会在灯下显名。",
      status: "planted",
      importance: 3,
      targetFromNodeId: chapter.id,
      targetToNodeId: null,
      dependencies: [],
      evidenceNodeIds: [chapter.id],
      resolutionNodeId: null,
    });

    // 正文版本 + 草稿 + 批注。
    const document = await request<{ id: string }>(
      app,
      "POST",
      `/api/projects/${projectId}/documents`,
      {
        requestId: "backup-manuscript",
        kind: "manuscript",
        title: "正文总稿",
        outlineNodeId: null,
      },
    );
    const version = await request<{ id: string; content: string }>(
      app,
      "POST",
      `/api/projects/${projectId}/documents/${document.id}/versions`,
      {
        content: "潮声越过旧邮局，灯塔在雾里熄灭。".repeat(4),
        source: "manual",
        expectedCurrentVersionId: null,
      },
    );
    await request(
      app,
      "PUT",
      `/api/projects/${projectId}/studio/documents/${document.id}/draft`,
      {
        content: "草稿：她还没有拆开那封信。",
        baseVersionId: version.id,
        expectedDraftUpdatedAt: null,
      },
      200,
    );
    await request(
      app,
      "POST",
      `/api/projects/${projectId}/studio/documents/${document.id}/comments`,
      {
        versionId: version.id,
        startOffset: 0,
        endOffset: 4,
        quote: "潮声越过",
        body: "开场意象保留。",
      },
    );

    // Persona + 共创会话（含回合）。
    const persona = await request<{ id: string }>(
      app,
      "POST",
      `/api/projects/${projectId}/personas`,
      {
        kind: "narrator",
        entityId: null,
        name: "旁白",
        description: "冷静的旁白。",
        instructions: "只说必要的话。",
        voice: {},
      },
    );
    const session = await request<{
      session: { id: string; activeBranchId: string; version: number };
    }>(app, "POST", `/api/projects/${projectId}/cocreate/sessions`, {
      title: "开场 brainstorm",
      speakerPolicy: "manual",
      targetOutlineNodeId: chapter.id,
      authorPersonaId: null,
      directorNote: null,
      contextTurns: 24,
      participantIds: [persona.id],
    });
    const mainTurn = await request<{ turn: { id: string } }>(
      app,
      "POST",
      `/api/cocreate/sessions/${session.session.id}/turns`,
      {
        requestId: "backup-turn-1",
        role: "user",
        personaId: null,
        content: "她会在第一章拆开信吗？",
        generateReply: false,
        speakerPersonaId: null,
      },
    );
    const sessionAfterTurn = await request<{
      session: { version: number };
    }>(
      app,
      "GET",
      `/api/cocreate/sessions/${session.session.id}`,
      undefined,
      200,
    );
    await request<{ id: string }>(
      app,
      "POST",
      `/api/cocreate/sessions/${session.session.id}/branches`,
      {
        fromTurnId: mainTurn.turn.id,
        name: "不拆信",
        expectedVersion: sessionAfterTurn.session.version,
      },
    );
    await request<{ turn: { id: string } }>(
      app,
      "POST",
      `/api/cocreate/sessions/${session.session.id}/turns`,
      {
        requestId: "backup-turn-2",
        role: "user",
        personaId: null,
        content: "她决定先把信藏进抽屉。",
        generateReply: false,
        speakerPersonaId: null,
      },
    );

    const lorebook = await request<{ id: string }>(
      app,
      "POST",
      "/api/projects/" + projectId + "/lorebooks",
      {
        name: "邮局世界书",
        description: "恢复后仍应保留作用域绑定。",
        enabledGlobally: true,
        scanTurns: 18,
        enabled: true,
      },
    );
    await request(app, "POST", "/api/lorebooks/" + lorebook.id + "/entries", {
      title: "灯塔潮汐",
      content: "灯塔熄灭后的第十三分钟，旧邮局会收到无名信。",
      keys: ["灯塔", "无名信"],
      constant: false,
      priority: 30,
      enabled: true,
    });
    await request(
      app,
      "PUT",
      "/api/personas/" + persona.id + "/lorebooks",
      { lorebookIds: [lorebook.id], expectedVersion: 0 },
      200,
    );
    const sessionBeforeLoreBinding = await request<{
      session: { version: number };
    }>(
      app,
      "GET",
      "/api/cocreate/sessions/" + session.session.id,
      undefined,
      200,
    );
    await request(
      app,
      "PUT",
      "/api/cocreate/sessions/" + session.session.id + "/lorebooks",
      {
        lorebookIds: [lorebook.id],
        expectedVersion: sessionBeforeLoreBinding.session.version,
      },
      200,
    );

    // 助手会话 + 消息（回复在后台推进；备份只关心消息落盘）。
    const conversation = await request<{ id: string }>(
      app,
      "POST",
      `/api/projects/${projectId}/assistant/conversations`,
      { requestId: "backup-conv-1", title: "备份协作" },
    );
    const message = await app.inject({
      method: "POST",
      url: `/api/assistant/conversations/${conversation.id}/messages`,
      payload: {
        requestId: "backup-msg-1",
        content: "帮我记住这个开场。",
        context: {
          surface: "studio",
          documentId: document.id,
          outlineNodeId: chapter.id,
          canonSpread: null,
          selection: null,
        },
      },
    });
    expect(message.statusCode, message.body).toBe(202);

    const backup = await request<{
      id: string;
      counts: Record<string, number>;
    }>(app, "POST", `/api/projects/${projectId}/backups`, {
      label: "R8 全量快照",
    });
    expect(backup.counts).toMatchObject({
      cover: 1,
      entities: 2,
      facts: 1,
      relationships: 1,
      timeline: 1,
      foreshadows: 1,
      versions: 1,
      drafts: 1,
      annotations: 1,
      personas: 1,
      lorebooks: 1,
      loreEntries: 1,
      personaLorebookBindings: 1,
      sessionLorebookBindings: 1,
      cocreateSessions: 1,
      storyTurns: 2,
      assistantConversations: 1,
      assistantMessages: 1,
    });
    expect(backup.counts.outline).toBeGreaterThanOrEqual(2);

    const restored = await request<{
      projectId: string;
      counts: Record<string, number>;
    }>(app, "POST", `/api/backups/${backup.id}/restore`, {
      requestId: "backup-restore-r8",
      title: "全量备份样本 · 校验副本",
    });
    expect(restored.projectId).not.toBe(projectId);
    // 恢复计数与导出计数逐项相等（runs 除外：只作历史，不续跑）。
    for (const [key, value] of Object.entries(backup.counts)) {
      if (key === "runs") continue;
      expect(restored.counts[key], `counts.${key}`).toBe(value);
    }

    const restoredLorebooks = await request<
      Array<{
        lorebook: { id: string; name: string; scanTurns: number };
        entries: Array<{ title: string; keys: string[] }>;
      }>
    >(
      app,
      "GET",
      "/api/projects/" + restored.projectId + "/lorebooks",
      undefined,
      200,
    );
    expect(restoredLorebooks).toMatchObject([
      {
        lorebook: { name: "邮局世界书", scanTurns: 18 },
        entries: [{ title: "灯塔潮汐", keys: ["灯塔", "无名信"] }],
      },
    ]);
    const restoredPersonas = await request<Array<{ id: string; name: string }>>(
      app,
      "GET",
      "/api/projects/" + restored.projectId + "/personas",
      undefined,
      200,
    );
    const restoredRoomList = await request<
      Array<{ id: string; title: string }>
    >(
      app,
      "GET",
      "/api/projects/" + restored.projectId + "/cocreate/sessions",
      undefined,
      200,
    );
    const restoredPersonaBinding = await request<{ lorebookIds: string[] }>(
      app,
      "GET",
      "/api/personas/" +
        restoredPersonas.find(({ name }) => name === "旁白")!.id +
        "/lorebooks",
      undefined,
      200,
    );
    const restoredSessionBinding = await request<{ lorebookIds: string[] }>(
      app,
      "GET",
      "/api/cocreate/sessions/" +
        restoredRoomList.find(({ title }) => title === "开场 brainstorm")!.id +
        "/lorebooks",
      undefined,
      200,
    );
    expect(restoredPersonaBinding.lorebookIds).toEqual([
      restoredLorebooks[0]!.lorebook.id,
    ]);
    expect(restoredSessionBinding.lorebookIds).toEqual([
      restoredLorebooks[0]!.lorebook.id,
    ]);

    // 关键引用逐项核对。
    const restoredBible = await request<{
      outline: { id: string; kind: string; title: string }[];
      entities: { id: string; name: string }[];
      facts: { subjectId: string; objectEntityId: string | null }[];
      relationships: { fromEntityId: string; toEntityId: string }[];
      timeline: { participants: string[] }[];
      foreshadows: { evidenceNodeIds: string[] }[];
      documents: { id: string; kind: string }[];
    }>(
      app,
      "GET",
      `/api/projects/${restored.projectId}/story-bible`,
      undefined,
      200,
    );
    expect(restoredBible.entities.map((item) => item.name)).toEqual(
      expect.arrayContaining(["林昼", "旧邮局"]),
    );
    const restoredEntityA = restoredBible.entities.find(
      (item) => item.name === "林昼",
    )!;
    const restoredEntityB = restoredBible.entities.find(
      (item) => item.name === "旧邮局",
    )!;
    expect(restoredBible.facts[0]).toMatchObject({
      subjectId: restoredEntityA.id,
      objectEntityId: restoredEntityB.id,
    });
    expect(restoredBible.relationships[0]).toMatchObject({
      fromEntityId: restoredEntityA.id,
      toEntityId: restoredEntityB.id,
    });
    expect(restoredBible.timeline[0]!.participants).toEqual([
      restoredEntityA.id,
    ]);
    const restoredChapter = restoredBible.outline.find(
      (node) => node.kind === "chapter",
    )!;
    expect(restoredBible.foreshadows[0]!.evidenceNodeIds).toEqual([
      restoredChapter.id,
    ]);

    const restoredCover = await app.inject({
      method: "GET",
      url: `/api/projects/${restored.projectId}/cover`,
    });
    expect(restoredCover.statusCode).toBe(200);
    expect(restoredCover.rawPayload).toEqual(PNG_SIGNATURE);

    const restoredDocument = restoredBible.documents.find(
      (item) => item.kind === "manuscript",
    )!;
    const studioDetail = await request<{
      draft: { content: string } | null;
      versions: { id: string }[];
      comments: { body: string; versionId: string }[];
    }>(
      app,
      "GET",
      `/api/projects/${restored.projectId}/studio/documents/${restoredDocument.id}`,
      undefined,
      200,
    );
    expect(studioDetail.draft?.content).toContain("她还没有拆开那封信");
    expect(studioDetail.versions).toHaveLength(1);
    expect(studioDetail.comments).toHaveLength(1);
    expect(studioDetail.comments[0]!.versionId).toBe(
      studioDetail.versions[0]!.id,
    );

    const restoredSessions = await request<
      { id: string; activeBranchId: string | null }[]
    >(
      app,
      "GET",
      `/api/projects/${restored.projectId}/cocreate/sessions`,
      undefined,
      200,
    );
    expect(restoredSessions).toHaveLength(1);
    expect(restoredSessions[0]!.activeBranchId).not.toBeNull();
    const restoredSessionDetail = await request<{
      session: { activeBranchId: string };
      branches: {
        id: string;
        parentBranchId: string | null;
        forkedFromTurnId: string | null;
        headTurnId: string | null;
        name: string;
      }[];
      turns: {
        id: string;
        content: string;
        branchId: string;
        parentTurnId: string | null;
      }[];
      participants: { personaId: string }[];
    }>(
      app,
      "GET",
      `/api/cocreate/sessions/${restoredSessions[0]!.id}`,
      undefined,
      200,
    );
    expect(restoredSessionDetail.turns.map((turn) => turn.content)).toContain(
      "她会在第一章拆开信吗？",
    );
    const restoredMainTurn = restoredSessionDetail.turns.find(
      (turn) => turn.content === "她会在第一章拆开信吗？",
    )!;
    const restoredChildTurn = restoredSessionDetail.turns.find(
      (turn) => turn.content === "她决定先把信藏进抽屉。",
    )!;
    const restoredChildBranch = restoredSessionDetail.branches.find(
      (branch) => branch.name === "不拆信",
    )!;
    expect(restoredChildBranch).toMatchObject({
      parentBranchId: restoredMainTurn.branchId,
      forkedFromTurnId: restoredMainTurn.id,
      headTurnId: restoredChildTurn.id,
    });
    expect(restoredChildTurn).toMatchObject({
      branchId: restoredChildBranch.id,
      parentTurnId: restoredMainTurn.id,
    });
    expect(restoredSessionDetail.session.activeBranchId).toBe(
      restoredChildBranch.id,
    );
    expect(restoredSessionDetail.participants).toHaveLength(1);

    const restoredConversations = await request<{ id: string }[]>(
      app,
      "GET",
      `/api/projects/${restored.projectId}/assistant/conversations`,
      undefined,
      200,
    );
    expect(restoredConversations).toHaveLength(1);
    const restoredConversation = await request<{
      messages: { content: string; role: string }[];
    }>(
      app,
      "GET",
      `/api/assistant/conversations/${restoredConversations[0]!.id}`,
      undefined,
      200,
    );
    expect(restoredConversation.messages.map((item) => item.content)).toContain(
      "帮我记住这个开场。",
    );
  });

  it("fails restore atomically when a bundle section is dropped", async () => {
    const { app, database } = await setup();
    const project = await request<{ id: string }>(
      app,
      "POST",
      "/api/projects",
      {
        requestId: globalThis.crypto.randomUUID(),
        title: "计数校验样本",
      },
    );
    const conversation = await request<{ id: string }>(
      app,
      "POST",
      `/api/projects/${project.id}/assistant/conversations`,
      { requestId: "count-conv-1", title: "计数校验" },
    );
    const backup = await request<{ id: string }>(
      app,
      "POST",
      `/api/projects/${project.id}/backups`,
      { label: "将被裁剪" },
    );
    const stored = database.raw
      .prepare("SELECT bundle_json FROM project_backups WHERE id = ?")
      .get(backup.id) as { bundle_json: string };
    const bundle = JSON.parse(stored.bundle_json) as {
      assistant: unknown[];
      manifest: { counts: Record<string, number> };
    };
    // 裁剪掉助手会话但保留 manifest 计数：恢复计数必然对不上。
    bundle.assistant = [];
    database.raw
      .prepare(
        "UPDATE project_backups SET bundle_json = ?, bundle_hash = ? WHERE id = ?",
      )
      .run(
        JSON.stringify(bundle),
        createHash("sha256").update(JSON.stringify(bundle)).digest("hex"),
        backup.id,
      );
    const response = await app.inject({
      method: "POST",
      url: `/api/backups/${backup.id}/restore`,
      payload: { requestId: "count-mismatch-restore" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "backup.restore.count_mismatch" },
    });
    // 校验失败必须整体回滚：不能留下半成品项目。
    const projects = await request<{ title: string }[]>(
      app,
      "GET",
      "/api/projects",
      undefined,
      200,
    );
    expect(
      projects.filter((item) => item.title.includes("计数校验样本 · 备份恢复")),
    ).toHaveLength(0);
    void conversation;
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
      NARRATIVE_LLM_CONTEXT_WINDOW: "128000",
      NARRATIVE_LLM_MAX_OUTPUT_TOKENS: "32000",
    },
    narrativeModelClient: backupModel(),
    enableRunWorker: false,
    logger: false,
  });
  resources.push({ app, database });
  return { app, database };
}

async function request<T = unknown>(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: "GET" | "POST" | "PUT",
  url: string,
  payload?: Record<string, unknown>,
  expected = method === "POST" ? 201 : 200,
): Promise<T> {
  const response =
    payload === undefined
      ? await app.inject({ method, url })
      : await app.inject({ method, url, payload });
  expect(response.statusCode, response.body).toBe(expected);
  return response.json() as T;
}

function backupModel(): NarrativeModelClient {
  return {
    async text() {
      return {
        text: "好的。",
        usage: {
          inputTokens: 10,
          outputTokens: 10,
          calls: 1,
          costUsd: 0,
          wallTimeMs: 1,
        },
      };
    },
    async structured(_run, _step, _purpose, _request, _contract, validate) {
      const checked = validate({
        reply: "好的，已经记下。",
        toolCall: null,
      });
      if (!checked.success) throw new Error(checked.issues.join("; "));
      return {
        value: checked.data,
        usage: {
          inputTokens: 10,
          outputTokens: 10,
          calls: 1,
          costUsd: 0,
          wallTimeMs: 1,
        },
        mode: "native",
        attempts: 1,
      };
    },
  } as NarrativeModelClient;
}
