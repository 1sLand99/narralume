import {
  SqliteDocumentRepository,
  SqliteRetrievalRepository,
  SqliteReviewRepository,
  SqliteStoryRepository,
  SqliteRunRepository,
  type NarrativeDatabase,
  type ReviewRevisionProposalDetail,
} from "@narralume/persistence";
import { requireCurrentChapterOutline } from "./outline-baseline.js";

export interface RevisionApplicationResult {
  proposal: ReviewRevisionProposalDetail;
  documentId: string;
  documentVersionId: string;
  contentHash: string;
  resolvedIssueCount: number;
  lessonCount: number;
}

export class RevisionApplicationService {
  private readonly documents: SqliteDocumentRepository;
  private readonly reviews: SqliteReviewRepository;
  private readonly retrieval: SqliteRetrievalRepository;
  private readonly story: SqliteStoryRepository;

  constructor(private readonly database: NarrativeDatabase) {
    this.documents = new SqliteDocumentRepository(database);
    this.reviews = new SqliteReviewRepository(database);
    this.retrieval = new SqliteRetrievalRepository(database);
    this.story = new SqliteStoryRepository(database);
  }

  apply(input: {
    projectId: string;
    proposalId: string;
    now?: string;
  }): RevisionApplicationResult {
    const now = input.now ?? new Date().toISOString();
    return this.database.transaction(() => {
      const proposal = this.reviews.getRevisionProposal(
        input.projectId,
        input.proposalId,
      );
      if (!proposal)
        throw new RevisionApplicationError(
          "revision_proposal.not_found",
          `Revision proposal not found: ${input.proposalId}`,
        );
      if (proposal.status !== "proposed")
        throw new RevisionApplicationError(
          "revision_proposal.version_conflict",
          `Revision proposal is already ${proposal.status}`,
        );
      if (!proposal.documentId || !proposal.baseDocumentVersionId)
        throw new RevisionApplicationError(
          "revision_proposal.base_missing",
          "Revision proposal does not reference an existing document version",
        );
      const document = this.documents.get(input.projectId, proposal.documentId);
      if (!document)
        throw new RevisionApplicationError(
          "revision_proposal.document_missing",
          `Document not found: ${proposal.documentId}`,
        );
      if (document.currentVersionId !== proposal.baseDocumentVersionId)
        throw new RevisionApplicationError(
          "revision_proposal.base_stale",
          `Document advanced from ${proposal.baseDocumentVersionId} to ${document.currentVersionId}`,
        );
      requireCurrentChapterOutline(
        this.database,
        new SqliteRunRepository(this.database).getSnapshot(proposal.runId),
      );
      const version = this.documents.appendVersion(
        input.projectId,
        document.id,
        {
          id: `${proposal.id}:accepted-version`,
          content: proposal.revisedContent,
          source: `review-proposal:${proposal.id}`,
          runId: proposal.runId,
          expectedCurrentVersionId: proposal.baseDocumentVersionId,
          now,
        },
      );
      const decided = this.reviews.decideRevisionProposal({
        projectId: input.projectId,
        proposalId: proposal.id,
        expectedStatus: "proposed",
        status: "accepted",
        now,
      });
      const resolvedIssueCount = this.reviews.resolveProposalIssues(
        proposal.addressedIssueIds,
      );
      const lessons = this.reviews.learnFromIssues(
        input.projectId,
        proposal.addressedIssueIds,
        now,
      );
      this.retrieval.upsertSegment({
        id: `document:${document.id}:current`,
        projectId: input.projectId,
        sourceType: "document_current",
        sourceId: document.id,
        title: document.title,
        content: version.content,
        authority: "confirmed",
        metadata: {
          documentId: document.id,
          documentVersionId: version.id,
          outlineNodeId: document.outlineNodeId,
          revisionProposalId: proposal.id,
        },
        entityIds: [],
        createdAt: now,
        updatedAt: now,
      });
      if (document.outlineNodeId) {
        this.story.updateOutlineStatus(
          input.projectId,
          document.outlineNodeId,
          "committed",
          now,
        );
      }
      return {
        proposal: decided,
        documentId: document.id,
        documentVersionId: version.id,
        contentHash: version.contentHash,
        resolvedIssueCount,
        lessonCount: lessons.length,
      };
    });
  }

  reject(input: {
    projectId: string;
    proposalId: string;
    now?: string;
  }): ReviewRevisionProposalDetail {
    return this.reviews.decideRevisionProposal({
      projectId: input.projectId,
      proposalId: input.proposalId,
      expectedStatus: "proposed",
      status: "rejected",
      now: input.now ?? new Date().toISOString(),
    });
  }
}

export class RevisionApplicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RevisionApplicationError";
  }
}
