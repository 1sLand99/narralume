import { buildChapterRecipe } from "@narralume/harness";
import type { NarrativeModelClient } from "@narralume/narrative";
import {
  SqliteReviewRepository,
  SqliteRunRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

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

describe("review workspace API", () => {
  it("resumes a chapter immediately after its story changes are rejected", async () => {
    const database = new NodeNarrativeDatabase();
    const app = await buildApp({
      database,
      environment: {},
      enableRunWorker: false,
      logger: false,
      config: {
        dataDirectory: ".",
        databasePath: ":memory:",
        host: "127.0.0.1",
        port: 4317,
        environment: "test",
      },
    });
    resources.push({ app, database });
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          requestId: "settlement-decision-project",
          title: "结算裁定样本",
          premise: "一章正文带来待裁定变化。",
        },
      })
    ).json() as { id: string };
    const bible = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/story-bible`,
      })
    ).json() as { outline: Array<{ id: string; kind: string }> };
    const chapter = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/outline`,
        payload: {
          parentId: bible.outline.find((node) => node.kind === "book")!.id,
          kind: "chapter",
          ordinal: 0,
          title: "潮痕",
          summary: "潮水留下新的线索。",
          goal: "确认线索真假",
        },
      })
    ).json() as { id: string };
    const runs = new SqliteRunRepository(database);
    const recipe = buildChapterRecipe("run-settlement-decision", 0);
    runs.create({
      id: "run-settlement-decision",
      projectId: project.id,
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "manual",
      targetOutlineNodeId: chapter.id,
      policy: {},
      budgetLimit: {
        maxInputTokens: 10_000,
        maxOutputTokens: 10_000,
        maxCalls: 10,
        maxCostUsd: null,
        maxWallTimeMs: 60_000,
      },
      steps: recipe.steps,
      now: "2026-08-19T00:00:00.000Z",
    });
    runs.setRunStatus(
      "run-settlement-decision",
      "awaiting_user",
      "2026-08-19T00:01:00.000Z",
      "settlement_conflict_requires_resolution",
    );
    new SqliteReviewRepository(database).insertCanonChangeSet({
      id: "change-set-resume",
      projectId: project.id,
      runId: "run-settlement-decision",
      stepId: `${recipe.steps.at(-1)!.id}`,
      changes: {},
      status: "candidate",
      createdAt: "2026-08-19T00:01:00.000Z",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/canon-change-sets/change-set-resume/decisions`,
      payload: {
        requestId: "change-set-resume:reject:reject",
        action: "reject",
        expectedStatus: "candidate",
        conflictPolicy: "reject",
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(runs.getSnapshot("run-settlement-decision").run).toMatchObject({
      status: "running",
      policy: { settlementConflictResolved: true },
    });
    const updatedBible = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/story-bible`,
      })
    ).json() as { outline: Array<{ id: string; status: string }> };
    expect(
      updatedBible.outline.find((node) => node.id === chapter.id)?.status,
    ).toBe("committed");
  });

  it("reviews the exact current chapter version without rewriting it", async () => {
    const database = new NodeNarrativeDatabase();
    const app = await buildApp({
      database,
      environment: {
        NARRATIVE_LLM_API_KEY: "server-only-test-key",
        NARRATIVE_LLM_BASE_URL: "https://api.example.com/v1",
        NARRATIVE_LLM_MODEL: "test-model",
        NARRATIVE_LLM_CONTEXT_WINDOW: "128000",
        NARRATIVE_LLM_MAX_OUTPUT_TOKENS: "32000",
      },
      narrativeModelClient: reviewModel(),
      enableRunWorker: false,
      logger: false,
      config: {
        dataDirectory: ".",
        databasePath: ":memory:",
        host: "127.0.0.1",
        port: 4317,
        environment: "test",
      },
    });
    resources.push({ app, database });
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          requestId: "document-review-project",
          title: "审稿样本",
          premise: "潮水抹去一段记忆。",
        },
      })
    ).json() as { id: string };
    const bible = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/story-bible`,
      })
    ).json() as { outline: Array<{ id: string; kind: string }> };
    const chapter = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/outline`,
        payload: {
          parentId: bible.outline.find((node) => node.kind === "book")!.id,
          kind: "chapter",
          ordinal: 0,
          title: "雾港失灯",
          summary: "林昼在灯塔发现遗忘规则。",
          goal: "确认熄灯的代价",
        },
      })
    ).json() as { id: string };
    const document = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/documents`,
        payload: {
          requestId: "document-review-document",
          kind: "chapter",
          title: "雾港失灯",
          outlineNodeId: chapter.id,
        },
      })
    ).json() as { id: string };
    const manuscript =
      "林昼推开灯塔的门。\n\n第三声钟响后，港口同时忘记了守灯人的名字。";
    const versionResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/documents/${document.id}/versions`,
      payload: {
        content: manuscript,
        source: "manual",
        expectedCurrentVersionId: null,
      },
    });
    expect(versionResponse.statusCode, versionResponse.body).toBe(201);
    const version = versionResponse.json() as { id: string };

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/documents/${document.id}/reviews`,
      payload: {
        requestId: "review-current-version",
        documentVersionId: version.id,
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    expect(created.json()).toMatchObject({
      run: { recipe: "document-review", mode: "manual" },
      steps: [{ kind: "context.compile" }, { kind: "semantic.review" }],
      idempotentReplay: false,
    });
    const runId = created.json().run.id as string;
    let status = created.json().run.status as string;
    for (let index = 0; index < 4 && status !== "completed"; index += 1) {
      const advanced = await app.inject({
        method: "POST",
        url: `/api/runs/${encodeURIComponent(runId)}/advance`,
        payload: { projectId: project.id },
      });
      expect(advanced.statusCode, advanced.body).toBe(200);
      status = advanced.json().snapshot.run.status as string;
    }
    expect(status).toBe("completed");

    const workspace = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/reviews`,
    });
    expect(workspace.statusCode, workspace.body).toBe(200);
    expect(workspace.json()).toMatchObject({
      reports: [
        {
          runId,
          documentId: document.id,
          documentVersionId: version.id,
          reviewedContent: manuscript,
          verdict: "pass",
        },
      ],
    });
    const versions = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/studio/documents/${document.id}`,
    });
    expect(versions.statusCode, versions.body).toBe(200);
    expect(versions.json()).toMatchObject({
      document: { currentVersionId: version.id },
      versions: [{ id: version.id, content: manuscript }],
    });

    const replay = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/documents/${document.id}/reviews`,
      payload: {
        requestId: "review-current-version",
        documentVersionId: version.id,
      },
    });
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json()).toMatchObject({
      run: { id: runId },
      idempotentReplay: true,
    });
  });

  it("lists grounded reports and records optimistic human dispositions", async () => {
    const database = new NodeNarrativeDatabase();
    const app = await buildApp({
      database,
      environment: {},
      logger: false,
      config: {
        dataDirectory: ".",
        databasePath: ":memory:",
        host: "127.0.0.1",
        port: 4317,
        environment: "test",
      },
    });
    resources.push({ app, database });
    const projectResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        requestId: globalThis.crypto.randomUUID(),
        title: "审稿样本",
        premise: "潮水抹去一段记忆。",
      },
    });
    const project = projectResponse.json() as { id: string };
    const recipe = buildChapterRecipe("run-review", 0);
    new SqliteRunRepository(database).create({
      id: "run-review",
      projectId: project.id,
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "manual",
      targetOutlineNodeId: null,
      policy: {},
      budgetLimit: {
        maxInputTokens: 10_000,
        maxOutputTokens: 10_000,
        maxCalls: 10,
        maxCostUsd: null,
        maxWallTimeMs: 60_000,
      },
      steps: recipe.steps,
      now: "2026-08-10T00:00:00.000Z",
    });
    const reviewStep = recipe.steps.find(
      (step) => step.kind === "semantic.review",
    )!;
    const reviews = new SqliteReviewRepository(database);
    reviews.insertReport({
      id: "report-1",
      projectId: project.id,
      runId: "run-review",
      stepId: reviewStep.id,
      documentVersionId: null,
      verdict: "revise",
      summary: "因果关系需要补强。",
      scores: { causality: 62 },
      reviewedContent: "林昼听见潮声，于是立刻烧掉了信。",
      reviewedContentHash: "content-hash",
      issues: [
        {
          id: "issue-1",
          category: "causality",
          severity: "major",
          message: "烧信缺少可见动机。",
          evidence: [{ quote: "立刻烧掉了信", start: 9, end: 15 }],
          suggestedDirection: "补充潮声与信件危险之间的因果证据。",
          requiresAuthorDecision: false,
        },
        {
          id: "issue-2",
          category: "continuity",
          severity: "minor",
          message: "这个旧候选仍有一项未裁定问题。",
          evidence: [{ quote: "听见潮声", start: 2, end: 6 }],
          suggestedDirection: "核对上一场景的环境连续性。",
          requiresAuthorDecision: false,
        },
      ],
      createdAt: "2026-08-10T00:01:00.000Z",
    });

    const listed = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/reviews`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      reports: [
        {
          id: "report-1",
          reviewedContent: "林昼听见潮声，于是立刻烧掉了信。",
          issues: [
            { id: "issue-1", status: "open", decision: null },
            { id: "issue-2", status: "open", decision: null },
          ],
        },
      ],
    });
    const unboundOverview = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/overview`,
    });
    expect(unboundOverview.json()).toMatchObject({
      pending: {
        reviewIssues: 0,
        revisionProposals: 0,
        reviewDocumentId: null,
      },
    });

    const decided = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/review-issues/issue-1/decisions`,
      payload: {
        requestId: "issue-1:intentional_keep",
        action: "intentional_keep",
        note: "这里保留跳切，以制造不安。",
        expectedStatus: "open",
      },
    });
    expect(decided.statusCode).toBe(201);
    expect(decided.json()).toMatchObject({
      action: "intentional_keep",
      priorStatus: "open",
      resultingStatus: "resolved",
    });

    const replayed = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/review-issues/issue-1/decisions`,
      payload: {
        requestId: "issue-1:intentional_keep",
        action: "intentional_keep",
        note: "这里保留跳切，以制造不安。",
        expectedStatus: "open",
      },
    });
    expect(replayed.statusCode, replayed.body).toBe(201);
    expect(replayed.json()).toEqual(decided.json());

    const sameDecisionWithNewRequest = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/review-issues/issue-1/decisions`,
      payload: {
        requestId: "issue-1:intentional_keep:retry",
        action: "intentional_keep",
        note: null,
        expectedStatus: "open",
      },
    });
    expect(
      sameDecisionWithNewRequest.statusCode,
      sameDecisionWithNewRequest.body,
    ).toBe(201);
    expect(sameDecisionWithNewRequest.json()).toEqual(decided.json());

    const stale = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/review-issues/issue-1/decisions`,
      payload: {
        requestId: "issue-1:accept",
        action: "accept",
        expectedStatus: "open",
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: { code: "review.issue.already_decided" },
    });

    const refreshed = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/reviews`,
    });
    expect(refreshed.json()).toMatchObject({
      reports: [
        {
          issues: [
            {
              status: "resolved",
              decision: {
                action: "intentional_keep",
                note: "这里保留跳切，以制造不安。",
              },
            },
            { id: "issue-2", status: "open", decision: null },
          ],
        },
      ],
    });

    const document = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/documents`,
        payload: {
          requestId: globalThis.crypto.randomUUID(),
          kind: "note",
          title: "审稿正文",
        },
      })
    ).json() as { id: string };
    const version = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/documents/${document.id}/versions`,
        payload: {
          content: "林昼听见潮声，于是立刻烧掉了信。",
          source: "manual",
          expectedCurrentVersionId: null,
        },
      })
    ).json() as { id: string };
    expect(
      reviews.bindRunReportsToDocumentVersion(
        "run-review",
        version.id,
        "content-hash",
      ),
    ).toBe(1);

    reviews.insertRevisionProposal({
      id: "proposal-decision",
      projectId: project.id,
      runId: "run-review",
      stepId: reviewStep.id,
      baseDocumentVersionId: version.id,
      revisedContent: "这份修订会被拒绝。",
      diff: {},
      addressedIssueIds: [],
      status: "proposed",
      createdAt: "2026-08-10T00:01:30.000Z",
    });
    const revisionDecisionRequest = {
      requestId: "proposal-decision:reject",
      action: "reject",
    } as const;
    const revisionDecision = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/revision-proposals/proposal-decision/decisions`,
      payload: revisionDecisionRequest,
    });
    expect(revisionDecision.statusCode, revisionDecision.body).toBe(200);
    expect(revisionDecision.json()).toMatchObject({
      proposal: { id: "proposal-decision", status: "rejected" },
    });
    const revisionReplay = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/revision-proposals/proposal-decision/decisions`,
      payload: revisionDecisionRequest,
    });
    expect(revisionReplay.statusCode, revisionReplay.body).toBe(200);
    expect(revisionReplay.json()).toEqual(revisionDecision.json());
    const revisionConflict = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/revision-proposals/proposal-decision/decisions`,
      payload: {
        requestId: "proposal-decision:apply",
        action: "apply",
      },
    });
    expect(revisionConflict.statusCode, revisionConflict.body).toBe(409);
    expect(revisionConflict.json()).toMatchObject({
      error: { code: "revision_proposal.already_decided" },
    });

    reviews.insertCanonChangeSet({
      id: "change-set-decision",
      projectId: project.id,
      runId: "run-review",
      stepId: reviewStep.id,
      changes: {},
      status: "candidate",
      createdAt: "2026-08-10T00:01:45.000Z",
    });
    const canonDecisionRequest = {
      requestId: "change-set-decision:reject",
      action: "reject",
      expectedStatus: "candidate",
      conflictPolicy: "reject",
    } as const;
    const canonDecision = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/canon-change-sets/change-set-decision/decisions`,
      payload: canonDecisionRequest,
    });
    expect(canonDecision.statusCode, canonDecision.body).toBe(200);
    expect(canonDecision.json()).toMatchObject({
      changeSet: { id: "change-set-decision", status: "rejected" },
    });
    const canonReplay = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/canon-change-sets/change-set-decision/decisions`,
      payload: canonDecisionRequest,
    });
    expect(canonReplay.statusCode, canonReplay.body).toBe(200);
    expect(canonReplay.json()).toEqual(canonDecision.json());
    const canonConflict = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/canon-change-sets/change-set-decision/decisions`,
      payload: {
        requestId: "change-set-decision:apply",
        action: "apply",
        expectedStatus: "candidate",
        conflictPolicy: "reject",
      },
    });
    expect(canonConflict.statusCode, canonConflict.body).toBe(409);
    expect(canonConflict.json()).toMatchObject({
      error: { code: "canon_change_set.already_decided" },
    });

    reviews.insertRevisionProposal({
      id: "proposal-stale-on-cancel",
      projectId: project.id,
      runId: "run-review",
      stepId: reviewStep.id,
      baseDocumentVersionId: version.id,
      revisedContent: "这份修改不应在任务取消后继续待处理。",
      diff: {},
      addressedIssueIds: ["issue-1"],
      status: "proposed",
      createdAt: "2026-08-10T00:02:00.000Z",
    });
    const secondRecipe = buildChapterRecipe("run-review-second", 0);
    new SqliteRunRepository(database).create({
      id: "run-review-second",
      projectId: project.id,
      recipe: secondRecipe.name,
      recipeVersion: secondRecipe.version,
      mode: "manual",
      targetOutlineNodeId: null,
      policy: {},
      budgetLimit: {
        maxInputTokens: 10_000,
        maxOutputTokens: 10_000,
        maxCalls: 10,
        maxCostUsd: null,
        maxWallTimeMs: 60_000,
      },
      steps: secondRecipe.steps,
      now: "2026-08-10T00:02:10.000Z",
    });
    const secondDocument = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/documents`,
        payload: {
          requestId: globalThis.crypto.randomUUID(),
          kind: "note",
          title: "另一篇审稿正文",
        },
      })
    ).json() as { id: string };
    const secondVersion = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/documents/${secondDocument.id}/versions`,
        payload: {
          content: "另一篇正文也有一个待处理问题。",
          source: "manual",
          expectedCurrentVersionId: null,
        },
      })
    ).json() as { id: string };
    reviews.insertReport({
      id: "report-second-document",
      projectId: project.id,
      runId: "run-review-second",
      stepId: secondRecipe.steps.find(
        (step) => step.kind === "semantic.review",
      )!.id,
      documentVersionId: secondVersion.id,
      verdict: "revise",
      summary: "另一篇正文也需要处理。",
      scores: { continuity: 70 },
      reviewedContent: "另一篇正文也有一个待处理问题。",
      reviewedContentHash: "second-content-hash",
      issues: [
        {
          id: "issue-second-document",
          category: "continuity",
          severity: "minor",
          message: "跨章状态没有交代。",
          evidence: [{ quote: "待处理问题", start: 8, end: 13 }],
          suggestedDirection: "补充上一章状态。",
          requiresAuthorDecision: false,
        },
      ],
      createdAt: "2026-08-10T00:02:20.000Z",
    });
    expect(
      reviews.bindRunReportsToDocumentVersion(
        "run-review-second",
        secondVersion.id,
        "second-content-hash",
      ),
    ).toBe(1);
    new SqliteRunRepository(database).setRunStatus(
      "run-review-second",
      "completed",
      "2026-08-10T00:02:30.000Z",
      "test_review_completed",
    );
    const beforeCancel = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/overview`,
    });
    expect(beforeCancel.statusCode, beforeCancel.body).toBe(200);
    expect(beforeCancel.json()).toMatchObject({
      pending: {
        reviewIssues: 2,
        revisionProposals: 1,
        reviewDocumentId: document.id,
      },
    });
    const cancelled = await app.inject({
      method: "POST",
      url: "/api/runs/run-review/actions",
      payload: { action: "cancel", projectId: project.id },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(
      reviews.getRevisionProposal(project.id, "proposal-stale-on-cancel"),
    ).toMatchObject({ status: "superseded", decidedAt: expect.any(String) });
    new SqliteRunRepository(database).setRunStatus(
      "run-review",
      "cancelled",
      "2026-08-10T00:03:00.000Z",
      "test_cancelled_candidate",
    );

    const afterCancel = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/overview`,
    });
    expect(afterCancel.statusCode, afterCancel.body).toBe(200);
    expect(afterCancel.json()).toMatchObject({
      activeTask: null,
      pending: {
        reviewIssues: 1,
        revisionProposals: 0,
        reviewDocumentId: secondDocument.id,
      },
    });
    const historical = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/reviews`,
    });
    const historicalBody = historical.json() as {
      reports: Array<{
        id: string;
        issues: Array<{ id: string; status: string }>;
      }>;
    };
    expect(
      historicalBody.reports.find((report) => report.id === "report-1"),
    ).toMatchObject({
      issues: [{ id: "issue-1" }, { id: "issue-2", status: "open" }],
    });
  });
});

function reviewModel(): NarrativeModelClient {
  return {
    async structured(_run, _step, purpose, _request, _contract, validate) {
      if (purpose !== "semantic-review") {
        throw new Error(`unexpected purpose ${purpose}`);
      }
      const checked = validate({
        summary: "当前版本的章节目标与连续性均成立。",
        scores: {
          continuity: 91,
          pacing: 86,
          character: 88,
          prose: 84,
          goal: 92,
        },
        issues: [],
      });
      if (!checked.success) throw new Error(checked.issues.join("; "));
      return {
        value: checked.data,
        usage: {
          inputTokens: 100,
          outputTokens: 80,
          calls: 1,
          costUsd: 0,
          wallTimeMs: 5,
        },
        mode: "native",
        attempts: 1,
      };
    },
  } as NarrativeModelClient;
}
