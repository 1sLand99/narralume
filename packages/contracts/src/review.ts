import { z } from "zod";

import {
  EffectivePolicySchema,
  ModelExecutionPolicySchema,
} from "./execution-policy.js";
import { BackgroundRunCreatedSchema, RunOriginSchema } from "./run.js";

const IdSchema = z.string().trim().min(1).max(300);
const TimestampSchema = z.string().min(1);
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const ReviewIssueStatusSchema = z.enum([
  "open",
  "accepted",
  "rejected",
  "resolved",
]);
export const ReviewIssueDecisionActionSchema = z.enum([
  "accept",
  "reject",
  "false_positive",
  "intentional_keep",
]);

export const ReviewWorkspaceIssueSchema = z.object({
  id: IdSchema,
  category: z.string(),
  severity: z.enum(["info", "minor", "major", "critical"]),
  message: z.string(),
  evidence: z.array(
    z.object({
      quote: z.string(),
      start: z.number().int().nonnegative().optional(),
      end: z.number().int().nonnegative().optional(),
    }),
  ),
  suggestedDirection: z.string().nullable(),
  requiresAuthorDecision: z.boolean(),
  status: ReviewIssueStatusSchema,
  decision: z
    .object({
      action: ReviewIssueDecisionActionSchema,
      note: z.string().nullable(),
      decidedAt: TimestampSchema,
    })
    .nullable(),
});

export const ReviewWorkspaceReportSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  runId: IdSchema,
  stepId: IdSchema,
  documentVersionId: IdSchema.nullable(),
  documentId: IdSchema.nullable(),
  documentTitle: z.string().nullable(),
  verdict: z.enum(["pass", "revise", "block"]),
  summary: z.string(),
  scores: z.record(z.string(), z.number()),
  reviewedContent: z.string().nullable(),
  reviewedContentHash: z.string().nullable(),
  issues: z.array(ReviewWorkspaceIssueSchema),
  createdAt: TimestampSchema,
});

export const ReviewRevisionProposalSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  stepId: IdSchema,
  documentId: IdSchema.nullable(),
  baseDocumentVersionId: IdSchema.nullable(),
  baseContent: z.string().nullable(),
  revisedContent: z.string(),
  diff: JsonObjectSchema,
  addressedIssueIds: z.array(IdSchema),
  status: z.enum(["proposed", "accepted", "rejected", "superseded"]),
  createdAt: TimestampSchema,
  decidedAt: TimestampSchema.nullable(),
});

export const ReviewWorkspaceSchema = z.object({
  reports: z.array(ReviewWorkspaceReportSchema),
  proposals: z.array(ReviewRevisionProposalSchema),
});
export type ReviewWorkspaceDto = z.infer<typeof ReviewWorkspaceSchema>;

export const CreateDocumentReviewRequestSchema = z
  .object({
    requestId: IdSchema,
    documentVersionId: IdSchema,
    origin: RunOriginSchema.nullable().default(null),
    policy: ModelExecutionPolicySchema.default({}),
  })
  .strict();

export const DocumentReviewRunCreatedSchema = BackgroundRunCreatedSchema.extend(
  {
    effectivePolicy: EffectivePolicySchema,
    setupHint: z.literal("embedding_not_configured").optional(),
    idempotentReplay: z.boolean().default(false),
  },
);
export type DocumentReviewRunCreatedDto = z.infer<
  typeof DocumentReviewRunCreatedSchema
>;

export const DecideReviewIssueRequestSchema = z.object({
  requestId: IdSchema,
  action: ReviewIssueDecisionActionSchema,
  note: z.string().trim().max(4_000).nullable().optional(),
  expectedStatus: ReviewIssueStatusSchema,
});

export const DecideRevisionProposalRequestSchema = z.object({
  requestId: IdSchema,
  action: z.enum(["apply", "reject"]),
});

export const DecideCanonChangeSetRequestSchema = z.object({
  requestId: IdSchema,
  action: z.enum(["apply", "reject"]),
  expectedStatus: z.literal("candidate").default("candidate"),
  conflictPolicy: z.enum(["reject", "force"]).default("reject"),
});

export const ReviewIssueDecisionSchema = z.object({
  id: IdSchema,
  issueId: IdSchema,
  action: ReviewIssueDecisionActionSchema,
  note: z.string().nullable(),
  priorStatus: ReviewIssueStatusSchema,
  resultingStatus: ReviewIssueStatusSchema,
  createdAt: TimestampSchema,
});
export type ReviewIssueDecisionDto = z.infer<typeof ReviewIssueDecisionSchema>;
