import { z } from "zod";

import {
  EffectivePolicySchema,
  ModelExecutionPolicySchema,
} from "./execution-policy.js";

const IdSchema = z.string().trim().min(1).max(300);
const TimestampSchema = z.string().min(1);
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const RunModeSchema = z.enum([
  "autopilot",
  "chapter-gate",
  "director",
  "co-create",
  "manual",
]);

export const RunStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "awaiting_user",
  "failed_recoverable",
  "failed",
  "cancelled",
  "completed",
]);

export const RunStepStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
]);

export const RunStepKindSchema = z.enum([
  "context.compile",
  "scene.plan",
  "draft.generate",
  "deterministic.check",
  "semantic.review",
  "revision.generate",
  "chapter.settle",
  "chapter.commit",
  "foundation.generate",
  "foundation.stage",
  "outline.generate",
  "outline.entities",
  "outline.commit",
  "steer.classify",
  "arc.review",
  "volume.review",
  "cocreate.context",
  "cocreate.respond",
  "cocreate.stage",
  "adoption.prepare",
  "adoption.settle",
  "adoption.commit",
  "edit.transform",
  "edit.stage",
  "import.analyze",
  "import.stage",
  "assistant.context",
  "assistant.respond",
  "assistant.stage",
  "canon.context",
  "canon.candidate",
  "canon.stage",
]);

export const ChapterStepKindSchema = RunStepKindSchema.extract([
  "context.compile",
  "scene.plan",
  "draft.generate",
  "deterministic.check",
  "semantic.review",
  "revision.generate",
  "chapter.settle",
  "chapter.commit",
]);

export const RunBudgetUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  wallTimeMs: z.number().int().nonnegative(),
});

export const RunOriginSchema = z
  .object({
    surface: z.string().trim().min(1).max(100),
    documentId: IdSchema.nullable().default(null),
    sessionId: IdSchema.optional(),
    branchId: IdSchema.optional(),
    selection: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
      })
      .nullable()
      .default(null),
  })
  .strict();
export type RunOrigin = z.infer<typeof RunOriginSchema>;

export const CreateChapterRunRequestSchema = z
  .object({
    requestId: IdSchema,
    targetOutlineNodeId: IdSchema,
    planningMode: z.enum(["auto", "confirm"]).default("auto"),
    origin: RunOriginSchema.nullable().default(null),
    maxRevisionCycles: z.number().int().min(0).max(5).default(2),
    policy: ModelExecutionPolicySchema.default({}),
  })
  .strict();
export type CreateChapterRunRequest = z.infer<
  typeof CreateChapterRunRequestSchema
>;

export const RunActionRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      projectId: IdSchema,
      action: z.enum([
        "pause",
        "resume",
        "cancel",
        "accept_plan",
        "switch_to_manual",
        "accept_manuscript",
        "discard_manuscript",
      ]),
    })
    .strict(),
  z
    .object({
      projectId: IdSchema,
      /** 终态 failed 的章节 run 重开新 run：同章节、同来源，服务端派生
       *  确定性 requestId，重复点击幂等回到同一个新 run。 */
      action: z.literal("retry_chapter"),
      requestId: IdSchema,
    })
    .strict(),
  z
    .object({
      projectId: IdSchema,
      action: z.literal("request_revision"),
      requestId: IdSchema,
      instruction: z
        .string()
        .trim()
        .min(1)
        .max(20_000)
        .default("请在保持既有优点的前提下，重新修订并提升这一版正文。"),
    })
    .strict(),
]);

export const AdvanceRunRequestSchema = z
  .object({
    projectId: IdSchema,
  })
  .strict();
export type AdvanceRunRequest = z.infer<typeof AdvanceRunRequestSchema>;

export const RunProductResultSchema = z.object({
  planCandidate: JsonObjectSchema.nullable(),
  manuscriptCandidate: JsonObjectSchema.nullable(),
  reviewSummary: JsonObjectSchema.nullable(),
  settlementCandidate: JsonObjectSchema.nullable(),
  canonChangeSetId: IdSchema.nullable(),
  foundationCandidateSetId: IdSchema.nullable(),
  canonCandidateSetId: IdSchema.nullable(),
  editProposalId: IdSchema.nullable(),
  cocreateTurnId: IdSchema.nullable(),
  cocreateSwipeId: IdSchema.nullable(),
  sceneAdoptionId: IdSchema.nullable(),
  documentId: IdSchema.nullable(),
  documentVersionId: IdSchema.nullable(),
  importBatchId: IdSchema.nullable(),
  partialRecovery: z
    .object({
      stepId: IdSchema,
      attempt: z.number().int().positive(),
      characters: z.number().int().nonnegative(),
      canAdopt: z.boolean(),
    })
    .nullable(),
});

