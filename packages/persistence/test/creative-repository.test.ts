import {
  createDefaultPersonaCardProfile,
  createDocument,
  createProject,
  type EditProposal,
  type StoryPersona,
} from "@narralume/domain";
import { buildFoundationRecipe } from "@narralume/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeNarrativeDatabase } from "../src/node.js";
import {
  SqliteCreativeRepository,
  SqliteDocumentRepository,
  SqliteModelRepository,
  SqliteProjectRepository,
  SqliteProviderRepository,
  SqliteRunRepository,
} from "../src/index.js";

const now = "2026-08-10T00:00:00.000Z";
let database: NodeNarrativeDatabase;
let creative: SqliteCreativeRepository;

beforeEach(() => {
  database = new NodeNarrativeDatabase();
  database.migrate();
  new SqliteProjectRepository(database).insert(
    createProject({ id: "project", title: "回声邮局", now }),
  );
  new SqliteProviderRepository(database).upsert({
    id: "profile",
    name: "test",
    wireApi: "openai-responses",
    baseUrl: "https://api.example.com/v1",
    endpoint: null,
    credentialRef: "env:TEST_KEY",
    anthropicVersion: null,
    headers: {},
    queryParams: {},
    requestStartTimeoutMs: null,
    streamIdleTimeoutMs: null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  new SqliteModelRepository(database).upsert({
    id: "profile",
    providerId: "profile",
    modelId: "test-model",
    taskType: "writing",
    contextWindow: null,
    maxOutputTokens: null,
    sampling: {},
    capabilities: {},
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  creative = new SqliteCreativeRepository(database);
});

afterEach(() => database.close());

describe("SqliteCreativeRepository", () => {
  it("round-trips portable persona profiles through insert and versioned update", () => {
    const inserted = creative.insertPersona({
      ...persona("character", "portable", "沈砚"),
      profile: {
        personality: "克制而敏锐",
        scenario: "退潮后的邮局刚刚显露",
        exampleDialogue: "{{char}}：潮线不会说谎。",
        greetings: ["你终于来了。", "潮水比你先到了。"],
        creator: {
          name: "测试作者",
          notes: "安全元数据",
          version: "1.0",
          tags: ["mystery"],
        },
        source: {
          format: "character-card-v3",
          importedAt: now,
        },
      },
    });

    expect(inserted.profile).toEqual({
      personality: "克制而敏锐",
      scenario: "退潮后的邮局刚刚显露",
      exampleDialogue: "{{char}}：潮线不会说谎。",
      greetings: ["你终于来了。", "潮水比你先到了。"],
      creator: {
        name: "测试作者",
        notes: "安全元数据",
        version: "1.0",
        tags: ["mystery"],
      },
      source: { format: "character-card-v3", importedAt: now },
    });
    expect(
      JSON.parse(
        (
          database.raw
            .prepare(
              "SELECT profile_json FROM story_personas WHERE id = 'portable'",
            )
            .get() as { profile_json: string }
        ).profile_json,
      ),
    ).toEqual(inserted.profile);

    const updated = creative.updatePersona(inserted.id, {
      kind: inserted.kind,
      entityId: inserted.entityId,
      name: inserted.name,
      description: inserted.description,
      instructions: inserted.instructions,
      voice: inserted.voice,
      profile: {
        ...inserted.profile,
        greetings: ["换一个开场。"],
        creator: { ...inserted.profile.creator, version: "1.1" },
      },
      status: inserted.status,
      updatedAt: "2026-08-10T01:00:00.000Z",
      expectedVersion: inserted.version,
    });

    expect(updated.version).toBe(1);
    expect(updated.profile.greetings).toEqual(["换一个开场。"]);
    expect(updated.profile.creator.version).toBe("1.1");
    expect(creative.requirePersona(inserted.id).profile).toEqual(
      updated.profile,
    );
  });

  it("keeps personas, swipes, branches, and turn rollback recoverable", () => {
    creative.insertPersona(persona("author", "author", "作者"));
    creative.insertPersona(persona("narrator", "narrator", "旁白"));
    creative.insertPersona(persona("character", "shen", "沈砚"));
    const created = creative.createSession({
      id: "session",
      branchId: "main",
      projectId: "project",
      title: "退潮试演",
      speakerPolicy: "natural",
      targetOutlineNodeId: null,
      authorPersonaId: "author",
      directorNote: "保持克制",
      contextTurns: 24,
      participantIds: ["narrator", "shen"],
      now,
    });
    expect(created.participants).toHaveLength(2);

    const user = creative.insertTurn({
      id: "turn-user",
      sessionId: "session",
      branchId: "main",
      role: "user",
      personaId: "author",
      content: "我把空白信放到灯下。",
      now,
    });
    const first = creative.stageAssistantSwipe({
      swipeId: "swipe-1",
      newTurnId: "turn-ai",
      sessionId: "session",
      branchId: "main",
      speakerPersonaId: "shen",
      content: "纸面浮出一道潮线。",
      sourceRunId: createRun("run-1"),
      now,
    });
    const second = creative.stageAssistantSwipe({
      swipeId: "swipe-2",
      turnId: first.turn.id,
      sessionId: "session",
      branchId: "main",
      speakerPersonaId: "narrator",
      content: "盐粒先于字迹从纸背析出。",
      sourceRunId: createRun("run-2"),
      now,
    });
    expect(second.turn.selectedSwipeId).toBe("swipe-2");
    expect(creative.listSwipes("turn-ai").map((swipe) => swipe.status)).toEqual(
      ["candidate", "selected"],
    );
    creative.selectSwipe("turn-ai", "swipe-1", now);
    expect(creative.requireTurn("turn-ai").content).toContain("潮线");

    const branch = creative.createBranch({
      id: "branch-b",
      sessionId: "session",
      fromTurnId: user.id,
      name: "不拆信",
      expectedVersion: creative.requireSession("session").version,
      now,
    });
    creative.insertTurn({
      id: "turn-branch",
      sessionId: "session",
      branchId: branch.id,
      role: "director",
      personaId: null,
      content: "不要立刻拆信。",
      now,
    });
    expect(creative.listBranchTurns(branch.id).map((turn) => turn.id)).toEqual([
      "turn-user",
      "turn-branch",
    ]);
    creative.revertFromTurn("turn-branch", now);
    expect(creative.listBranchTurns(branch.id).map((turn) => turn.id)).toEqual([
      "turn-user",
    ]);
  });

  it("anchors comments and edit proposals to immutable document versions", () => {
    const documents = new SqliteDocumentRepository(database);
    documents.insert(
      createDocument({
        id: "document",
        projectId: "project",
        kind: "chapter",
        title: "第一章",
        now,
      }),
    );
    const version = documents.appendVersion("project", "document", {
      id: "version-1",
      content: "潮水退去，邮局的门第一次显露。",
      source: "manual",
      expectedCurrentVersionId: null,
      now,
    });
    const comment = creative.insertComment(
      {
        id: "comment",
        projectId: "project",
        documentId: "document",
        versionId: version.id,
        startOffset: 0,
        endOffset: 4,
        quote: "潮水退去",
        body: "这里可以更具体。",
        status: "open",
        createdAt: now,
        updatedAt: now,
      },
      version.content,
    );
    expect(comment.quote).toBe("潮水退去");
    expect(creative.setCommentStatus(comment.id, "resolved", now).status).toBe(
      "resolved",
    );

    const runId = createRun("edit-run");
    const proposal: EditProposal = {
      id: "proposal",
      projectId: "project",
      documentId: "document",
      baseVersionId: version.id,
      runId,
      instruction: "增强感官",
      selectionStart: 0,
      selectionEnd: 4,
      originalText: "潮水退去",
      replacementText: "腥咸潮水从石阶间退去",
      proposedContent: "腥咸潮水从石阶间退去，邮局的门第一次显露。",
      diff: { prefix: 0, removed: "潮水退去", added: "腥咸潮水从石阶间退去" },
      status: "proposed",
      acceptedVersionId: null,
      createdAt: now,
      decidedAt: null,
    };
    creative.insertEditProposal(proposal);
    documents.appendVersion("project", "document", {
      id: "version-2",
      content: proposal.proposedContent,
      source: "selection-ai",
      runId,
      expectedCurrentVersionId: version.id,
      now,
    });
    expect(
      creative.decideEditProposal(proposal.id, "accepted", "version-2", now),
    ).toMatchObject({ status: "accepted", acceptedVersionId: "version-2" });
  });
});

function persona(
  kind: StoryPersona["kind"],
  id: string,
  name: string,
): StoryPersona {
  return {
    id,
    projectId: "project",
    kind,
    entityId: null,
    name,
    description: null,
    instructions: "",
    voice: {},
    profile: createDefaultPersonaCardProfile(),
    status: "active",
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

function createRun(id: string): string {
  const recipe = buildFoundationRecipe(id);
  new SqliteRunRepository(database).create({
    id,
    projectId: "project",
    recipe: recipe.name,
    recipeVersion: recipe.version,
    mode: "co-create",
    targetOutlineNodeId: null,
    policy: {},
    budgetLimit: {
      maxInputTokens: 10_000,
      maxOutputTokens: 5_000,
      maxCalls: 5,
      maxCostUsd: null,
      maxWallTimeMs: 60_000,
    },
    steps: recipe.steps,
    now,
  });
  return id;
}
