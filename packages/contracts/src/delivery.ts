import { z } from "zod";

import { ModelExecutionPolicySchema } from "./execution-policy.js";

const IdSchema = z.string().trim().min(1).max(300);
const TimestampSchema = z.string().min(1);
const JsonObjectSchema = z.record(z.string(), z.unknown());
const StringListSchema = z.array(z.string().trim().min(1).max(20_000)).max(200);

export const StyleProfileSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  name: z.string(),
  description: z.string().nullable(),
  rules: StringListSchema,
  examples: StringListSchema,
  negativeRules: StringListSchema,
  source: z.string(),
  active: z.boolean(),
  status: z.enum(["active", "retired"]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  version: z.number().int().nonnegative(),
});
export const CreateStyleProfileRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(20_000).nullable().default(null),
  rules: StringListSchema.default([]),
  examples: StringListSchema.default([]),
  negativeRules: StringListSchema.default([]),
  active: z.boolean().default(false),
});
export const UpdateStyleProfileRequestSchema =
  CreateStyleProfileRequestSchema.extend({
    status: z.enum(["active", "retired"]).default("active"),
    expectedVersion: z.number().int().nonnegative(),
  });

export const WritingSkillScopeSchema = z.enum([
  "all",
  "chapter",
  "cocreate",
  "edit",
  "review",
]);
export const WritingSkillSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  name: z.string(),
  description: z.string().nullable(),
  instructions: z.string(),
  scopes: z.array(WritingSkillScopeSchema),
  priority: z.number().int().min(0).max(100),
  enabled: z.boolean(),
  source: z.string(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  version: z.number().int().nonnegative(),
});
export const CreateWritingSkillRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(20_000).nullable().default(null),
  instructions: z.string().trim().min(1).max(100_000),
  scopes: z.array(WritingSkillScopeSchema).min(1).max(5).default(["all"]),
  priority: z.number().int().min(0).max(100).default(50),
  enabled: z.boolean().default(true),
});
export const UpdateWritingSkillRequestSchema =
  CreateWritingSkillRequestSchema.extend({
    expectedVersion: z.number().int().nonnegative(),
  });

export const ImportWritingSkillPackageRequestSchema = z.object({
  filename: z.string().trim().min(1).max(500),
  contentBase64: z.string().min(1).max(20_000_000),
});
export const WritingSkillReferenceSchema = z.object({
  id: IdSchema,
  skillId: IdSchema,
  path: z.string(),
  content: z.string(),
  contentHash: z.string().length(64),
  createdAt: TimestampSchema,
});
export const WritingSkillPackageSchema = z.object({
  skill: WritingSkillSchema,
  references: z.array(WritingSkillReferenceSchema),
});
export const ValidateWritingSkillRequestSchema = z.object({
  scope: WritingSkillScopeSchema,
});
export const WritingSkillValidationSchema = z.object({
  valid: z.boolean(),
  applicable: z.boolean(),
  scope: WritingSkillScopeSchema,
  checks: z.array(
    z.object({
      id: z.string(),
      passed: z.boolean(),
      message: z.string(),
    }),
  ),
});