export const RunAvailableActionSchema = z.enum([
  "pause",
  "resume",
  "cancel",
  "accept_plan",
  "switch_to_manual",
  "accept_manuscript",
  "request_revision",
  "discard_manuscript",
  "use_partial",
  "regenerate",
  "retry_chapter",
]);

export const DiscardRunStreamRequestSchema = z.object({
  projectId: IdSchema,
  stepId: IdSchema,
  attempt: z.number().int().positive(),
});

/**
 * Minimum character count a partial stream must reach before it can be
 * continued or adopted. Shorter partials can only be discarded/regenerated.
 */
export const MIN_VIABLE_PARTIAL_CHARACTERS = 50;

/** Identifies one persisted stream attempt of a run (the partial target). */
export const RunStreamRefSchema = z.object({
  projectId: IdSchema,
  stepId: IdSchema,
  attempt: z.number().int().positive(),
});

export const ContinueRunStreamRequestSchema = RunStreamRefSchema;
export type ContinueRunStreamRequest = z.infer<
  typeof ContinueRunStreamRequestSchema
>;

export const AdoptRunStreamRequestSchema = RunStreamRefSchema;
export type AdoptRunStreamRequest = z.infer<typeof AdoptRunStreamRequestSchema>;

export const RegenerateRunStreamRequestSchema = RunStreamRefSchema;
export type RegenerateRunStreamRequest = z.infer<
  typeof RegenerateRunStreamRequestSchema
>;

export const NarrativeRunSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  recipe: z.string(),
  recipeVersion: z.number().int().positive(),
  mode: RunModeSchema,
  status: RunStatusSchema,
  targetOutlineNodeId: IdSchema.nullable(),
  policy: JsonObjectSchema,
  budgetUsage: RunBudgetUsageSchema,
  revisionCycle: z.number().int().nonnegative(),
  pauseRequested: z.boolean(),
  cancelRequested: z.boolean(),
  currentStepId: IdSchema.nullable(),
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  version: z.number().int().nonnegative(),
});

export const NarrativeRunStepSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  ordinal: z.number().int().nonnegative(),
  kind: RunStepKindSchema,
  cycle: z.number().int().nonnegative(),
  status: RunStepStatusSchema,
  idempotencyKey: z.string(),
  inputHash: z.string().nullable(),
  outputArtifact: JsonObjectSchema.nullable(),
  outputHash: z.string().nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
      details: z.unknown().optional(),
      usage: RunBudgetUsageSchema.optional(),
    })
    .nullable(),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const NarrativeRunEventSchema = z.object({
  id: z.number().int().nonnegative(),
  runId: IdSchema,
  stepId: IdSchema.nullable(),
  sequence: z.number().int().nonnegative(),
  type: z.string(),
  payload: JsonObjectSchema,
  createdAt: TimestampSchema,
});

export const NarrativeCheckpointSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  stepId: IdSchema.nullable(),
  kind: z.string(),
  state: JsonObjectSchema,
  stateHash: z.string(),
  createdAt: TimestampSchema,
});

export const RunSnapshotSchema = z.object({
  run: NarrativeRunSchema,
  steps: z.array(NarrativeRunStepSchema),
  events: z.array(NarrativeRunEventSchema),
  latestCheckpoint: NarrativeCheckpointSchema.nullable(),
});
export type RunSnapshotDto = z.infer<typeof RunSnapshotSchema>;

export const BackgroundRunCreatedSchema = RunSnapshotSchema.extend({
  origin: RunOriginSchema.nullable(),
  result: RunProductResultSchema,
  availableActions: z.array(RunAvailableActionSchema),
});

/**
 * Response of POST /api/runs/:runId/streams/adopt. The partial content is
 * appended to the chapter document's immutable version chain; repeating the
 * call replays idempotently (same version, `idempotentReplay: true`).
 */
export const AdoptRunStreamResponseSchema = z.object({
  documentId: IdSchema,
  versionId: IdSchema,
  contentHash: z.string(),
  idempotentReplay: z.boolean(),
});
export type AdoptRunStreamResponse = z.infer<
  typeof AdoptRunStreamResponseSchema
>;

