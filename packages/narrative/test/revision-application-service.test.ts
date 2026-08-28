import { createDocument, createProject } from "@narralume/domain";
import { buildChapterRecipe } from "@narralume/harness";
import {
  SqliteDocumentRepository,
  SqliteProjectRepository,
  SqliteReviewRepository,
  SqliteRunRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RevisionApplicationError,
  RevisionApplicationService,
} from "../src/revision-application-service.js";

const now = "2026-08-10T00:00:00.000Z";
let database: NodeNarrativeDatabase;
let documents: SqliteDocumentRepository;
let reviews: SqliteReviewRepository;
let revisionStepId: string;

beforeEach(() => {
  database = new NodeNarrativeDatabase();
  database.migrate();
  new SqliteProjectRepository(database).insert(
    createProject({ id: "p1", title: "Revision", now }),
  );
  documents = new SqliteDocumentRepository(database);
  documents.insert(
    createDocument({
      id: "doc-1",
      projectId: "p1",
      kind: "chapter",
      title: "Chapter",
      now,
    }),
  );
  documents.appendVersion("p1", "doc-1", {
    id: "version-1",
    content: "Before",
    source: "test",
    expectedCurrentVersionId: null,
    now,
  });
  const recipe = buildChapterRecipe("run-1", 1);
  revisionStepId = recipe.steps.find(
    (step) => step.kind === "revision.generate",
  )!.id;
  new SqliteRunRepository(database).create({
    id: "run-1",
    projectId: "p1",
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
    now,
  });
  reviews = new SqliteReviewRepository(database);
});

afterEach(() => database.close());

describe("RevisionApplicationService", () => {
  it("applies a proposal as a new optimistic document version", () => {
    reviews.insertReport({
      id: "report-1",
      projectId: "p1",
      runId: "run-1",
      stepId: revisionStepId,
      documentVersionId: "version-1",
      verdict: "revise",
      summary: "Voice drift",
      scores: { character: 60 },
      reviewedContent: "Before",
      reviewedContentHash: "hash",
      issues: [
        {
          id: "issue-1",
          category: "character",
          severity: "major",
          message: "The viewpoint character speaks out of voice",
          evidence: [{ quote: "Before", start: 0, end: 6 }],
          suggestedDirection: "Restore the established restrained voice",
          requiresAuthorDecision: false,
        },
      ],
      createdAt: now,
    });
    seedProposal("proposal-1", ["issue-1"]);
    const result = new RevisionApplicationService(database).apply({
      projectId: "p1",
      proposalId: "proposal-1",
      now,
    });
    expect(result).toMatchObject({
      documentId: "doc-1",
      documentVersionId: "proposal-1:accepted-version",
      proposal: { status: "accepted" },
      resolvedIssueCount: 1,
      lessonCount: 1,
    });
    expect(documents.get("p1", "doc-1")?.currentVersionId).toBe(
      "proposal-1:accepted-version",
    );
    expect(
      documents.getVersion("p1", "doc-1", "proposal-1:accepted-version")
        ?.content,
    ).toBe("After");
    expect(reviews.listLessons("p1")).toEqual([
      expect.objectContaining({
        category: "character",
        occurrences: 1,
        guidance: "Restore the established restrained voice",
      }),
    ]);
  });

  it("refuses to overwrite a document that advanced after review", () => {
    seedProposal("proposal-2");
    documents.appendVersion("p1", "doc-1", {
      id: "version-2",
      content: "Concurrent author edit",
      source: "author",
      expectedCurrentVersionId: "version-1",
      now: "2026-08-10T00:01:00.000Z",
    });
    expect(() =>
      new RevisionApplicationService(database).apply({
        projectId: "p1",
        proposalId: "proposal-2",
        now,
      }),
    ).toThrow(RevisionApplicationError);
    expect(reviews.getRevisionProposal("p1", "proposal-2")?.status).toBe(
      "proposed",
    );
  });
});

function seedProposal(id: string, addressedIssueIds: string[] = []): void {
  reviews.insertRevisionProposal({
    id,
    projectId: "p1",
    runId: "run-1",
    stepId: revisionStepId,
    baseDocumentVersionId: "version-1",
    revisedContent: "After",
    diff: { removed: "Before", inserted: "After" },
    addressedIssueIds,
    status: "proposed",
    createdAt: now,
  });
}