export const ImportFormatSchema = z.enum([
  "markdown",
  "text",
  "docx",
  "html",
  "epub",
  "narrative-bundle",
]);
export const ImportBatchSchema = z.object({
  id: IdSchema,
  targetProjectId: IdSchema.nullable(),
  filename: z.string(),
  format: ImportFormatSchema,
  sourceHash: z.string(),
  sourceCharacters: z.number().int().nonnegative(),
  status: z.enum(["previewed", "analyzing", "ready", "applied", "discarded"]),
  metadata: JsonObjectSchema,
  analysisRunId: IdSchema.nullable(),
  appliedProjectId: IdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export const ImportCandidateSchema = z.object({
  id: IdSchema,
  batchId: IdSchema,
  kind: z.enum([
    "project",
    "document",
    "outline",
    "intent",
    "entity",
    "style",
    "skill",
    "relationship",
    "timeline",
    "foreshadow",
    "character-arc",
    "scene-analysis",
  ]),
  ordinal: z.number().int().nonnegative(),
  title: z.string(),
  payload: JsonObjectSchema,
  status: z.enum(["pending", "selected", "discarded", "applied"]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export const ImportBatchDetailSchema = z.object({
  batch: ImportBatchSchema,
  candidates: z.array(ImportCandidateSchema),
});
export const CreateImportPreviewRequestSchema = z.object({
  targetProjectId: IdSchema.nullable().default(null),
  filename: z.string().trim().min(1).max(500),
  format: ImportFormatSchema,
  contentBase64: z.string().min(1).max(80_000_000),
});

export const CreateImportUploadRequestSchema = z.object({
  targetProjectId: IdSchema.nullable().default(null),
  filename: z.string().trim().min(1).max(500),
  format: ImportFormatSchema,
  totalBytes: z
    .number()
    .int()
    .min(1)
    .max(256 * 1024 * 1024),
  chunkSize: z
    .number()
    .int()
    .min(64 * 1024)
    .max(8 * 1024 * 1024),
  expectedHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable()
    .default(null),
});

export const ImportUploadSessionSchema = z.object({
  id: IdSchema,
  batchId: IdSchema.nullable(),
  targetProjectId: IdSchema.nullable(),
  filename: z.string(),
  format: ImportFormatSchema,
  totalBytes: z.number().int().positive(),
  chunkSize: z.number().int().positive(),
  expectedHash: z.string().nullable(),
  receivedBytes: z.number().int().nonnegative(),
  receivedChunks: z.number().int().nonnegative(),
  status: z.enum(["uploading", "completed", "expired", "discarded"]),
  expiresAt: TimestampSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const PutImportChunkRequestSchema = z.object({
  contentBase64: z.string().min(1).max(12_000_000),
  chunkHash: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const AnalyzeImportRequestSchema = z
  .object({
    requestId: IdSchema,
    policy: ModelExecutionPolicySchema.optional(),
  })
  .strict();
export const ExtractStyleRequestSchema = z
  .object({
    requestId: IdSchema,
    /** 样文下限 200 字：再短的文本提炼不出稳定的笔法规则。 */
    text: z.string().trim().min(200).max(20_000),
  })
  .strict();
export const DecideImportCandidateRequestSchema = z.object({
  status: z.enum(["selected", "discarded"]),
});
export const ApplyImportRequestSchema = z.object({
  action: z.enum(["apply", "discard"]),
  selectedCandidateIds: z.array(IdSchema).max(10_000).default([]),
  projectTitle: z.string().trim().min(1).max(300).optional(),
});

export const BundleCountsSchema = z.object({
  outline: z.number().int().nonnegative(),
  entities: z.number().int().nonnegative(),
  facts: z.number().int().nonnegative(),
  relationships: z.number().int().nonnegative(),
  timeline: z.number().int().nonnegative(),
  foreshadows: z.number().int().nonnegative(),
  documents: z.number().int().nonnegative(),
  versions: z.number().int().nonnegative(),
  drafts: z.number().int().nonnegative(),
  personas: z.number().int().nonnegative(),
  lorebooks: z.number().int().nonnegative(),
  loreEntries: z.number().int().nonnegative(),
  personaLorebookBindings: z.number().int().nonnegative(),
  sessionLorebookBindings: z.number().int().nonnegative(),
  styles: z.number().int().nonnegative(),
  skills: z.number().int().nonnegative(),
  annotations: z.number().int().nonnegative(),
  cover: z.number().int().nonnegative(),
  cocreateSessions: z.number().int().nonnegative(),
  storyTurns: z.number().int().nonnegative(),
  reviews: z.number().int().nonnegative(),
  reviewIssues: z.number().int().nonnegative(),
  assistantConversations: z.number().int().nonnegative(),
  assistantMessages: z.number().int().nonnegative(),
  assistantActivities: z.number().int().nonnegative(),
  assistantLongGoals: z.number().int().nonnegative(),
  runs: z.number().int().nonnegative(),
});
export type BundleCounts = z.infer<typeof BundleCountsSchema>;

export const ProjectBackupSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  label: z.string(),
  bundleHash: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  restoredProjectId: IdSchema.nullable(),
  counts: BundleCountsSchema.optional(),
});
export const CreateBackupRequestSchema = z.object({
  label: z.string().trim().min(1).max(300),
});
export const RestoreBackupRequestSchema = z.object({
  requestId: IdSchema,
  title: z.string().trim().min(1).max(300).optional(),
});

export const QualityIssueSchema = z.object({
  id: z.string(),
  category: z.enum([
    "structure",
    "manuscript",
    "canon",
    "continuity",
    "workflow",
  ]),
  severity: z.enum(["info", "warning", "error"]),
  message: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  suggestion: z.string(),
});
export const DeliveryGateSchema = z.object({
  id: z.string(),
  label: z.string(),
  passed: z.boolean(),
  message: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
});
export const ProjectQualityReportSchema = z.object({
  projectId: IdSchema,
  score: z.number().min(0).max(100),
  readiness: z.enum(["blocked", "needs_attention", "ready"]),
  gates: z.array(DeliveryGateSchema),
  generatedAt: TimestampSchema,
  metrics: z.record(z.string(), z.number()),
  issues: z.array(QualityIssueSchema),
});

export type StyleProfileDto = z.infer<typeof StyleProfileSchema>;
export type WritingSkillDto = z.infer<typeof WritingSkillSchema>;
export type ImportBatchDetailDto = z.infer<typeof ImportBatchDetailSchema>;
