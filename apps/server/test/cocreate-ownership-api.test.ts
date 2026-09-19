import { randomUUID } from "node:crypto";

import type { NarrativeModelClient } from "@narralume/narrative";
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

async function createChapter(
  app: App,
  projectId: string,
  title: string,
  ordinal = 0,
): Promise<string> {
  const bible = (
    await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/story-bible`,
    })
  ).json() as { outline: { id: string }[] };
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/outline`,
    payload: {
      parentId: bible.outline[0]!.id,
      kind: "chapter",
      ordinal,
      title,
      summary: `${title}的摘要。`,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { id: string }).id;
}

async function createPersona(
  app: App,
  projectId: string,
  name: string,
  kind = "narrator",
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/personas`,
    payload: { kind, name, instructions: "克制、具体" },
  });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { id: string }).id;
}

interface RoomDetail {
  session: { id: string; activeBranchId: string | null; version: number };
  turns: { id: string; role: string; status: string }[];
}

async function getRoom(app: App, sessionId: string): Promise<RoomDetail> {
  const response = await app.inject({
    method: "GET",
    url: `/api/cocreate/sessions/${sessionId}`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as RoomDetail;
}

async function createRoom(
  app: App,
  projectId: string,
  title: string,
  targetOutlineNodeId?: string,
): Promise<RoomDetail> {
  const personaId = await createPersona(app, projectId, `${title}旁白`);
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/cocreate/sessions`,
    payload: {
      title,
      speakerPolicy: "natural",
      participantIds: [personaId],
      ...(targetOutlineNodeId ? { targetOutlineNodeId } : {}),
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as RoomDetail;
}

async function postTurn(
  app: App,
  sessionId: string,
  role: string,
  content: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/api/cocreate/sessions/${sessionId}/turns`,
    payload: { requestId: randomUUID(), role, content, generateReply: false },
  });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { turn: { id: string } }).turn.id;
}

/** 只推进 adoption.prepare 一步，返回推进后的 Run 状态。 */
async function advanceOnce(app: App, projectId: string, runId: string) {
  const response = await app.inject({
    method: "POST",
    url: `/api/runs/${runId}/advance`,
    payload: { projectId },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as {
    snapshot: {
      run: { status: string };
      steps: { kind: string; status: string; error: { code: string } | null }[];
    };
  };
}

async function runStatus(app: App, projectId: string, runId: string) {
  const response = await app.inject({
    method: "GET",
    url: `/api/runs/${runId}?projectId=${projectId}`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { run: { status: string } }).run.status;
}

function scriptedModel(
  options: {
    beforeEmbed?: (purpose: string, signal: AbortSignal) => Promise<void>;
  } = {},
): NarrativeModelClient {
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
      if (purpose !== "cocreate-adoption") {
        throw new Error(`unexpected purpose ${purpose}`);
      }
      const checked = validate({
        sceneTitle: "潮痕",
        sceneContent: "盐粒从纸背析出，在灯光里连成一道潮线。",
        summary: "灯火显出信纸上的潮痕。",
        canonCandidates: [],
      });
      if (!checked.success) throw new Error(checked.issues.join("; "));
      return { value: checked.data, usage, mode: "native", attempts: 1 };
    },
    ...(options.beforeEmbed
      ? {
          hasEmbeddingAssignment: () => true,
          async embed(_run, _step, purpose, _request, signal) {
            await options.beforeEmbed!(purpose, signal);
            return {
              vectors: [[1, 0, 0]],
              model: "test-embedding",
              modelId: "test-embedding",
              usage,
            };
          },
        }
      : {}),
  } as NarrativeModelClient;
}

describe("cocreate ownership guards (M3)", () => {
  it("rejects a cocreate session targeting another project's outline node (CR-35)", async () => {
    const { app } = await setup();
    const projectA = await createProject(app, "作品A");
    const projectB = await createProject(app, "作品B");
    const chapterB = await createChapter(app, projectB, "B的章节");
    const personaA = await createPersona(app, projectA, "A旁白");

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectA}/cocreate/sessions`,
      payload: {
        title: "错配房间",
        speakerPolicy: "natural",
        participantIds: [personaA],
        targetOutlineNodeId: chapterB,
      },
    });
    expect(created.statusCode, created.body).toBe(409);
    expect(created.json()).toMatchObject({
      error: { code: "cocreate.target.mismatch" },
    });

    const room = await createRoom(app, projectA, "正常房间");
    const chapterA = await createChapter(app, projectA, "A的章节");
    const updated = await app.inject({
      method: "PUT",
      url: `/api/cocreate/sessions/${room.session.id}`,
      payload: {
        targetOutlineNodeId: chapterB,
        expectedVersion: room.session.version,
      },
    });
    expect(updated.statusCode, updated.body).toBe(409);
    expect(updated.json()).toMatchObject({
      error: { code: "cocreate.target.mismatch" },
    });
    // 同作品节点可以通过
    const accepted = await app.inject({
      method: "PUT",
      url: `/api/cocreate/sessions/${room.session.id}`,
      payload: {
        targetOutlineNodeId: chapterA,
        expectedVersion: room.session.version,
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
  });

  it("rejects adoption whose branch or turns belong to another session (CR-88)", async () => {
    const { app } = await setup();
    const projectId = await createProject(app, "同源作品");
    const roomA = await createRoom(app, projectId, "房间A");
    const roomB = await createRoom(app, projectId, "房间B");
    const turnA1 = await postTurn(app, roomA.session.id, "user", "第一段。");
    const turnA2 = await postTurn(app, roomA.session.id, "user", "第二段。");

    const crossSession = await app.inject({
      method: "POST",
      url: `/api/cocreate/sessions/${roomB.session.id}/adoptions`,
      payload: {
        requestId: "cross-session-adoption",
        branchId: roomA.session.activeBranchId,
        fromTurnId: turnA1,
        toTurnId: turnA2,
        title: "错配采纳",
      },
    });
    expect(crossSession.statusCode, crossSession.body).toBe(422);
    expect(crossSession.json()).toMatchObject({
      error: { code: "adoption.scope.mismatch" },
    });

    // 分支属于 B、回合属于 A 同样拒绝
    const mixedTurns = await app.inject({
      method: "POST",
      url: `/api/cocreate/sessions/${roomB.session.id}/adoptions`,
      payload: {
        requestId: "mixed-session-adoption",
        branchId: roomB.session.activeBranchId,
        fromTurnId: turnA1,
        toTurnId: turnA2,
        title: "错配采纳",
      },
    });
    expect(mixedTurns.statusCode, mixedTurns.body).toBe(422);
    expect(mixedTurns.json()).toMatchObject({
      error: { code: "adoption.scope.mismatch" },
    });
  });

  it("commits the adoption to the outline target snapshotted at run creation (CR-59)", async () => {
    const { app, database } = await setup();
    const projectId = await createProject(app, "快照目标");
    const chapter1 = await createChapter(app, projectId, "第一章");
    const chapter2 = await createChapter(app, projectId, "第二章", 1);
    const room = await createRoom(app, projectId, "房间", chapter1);
    const turn1 = await postTurn(app, room.session.id, "user", "起点。");
    const turn2 = await postTurn(app, room.session.id, "user", "终点。");

    const created = await app.inject({
      method: "POST",
      url: `/api/cocreate/sessions/${room.session.id}/adoptions`,
      payload: {
        requestId: "snapshot-target-adoption",
        branchId: room.session.activeBranchId,
        fromTurnId: turn1,
        toTurnId: turn2,
        title: "快照场景",
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    expect(created.json()).toMatchObject({
      origin: {
        surface: "cocreate",
        sessionId: room.session.id,
        branchId: room.session.activeBranchId,
      },
    });
    const runId = (created.json() as { run: { id: string } }).run.id;

    // Run 创建后、执行前：作者把会话目标改到第二章（模拟延迟 Worker 竞态）。
    const currentRoom = await getRoom(app, room.session.id);
    const moved = await app.inject({
      method: "PUT",
      url: `/api/cocreate/sessions/${room.session.id}`,
      payload: {
        targetOutlineNodeId: chapter2,
        expectedVersion: currentRoom.session.version,
      },
    });
    expect(moved.statusCode, moved.body).toBe(200);

    for (let index = 0; index < 10; index += 1) {
      const status = await runStatus(app, projectId, runId);
      if (status === "completed") break;
      await advanceOnce(app, projectId, runId);
    }
    expect(await runStatus(app, projectId, runId)).toBe("completed");

    const scene = database.raw
      .prepare(
        `SELECT n.parent_id AS parent FROM outline_nodes n
         JOIN scene_adoptions a ON a.outline_node_id = n.id
         WHERE a.run_id = ?`,
      )
      .get(runId) as { parent: string } | undefined;
    expect(scene?.parent).toBe(chapter1);
  });

  it("cancels a pending adoption run when its turns are reverted (CR-106)", async () => {
    const { app } = await setup();
    const projectId = await createProject(app, "撤回竞态");
    const room = await createRoom(app, projectId, "房间");
    const turn1 = await postTurn(app, room.session.id, "user", "起点。");
    const turn2 = await postTurn(app, room.session.id, "user", "终点。");

    const created = await app.inject({
      method: "POST",
      url: `/api/cocreate/sessions/${room.session.id}/adoptions`,
      payload: {
        requestId: "cancelled-adoption",
        branchId: room.session.activeBranchId,
        fromTurnId: turn1,
        toTurnId: turn2,
        title: "会被撤回的采纳",
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    const runId = (created.json() as { run: { id: string } }).run.id;

    // 推进 prepare + settle，然后撤回范围内的回合（commit 尚未执行）。
    await advanceOnce(app, projectId, runId);
    await advanceOnce(app, projectId, runId);
    const reverted = await app.inject({
      method: "POST",
      url: `/api/turns/${turn1}/actions`,
      payload: { action: "revert" },
    });
    expect(reverted.statusCode, reverted.body).toBe(200);

    // 撤回请求了取消；下一次路由把 Run 置为 cancelled，commit 不会执行。
    await advanceOnce(app, projectId, runId);
    const detail = (
      await app.inject({
        method: "GET",
        url: `/api/runs/${runId}?projectId=${projectId}`,
      })
    ).json() as {
      run: { status: string };
      result: { sceneAdoptionId: string | null };
    };
    expect(detail.run.status).toBe("cancelled");
    expect(detail.result.sceneAdoptionId).toBeNull();
  });

  it("fails adoption commit when a concurrent revert bypasses cancellation (CR-106)", async () => {
    const { app, database } = await setup();
    const projectId = await createProject(app, "撤回绕过取消");
    const room = await createRoom(app, projectId, "房间");
    const turn1 = await postTurn(app, room.session.id, "user", "起点。");
    const turn2 = await postTurn(app, room.session.id, "user", "终点。");

    const created = await app.inject({
      method: "POST",
      url: `/api/cocreate/sessions/${room.session.id}/adoptions`,
      payload: {
        requestId: "stale-source-adoption",
        branchId: room.session.activeBranchId,
        fromTurnId: turn1,
        toTurnId: turn2,
        title: "竞态采纳",
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    const runId = (created.json() as { run: { id: string } }).run.id;

    // prepare + settle 完成后，绕过路由直接撤回（模拟取消信号与 Worker
    // 提交之间的竞态：Run 已租出，取消来不及生效）。
    await advanceOnce(app, projectId, runId);
    await advanceOnce(app, projectId, runId);
    new SqliteCreativeRepository(database).revertFromTurn(
      turn1,
      new Date().toISOString(),
    );

    // commit 前 Worker 重新验证源状态：回合已撤回 → 永久失败，不写正式内容。
    let status = "";
    for (let index = 0; index < 10; index += 1) {
      status = (await advanceOnce(app, projectId, runId)).snapshot.run.status;
      if (["failed", "completed", "cancelled"].includes(status)) break;
    }
    expect(status).toBe("failed");
    const detail = (
      await app.inject({
        method: "GET",
        url: `/api/runs/${runId}?projectId=${projectId}`,
      })
    ).json() as {
      steps: { kind: string; status: string; error: { code: string } | null }[];
      result: { sceneAdoptionId: string | null };
    };
    const commit = detail.steps.find((step) => step.kind === "adoption.commit");
    expect(commit?.status).toBe("failed");
    expect(commit?.error?.code).toBe("adoption.turns.stale");
    expect(detail.result.sceneAdoptionId).toBeNull();
  });

  it("does not commit an adoption reverted while embedding is in flight (CR-106)", async () => {
    let markEmbeddingStarted!: () => void;
    const embeddingStarted = new Promise<void>((resolve) => {
      markEmbeddingStarted = resolve;
    });
    const model = scriptedModel({
      beforeEmbed: async (purpose, signal) => {
        if (purpose !== "cocreate-scene-index") return;
        markEmbeddingStarted();
        await new Promise<never>((_resolve, reject) => {
          const abort = () =>
            reject(new DOMException("adoption reverted", "AbortError"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    });
    const { app } = await setup(model);
    const projectId = await createProject(app, "Embedding 期间撤回");
    const room = await createRoom(app, projectId, "房间");
    const turn1 = await postTurn(app, room.session.id, "user", "起点");
    const turn2 = await postTurn(app, room.session.id, "user", "终点");
    const created = await app.inject({
      method: "POST",
      url: `/api/cocreate/sessions/${room.session.id}/adoptions`,
      payload: {
        requestId: "embedding-adoption",
        branchId: room.session.activeBranchId,
        fromTurnId: turn1,
        toTurnId: turn2,
        title: "不会迟到提交的采纳",
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    const runId = (created.json() as { run: { id: string } }).run.id;
    await advanceOnce(app, projectId, runId);
    await advanceOnce(app, projectId, runId);

    const committing = app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId },
    });
    await embeddingStarted;
    const reverted = await app.inject({
      method: "POST",
      url: `/api/turns/${turn1}/actions`,
      payload: { action: "revert" },
    });
    expect(reverted.statusCode, reverted.body).toBe(200);
    const interrupted = await committing;
    expect(interrupted.statusCode, interrupted.body).toBe(200);
    await advanceOnce(app, projectId, runId);

    const detail = (
      await app.inject({
        method: "GET",
        url: `/api/runs/${runId}?projectId=${projectId}`,
      })
    ).json() as {
      run: { status: string };
      result: { sceneAdoptionId: string | null };
    };
    expect(detail.run.status).toBe("cancelled");
    expect(detail.result.sceneAdoptionId).toBeNull();
  });

  it("cancels the in-flight reply run when its context turn is reverted (CR-103)", async () => {
    const { app } = await setup();
    const projectId = await createProject(app, "撤回回复");
    const room = await createRoom(app, projectId, "房间");

    const posted = await app.inject({
      method: "POST",
      url: `/api/cocreate/sessions/${room.session.id}/turns`,
      payload: {
        requestId: "reply-to-revert",
        role: "user",
        content: "写一段潮声。",
        generateReply: true,
      },
    });
    expect(posted.statusCode, posted.body).toBe(202);
    const { turn, run } = posted.json() as {
      turn: { id: string };
      run: { id: string };
    };

    const reverted = await app.inject({
      method: "POST",
      url: `/api/turns/${turn.id}/actions`,
      payload: { action: "revert" },
    });
    expect(reverted.statusCode, reverted.body).toBe(200);

    // 回复 Run 已被请求取消；推进后进入 cancelled，不再生成 AI 回合。
    await advanceOnce(app, projectId, run.id);
    expect(await runStatus(app, projectId, run.id)).toBe("cancelled");
    const after = await getRoom(app, room.session.id);
    expect(after.turns.every((item) => item.role !== "assistant")).toBe(true);
  });
});