/**
 * Response of POST /api/runs/:runId/streams/regenerate: the partial is
 * discarded and the run is nudged so the harness retries the source step.
 * `discarded` is false on an idempotent repeat (the partial is already gone).
 */
export const RegenerateRunStreamResponseSchema = z.object({
  discarded: z.boolean(),
  snapshot: RunSnapshotSchema,
});
export type RegenerateRunStreamResponse = z.infer<
  typeof RegenerateRunStreamResponseSchema
>;

/**
 * Response of POST /api/projects/:projectId/runs/chapter: the created run
 * snapshot plus the fully-resolved effective policy that was persisted into
 * run.policy. `setupHint` flags missing optional model capabilities
 * (embedding) so the UI can nudge setup without blocking the run.
 */
export const ChapterRunCreatedSchema = BackgroundRunCreatedSchema.extend({
  effectivePolicy: EffectivePolicySchema,
  setupHint: z.literal("embedding_not_configured").optional(),
  idempotentReplay: z.boolean().default(false),
});
export type ChapterRunCreatedDto = z.infer<typeof ChapterRunCreatedSchema>;

export const RequestedRevisionRunCreatedSchema = ChapterRunCreatedSchema.extend(
  {
    idempotentReplay: z.boolean(),
  },
);

export const LlmCallReceiptSchema = z.object({
  id: IdSchema,
  stepId: IdSchema,
  purpose: z.string(),
  protocol: z.enum(["openai-chat", "openai-responses", "anthropic-messages"]),
  model: z.string(),
  status: z.string(),
  finishReason: z.string().nullable(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
      cachedInputTokens: z.number().int().nonnegative(),
      reasoningTokens: z.number().int().nonnegative(),
    })
    .nullable(),
  error: JsonObjectSchema.nullable(),
  ttftMs: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  details: JsonObjectSchema.nullable(),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
});

export const ReviewReportViewSchema = z.object({
  id: IdSchema,
  stepId: IdSchema,
  verdict: z.enum(["pass", "revise", "block"]),
  summary: z.string(),
  scores: z.record(z.string(), z.number()),
  issues: z.array(
    z.object({
      id: IdSchema,
      category: z.string(),
      severity: z.enum(["info", "minor", "major", "critical"]),
      message: z.string(),
      evidence: z.array(
        z.object({
          quote: z.string(),
          start: z.number().int().optional(),
          end: z.number().int().optional(),
        }),
      ),
      suggestedDirection: z.string().nullable(),
      requiresAuthorDecision: z.boolean(),
      status: z.string(),
    }),
  ),
  createdAt: TimestampSchema,
});

export const ContextReceiptViewSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  purpose: z.string(),
  budget: JsonObjectSchema,
  entries: z.array(JsonObjectSchema),
  degradations: z.array(JsonObjectSchema).optional(),
  inventoryDigest: z.string().optional(),
  materializationDigest: z.string().optional(),
  compiledHash: z.string(),
  createdAt: TimestampSchema,
});

export const ModelAssignmentSnapshotViewSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  purpose: z.string(),
  requestedRole: z.string(),
  assignmentRole: z.string(),
  modelId: IdSchema,
  provider: JsonObjectSchema,
  model: JsonObjectSchema,
  applied: JsonObjectSchema,
  createdAt: TimestampSchema,
});

export const RunDetailSchema = RunSnapshotSchema.extend({
  origin: RunOriginSchema.nullable(),
  parentTask: z
    .object({ kind: z.literal("autopilot"), id: IdSchema })
    .strict()
    .nullable(),
  result: RunProductResultSchema,
  availableActions: z.array(RunAvailableActionSchema),
  llmCalls: z.array(LlmCallReceiptSchema),
  contextReceipts: z.array(ContextReceiptViewSchema),
  modelSnapshots: z.array(ModelAssignmentSnapshotViewSchema),
  reviews: z.array(ReviewReportViewSchema),
  streams: z.array(
    z.object({
      runId: IdSchema,
      stepId: IdSchema,
      attempt: z.number().int().positive(),
      content: z.string(),
      status: z.enum(["streaming", "completed", "interrupted"]),
      updatedAt: TimestampSchema,
    }),
  ),
  /**
   * Effective policy recovered from the persisted run.policy. Null for runs
   * created before the policy resolution milestone (their policy blob does
   * not contain the fully-resolved fields).
   */
  effectivePolicy: EffectivePolicySchema.nullable(),
});
export type RunDetailDto = z.infer<typeof RunDetailSchema>;
