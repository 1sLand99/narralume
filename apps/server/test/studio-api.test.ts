import type { NarrativeModelClient } from "@narralume/narrative";
import { SqliteRunRepository } from "@narralume/persistence";
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

describe("studio API", () => {
  it("runs room swipes, branching, scene adoption, comments, and accepted selection diffs", async () => {
    const state = { speakerId: "" };
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
      narrativeModelClient: studioModel(state),
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
        title: "回声邮局",
        premise: "退潮时，未寄出的信会抵达记忆消失之前。",
      },
      201,
    );
    const author = await createPersona(app, project.id, {
      kind: "author",
      name: "作者",
      instructions: "只描述自己的选择",
    });
    const narrator = await createPersona(app, project.id, {
      kind: "narrator",
      name: "潮声旁白",
      instructions: "克制、具体，不替角色解释情绪",
      profile: {
        personality: "擅长从潮汐与实物变化观察人物。",
        scenario: "邮局正处在第一次退潮的夜里。",
        exampleDialogue: "灯芯向海的方向偏了偏。",
        greetings: [],
        creator: {
          name: "CREATOR_METADATA_MUST_NOT_ENTER_PROMPT",
          notes: "CREATOR_NOTES_MUST_NOT_ENTER_PROMPT",
          version: "1.0",
          tags: ["旁白"],
        },
        source: { format: "native", importedAt: null },
      },
    });
    const observer = await createPersona(app, project.id, {
      kind: "character",
      name: "守灯人",
      description: "只在门外观察潮汐。",
      instructions: "OTHER_PERSONA_PRIVATE_INSTRUCTIONS",
    });
    const lorebook = await request<{ id: string }>(
      app,
      "POST",
      "/api/projects/" + project.id + "/lorebooks",
      {
        name: "潮汐邮局世界书",
        description: "只在命中时进入共创上下文",
        enabledGlobally: false,
        scanTurns: 12,
        enabled: true,
      },
      201,
    );
    const loreEntry = await request<{ id: string }>(
      app,
      "POST",
      "/api/lorebooks/" + lorebook.id + "/entries",
      {
        title: "煤油灯规则",
        content: "WORLD_LORE_SENTINEL：煤油灯会让未寄出的信析出盐粒。",
        keys: ["煤油灯"],
        constant: false,
        priority: 80,
        enabled: true,
      },
      201,
    );
    await request(
      app,
      "PUT",
      "/api/personas/" + narrator.id + "/lorebooks",
      { lorebookIds: [lorebook.id], expectedVersion: 0 },
      200,
    );
    state.speakerId = narrator.id;

    const sessionDetail = await request<SessionDetail>(
      app,
      "POST",
      `/api/projects/${project.id}/cocreate/sessions`,
      {
        title: "第一次退潮",
        speakerPolicy: "natural",
        authorPersonaId: author.id,
        participantIds: [narrator.id, observer.id],
        directorNote: "让规则通过动作显现。",
      },
      201,
    );
    const sessionId = sessionDetail.session.id;
    const mainBranchId = sessionDetail.session.activeBranchId!;

    const posted = await request<{
      turn: { id: string; personaId: string | null };
      run: { id: string; policy: Record<string, unknown> };
      origin: { surface: string };
    }>(
      app,
      "POST",
      `/api/cocreate/sessions/${sessionId}/turns`,
      {
        requestId: "turn-main",
        role: "user",
        // A caller cannot impersonate another Persona on an author turn: the
        // room's configured author identity is authoritative.
        personaId: observer.id,
        content: "潮声旁白，沈砚把姐姐的空白信放到煤油灯上。",
        generateReply: true,
        policy: { maxRetries: 2, contextWindow: 16_000 },
      },
      202,
    );
    // The request policy is resolved into the persisted run.policy.
    expect(posted.run.policy).toMatchObject({
      maxRetries: 2,
      contextWindow: 16_000,
      qualityPreset: "standard",
      speakerPersonaId: narrator.id,
      speakerSelectionReason: "mention",
    });
    expect(posted.run.policy.speakerSelectionHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(posted.turn.personaId).toBe(author.id);
    expect(posted.origin).toMatchObject({ surface: "cocreate" });
    const replayedTurn = await request<{
      turn: { id: string };
      run: { id: string; policy: Record<string, unknown> };
    }>(
      app,
      "POST",
      `/api/cocreate/sessions/${sessionId}/turns`,
      {
        requestId: "turn-main",
        role: "user",
        personaId: observer.id,
        content: "潮声旁白，沈砚把姐姐的空白信放到煤油灯上。",
        generateReply: true,
        policy: { maxRetries: 2, contextWindow: 16_000 },
      },
      202,
    );
    expect(replayedTurn).toMatchObject({
      turn: { id: posted.turn.id },
      run: {
        id: posted.run.id,
        policy: {
          speakerPersonaId: narrator.id,
          speakerSelectionReason: "mention",
          speakerSelectionHash: posted.run.policy.speakerSelectionHash,
        },
      },
    });
    const turnConflict = await app.inject({
      method: "POST",
      url: `/api/cocreate/sessions/${sessionId}/turns`,
      payload: {
        requestId: "turn-main",
        role: "user",
        content: "同一个键不能追加第二个回合。",
        generateReply: true,
      },
    });
    expect(turnConflict.statusCode).toBe(409);
    expect(turnConflict.json()).toMatchObject({
      error: { code: "cocreate.turn.idempotency_conflict" },
    });
    expect(await finishRun(app, project.id, posted.run.id)).toBe("completed");
    const contextArtifact = new SqliteRunRepository(database)
      .getSnapshot(posted.run.id)
      .steps.find((step) => step.kind === "cocreate.context")?.outputArtifact;
    expect(contextArtifact).toMatchObject({
      expectedSpeakerId: narrator.id,
      speakerSelectionReason: "mention",
      speakerSelectionHash: posted.run.policy.speakerSelectionHash,
    });
    expect(String(contextArtifact?.context)).toContain(
      "克制、具体，不替角色解释情绪",
    );
    expect(String(contextArtifact?.context)).toContain(
      "擅长从潮汐与实物变化观察人物",
    );
    expect(String(contextArtifact?.context)).toContain("灯芯向海的方向偏了偏");
    expect(String(contextArtifact?.context)).not.toContain(
      "CREATOR_METADATA_MUST_NOT_ENTER_PROMPT",
    );
    expect(String(contextArtifact?.context)).not.toContain(
      "CREATOR_NOTES_MUST_NOT_ENTER_PROMPT",
    );
    expect(String(contextArtifact?.context)).toContain("守灯人");
    expect(String(contextArtifact?.context)).not.toContain(
      "OTHER_PERSONA_PRIVATE_INSTRUCTIONS",
    );
    expect(String(contextArtifact?.context)).toContain("WORLD_LORE_SENTINEL");
    expect(contextArtifact?.loreActivation).toMatchObject({
      includedCount: 1,
      entries: [
        {
          entryId: loreEntry.id,
          scope: "persona",
          matchedKeys: ["煤油灯"],
          contextStatus: "included",
        },
      ],
    });
    const activationArtifact = database.raw
      .prepare(
        "SELECT content_json FROM run_artifacts WHERE run_id = ? AND kind = 'lore-activation'",
      )
      .get(posted.run.id) as { content_json: string } | undefined;
    expect(JSON.parse(activationArtifact?.content_json ?? "{}")).toMatchObject({
      speakerPersonaId: narrator.id,
      decisions: [
        {
          entryId: loreEntry.id,
          status: "activated-key",
          matchedKeys: ["煤油灯"],
        },
      ],
    });
    let room = await getSession(app, sessionId);
    expect(room.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    const assistant = room.turns[1]!;
    expect(assistant.swipes).toHaveLength(1);
    expect(assistant.personaId).toBe(narrator.id);
    expect(assistant.metadata.loreActivation).toMatchObject({
      includedCount: 1,
    });

    const swipeRun = await request<{ run: { id: string } }>(
      app,
      "POST",
      `/api/turns/${assistant.id}/swipes`,
      { requestId: "swipe-second" },
      202,
    );
    const swipeReplay = await request<{ run: { id: string } }>(
      app,
      "POST",
      `/api/turns/${assistant.id}/swipes`,
      { requestId: "swipe-second" },
      202,
    );
    expect(swipeReplay.run.id).toBe(swipeRun.run.id);
    const swipeConflict = await app.inject({
      method: "POST",
      url: `/api/turns/${assistant.id}/swipes`,
      payload: {
        requestId: "swipe-second",
        speakerPersonaId: narrator.id,
      },
    });
    expect(swipeConflict.statusCode).toBe(409);
    expect(swipeConflict.json()).toMatchObject({
      error: { code: "cocreate.swipe.idempotency_conflict" },
    });
    expect(await finishRun(app, project.id, swipeRun.run.id)).toBe("completed");
    room = await getSession(app, sessionId);
    const assistantWithSwipes = room.turns[1]!;
    expect(assistantWithSwipes.swipes).toHaveLength(2);
    expect(assistantWithSwipes.selectedSwipeId).toBe(
      assistantWithSwipes.swipes[1]!.id,
    );
    await request(
      app,
      "POST",
      `/api/turns/${assistant.id}/swipe-selection`,
      { swipeId: assistantWithSwipes.swipes[0]!.id },
      200,
    );

    room = await getSession(app, sessionId);

    const branch = await request<{ id: string }>(
      app,
      "POST",
      `/api/cocreate/sessions/${sessionId}/branches`,
      {
        fromTurnId: posted.turn.id,
        name: "不拆信",
        expectedVersion: room.session.version,
      },
      201,
    );
    await request(
      app,
      "POST",
      `/api/cocreate/sessions/${sessionId}/turns`,
      {
        requestId: "turn-branch-director",
        role: "director",
        content: "先让她闻到纸上的海盐。",
        generateReply: false,
      },
      201,
    );
    room = await getSession(app, sessionId);
    expect(room.session.activeBranchId).toBe(branch.id);
    expect(room.turns.map((turn) => turn.id)).toEqual([
      posted.turn.id,
      expect.any(String),
    ]);

    await request(
      app,
      "POST",
      `/api/cocreate/sessions/${sessionId}/branch-selection`,
      { branchId: mainBranchId, expectedVersion: room.session.version },
      200,
    );
    room = await getSession(app, sessionId);
    const adoptionRun = await request<{ run: { id: string } }>(
      app,
      "POST",
      `/api/cocreate/sessions/${sessionId}/adoptions`,
      {
        requestId: "adoption-main",
        branchId: mainBranchId,
        fromTurnId: room.turns[0]!.id,
        toTurnId: room.turns[1]!.id,
        title: "灯下潮痕",
      },
      202,
    );
    const adoptionStatus = await finishRun(app, project.id, adoptionRun.run.id);
    const adoptionReplay = await request<{ run: { id: string } }>(
      app,
      "POST",
      `/api/cocreate/sessions/${sessionId}/adoptions`,
      {
        requestId: "adoption-main",
        branchId: mainBranchId,
        fromTurnId: room.turns[0]!.id,
        toTurnId: room.turns[1]!.id,
        title: "灯下潮痕",
      },
      202,
    );
    expect(adoptionReplay.run.id).toBe(adoptionRun.run.id);
    const adoptionConflict = await app.inject({
      method: "POST",
      url: `/api/cocreate/sessions/${sessionId}/adoptions`,
      payload: {
        requestId: "adoption-main",
        branchId: mainBranchId,
        fromTurnId: room.turns[0]!.id,
        toTurnId: room.turns[1]!.id,
        title: "同一个键不能换标题",
      },
    });
    expect(adoptionConflict.statusCode).toBe(409);
    expect(adoptionConflict.json()).toMatchObject({
      error: { code: "adoption.idempotency_conflict" },
    });
    const adoptionDetail = await app.inject({
      method: "GET",
      url: `/api/runs/${adoptionRun.run.id}?projectId=${project.id}`,
    });
    expect(adoptionStatus, adoptionDetail.body).toBe("completed");
    expect(adoptionDetail.json()).toMatchObject({
      origin: { surface: "cocreate" },
      result: {
        sceneAdoptionId: `${adoptionRun.run.id}:adoption`,
        documentId: `${adoptionRun.run.id}:scene-document`,
        canonChangeSetId: `${adoptionRun.run.id}:canon-change-set`,
      },
    });
    room = await getSession(app, sessionId);
    expect(room.adoptions).toHaveLength(1);
    expect(room.turns.every((turn) => turn.status === "adopted")).toBe(true);

    const adoption = room.adoptions[0]!;
    let document = await request<StudioDocument>(
      app,
      "GET",
      `/api/projects/${project.id}/studio/documents/${adoption.documentId}`,
      undefined,
      200,
    );
    expect(document.currentVersion?.content).toContain("盐粒");
    const autosavedDraft = await request<{
      baseVersionId: string | null;
      content: string;
      contentHash: string;
    }>(
      app,
      "PUT",
      `/api/projects/${project.id}/studio/documents/${adoption.documentId}/draft`,
      {
        baseVersionId: document.currentVersion!.id,
        expectedDraftUpdatedAt: null,
        content: `${document.currentVersion!.content}\n这是一段尚未发布的草稿。`,
      },
      200,
    );
    expect(autosavedDraft).toMatchObject({
      baseVersionId: document.currentVersion!.id,
    });
    expect(autosavedDraft.contentHash).toMatch(/^[a-f0-9]{64}$/);
    document = await request<StudioDocument>(
      app,
      "GET",
      `/api/projects/${project.id}/studio/documents/${adoption.documentId}`,
      undefined,
      200,
    );
    expect(document.draft?.content).toContain("尚未发布的草稿");
    expect(document.versions).toHaveLength(1);
    const selectionStart = autosavedDraft.content.indexOf("盐粒");
    const selectionEnd = selectionStart + 2;
    const comment = await request<{ id: string; status: string }>(
      app,
      "POST",
      `/api/projects/${project.id}/studio/documents/${adoption.documentId}/comments`,
      {
        versionId: document.currentVersion!.id,
        startOffset: selectionStart,
        endOffset: selectionEnd,
        quote: "盐粒",
        body: "把触感写得更清楚。",
      },
      201,
    );
    expect(comment.status).toBe("open");
    expect(
      await request<{ status: string }>(
        app,
        "PUT",
        `/api/studio/comments/${comment.id}`,
        { status: "resolved" },
        200,
      ),
    ).toMatchObject({ status: "resolved" });

    const editRun = await request<{
      run: { id: string; policy: Record<string, unknown> };
      origin: {
        surface: string;
        documentId: string;
        selection: { start: number; end: number };
      };
    }>(
      app,
      "POST",
      `/api/projects/${project.id}/studio/documents/${adoption.documentId}/selection-edits`,
      {
        baseVersionId: document.currentVersion!.id,
        draftContentHash: autosavedDraft.contentHash,
        selectionStart,
        selectionEnd,
        instruction: "增强触觉，但不改变事实。",
        policy: { maxRetries: 0 },
      },
      202,
    );
    expect(editRun.run.policy).toMatchObject({
      maxRetries: 0,
      qualityPreset: "standard",
    });
    expect(editRun.origin).toEqual({
      surface: "writing",
      documentId: adoption.documentId,
      selection: { start: selectionStart, end: selectionEnd },
    });
    expect(await finishRun(app, project.id, editRun.run.id)).toBe("completed");
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/runs/${editRun.run.id}?projectId=${project.id}`,
        })
      ).json(),
    ).toMatchObject({
      result: { editProposalId: `${editRun.run.id}:proposal` },
    });
    document = await request<StudioDocument>(
      app,
      "GET",
      `/api/projects/${project.id}/studio/documents/${adoption.documentId}`,
      undefined,
      200,
    );
    expect(document.proposals[0]).toMatchObject({ status: "proposed" });
    const accepted = await request<{
      status: string;
      acceptedVersionId: string;
    }>(
      app,
      "POST",
      `/api/studio/edit-proposals/${document.proposals[0]!.id}/actions`,
      {
        action: "accept",
        requestId: `${document.proposals[0]!.id}:accept`,
      },
      200,
    );
    expect(accepted.status).toBe("accepted");
    const replayed = await request<{
      status: string;
      acceptedVersionId: string;
    }>(
      app,
      "POST",
      `/api/studio/edit-proposals/${document.proposals[0]!.id}/actions`,
      {
        action: "accept",
        requestId: `${document.proposals[0]!.id}:accept`,
      },
      200,
    );
    expect(replayed).toEqual(accepted);
    const conflicting = await app.inject({
      method: "POST",
      url: `/api/studio/edit-proposals/${document.proposals[0]!.id}/actions`,
      payload: {
        action: "reject",
        requestId: `${document.proposals[0]!.id}:reject`,
      },
    });
    expect(conflicting.statusCode, conflicting.body).toBe(409);
    expect(conflicting.json()).toMatchObject({
      error: { code: "edit_proposal.already_decided" },
    });
    document = await request<StudioDocument>(
      app,
      "GET",
      `/api/projects/${project.id}/studio/documents/${adoption.documentId}`,
      undefined,
      200,
    );
    expect(document.versions).toHaveLength(3);
    expect(document.currentVersion?.content).toContain("粗粝盐粒");
    expect(document.currentVersion?.content).toContain("尚未发布的草稿");
  });
});

async function createPersona(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
  input: Record<string, unknown>,
) {
  return request<{ id: string }>(
    app,
    "POST",
    `/api/projects/${projectId}/personas`,
    input,
    201,
  );
}

async function finishRun(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
  runId: string,
) {
  let status = "pending";
  for (let index = 0; index < 40; index += 1) {
    const response = await request<{ snapshot: { run: { status: string } } }>(
      app,
      "POST",
      `/api/runs/${runId}/advance`,
      { projectId },
      200,
    );
    status = response.snapshot.run.status;
    if (
      ["completed", "failed", "cancelled", "awaiting_user"].includes(status)
    ) {
      break;
    }
  }
  return status;
}

function getSession(
  app: Awaited<ReturnType<typeof buildApp>>,
  sessionId: string,
) {
  return request<SessionDetail>(
    app,
    "GET",
    `/api/cocreate/sessions/${sessionId}`,
    undefined,
    200,
  );
}

async function request<T = unknown>(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: "GET" | "POST" | "PUT",
  url: string,
  payload: Record<string, unknown> | undefined,
  expected: number,
): Promise<T> {
  const response =
    payload === undefined
      ? await app.inject({ method, url })
      : await app.inject({ method, url, payload });
  expect(response.statusCode, response.body).toBe(expected);
  return response.json() as T;
}

function studioModel(state: { speakerId: string }): NarrativeModelClient {
  const usage = {
    inputTokens: 100,
    outputTokens: 100,
    calls: 1,
    costUsd: 0,
    wallTimeMs: 5,
  };
  let swipe = 0;
  return {
    async text() {
      return { text: "unused", usage };
    },
    async structured(_run, _step, purpose, _request, _contract, validate) {
      let value: unknown;
      if (purpose === "cocreate-response") {
        swipe += 1;
        value = {
          speakerPersonaId: state.speakerId,
          content:
            swipe === 1
              ? "盐粒从纸背析出，在灯光里连成一道潮线。"
              : "纸页先变得冰冷，随后浮出姐姐失踪那晚的潮时。",
          intent: "让超自然规则通过物理变化显现",
          emotionalShift: "好奇转为警觉",
          suggestedCanonFacts: [],
        };
      } else if (purpose === "cocreate-adoption") {
        value = {
          sceneTitle: "灯下潮痕",
          sceneContent:
            "沈砚把空白信移到煤油灯上方。盐粒从纸背析出，在灯光里连成一道潮线。她没有立刻拆开信封，只用指腹触了触边缘。",
          summary: "沈砚用灯火显出信纸上的潮痕，并选择先观察规则。",
          canonCandidates: [
            {
              subjectName: "空白信",
              predicate: "受热反应",
              value: "析出盐粒并形成潮线",
              evidenceParagraphs: [1],
              rationale: "正文直接呈现可复验现象",
            },
          ],
        };
      } else if (purpose === "selection-edit") {
        value = {
          replacementText: "粗粝盐粒",
          rationale: "增加触觉而不改变物体与动作",
          risk: "low",
        };
      } else {
        throw new Error(`unexpected purpose ${purpose}`);
      }
      const checked = validate(value);
      if (!checked.success) throw new Error(checked.issues.join("; "));
      return { value: checked.data, usage, mode: "native", attempts: 1 };
    },
  } as NarrativeModelClient;
}

interface SessionDetail {
  session: { id: string; activeBranchId: string | null; version: number };
  turns: {
    id: string;
    role: string;
    personaId: string | null;
    status: string;
    selectedSwipeId: string | null;
    metadata: Record<string, unknown>;
    swipes: { id: string }[];
  }[];
  adoptions: {
    documentId: string;
  }[];
}

interface StudioDocument {
  currentVersion: { id: string; content: string } | null;
  draft: { content: string; baseVersionId: string | null } | null;
  versions: unknown[];
  proposals: { id: string; status: string }[];
}
