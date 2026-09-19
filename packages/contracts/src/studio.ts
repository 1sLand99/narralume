import { z } from "zod";

import { ModelExecutionPolicySchema } from "./execution-policy.js";
import {
  NarrativeRunSchema,
  RunAvailableActionSchema,
  RunOriginSchema,
  RunProductResultSchema,
} from "./run.js";
import { DocumentSchema, DocumentVersionSchema } from "./story.js";
import {
  PersonaCardImportReportSchema,
  PersonaCardProfileSchema,
} from "./persona-card.js";

const IdSchema = z.string().trim().min(1).max(300);
const TimestampSchema = z.string().min(1);
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const PersonaKindSchema = z.enum(["author", "narrator", "character"]);
export const StoryPersonaSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  kind: PersonaKindSchema,
  entityId: IdSchema.nullable(),
  name: z.string(),
  description: z.string().nullable(),
  instructions: z.string(),
  voice: JsonObjectSchema,
  profile: PersonaCardProfileSchema,
  status: z.enum(["active", "retired"]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  version: z.number().int().nonnegative(),
});
export const PersonaCardImportResponseSchema = z
  .object({
    persona: StoryPersonaSchema,
    report: PersonaCardImportReportSchema,
    idempotentReplay: z.boolean(),
  })
  .strict();
export const CreatePersonaRequestSchema = z.object({
  kind: PersonaKindSchema,
  entityId: IdSchema.nullable().default(null),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(20_000).nullable().default(null),
  instructions: z.string().trim().max(30_000).default(""),
  voice: JsonObjectSchema.default({}),
  profile: PersonaCardProfileSchema.default(() => ({
    personality: null,
    scenario: null,
    exampleDialogue: null,
    greetings: [],
    creator: { name: null, notes: null, version: null, tags: [] },
    source: { format: "native" as const, importedAt: null },
  })),
});
export const UpdatePersonaRequestSchema = CreatePersonaRequestSchema.extend({
  profile: PersonaCardProfileSchema,
  status: z.enum(["active", "retired"]).default("active"),
  expectedVersion: z.number().int().nonnegative(),
});

export const CoCreateSessionSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  title: z.string(),
  status: z.enum(["active", "paused", "archived"]),
  speakerPolicy: z.enum(["manual", "round_robin", "natural"]),
  activeBranchId: IdSchema.nullable(),
  targetOutlineNodeId: IdSchema.nullable(),
  authorPersonaId: IdSchema.nullable(),
  directorNote: z.string().nullable(),
  contextTurns: z.number().int().min(4).max(200),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  version: z.number().int().nonnegative(),
});

export const CoCreateParticipantSchema = z.object({
  sessionId: IdSchema,
  personaId: IdSchema,
  position: z.number().int().nonnegative(),
  enabled: z.boolean(),
  talkativeness: z.number().min(0).max(1),
  createdAt: TimestampSchema,
  persona: StoryPersonaSchema,
});

export const StoryBranchSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  parentBranchId: IdSchema.nullable(),
  forkedFromTurnId: IdSchema.nullable(),
  name: z.string(),
  status: z.enum(["active", "archived"]),
  headTurnId: IdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const TurnSwipeSchema = z.object({
  id: IdSchema,
  turnId: IdSchema,
  ordinal: z.number().int().nonnegative(),
  content: z.string(),
  speakerPersonaId: IdSchema.nullable(),
  sourceRunId: IdSchema.nullable(),
  status: z.enum(["candidate", "selected", "rejected"]),
  metadata: JsonObjectSchema,
  createdAt: TimestampSchema,
});

export const StoryTurnSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  sessionId: IdSchema,
  branchId: IdSchema,
  parentTurnId: IdSchema.nullable(),
  ordinal: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant", "director", "system"]),
  personaId: IdSchema.nullable(),
  content: z.string(),
  status: z.enum(["active", "reverted", "adopted"]),
  selectedSwipeId: IdSchema.nullable(),
  sourceRunId: IdSchema.nullable(),
  metadata: JsonObjectSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  swipes: z.array(TurnSwipeSchema),
});

export const SceneAdoptionSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  sessionId: IdSchema,
  branchId: IdSchema,
  fromTurnId: IdSchema,
  toTurnId: IdSchema,
  outlineNodeId: IdSchema,
  documentId: IdSchema,
  documentVersionId: IdSchema,
  runId: IdSchema,
  canonChangeSetId: IdSchema.nullable(),
  createdAt: TimestampSchema,
});

export const CoCreateSessionDetailSchema = z.object({
  session: CoCreateSessionSchema,
  participants: z.array(CoCreateParticipantSchema),
  branches: z.array(StoryBranchSchema),
  turns: z.array(StoryTurnSchema),
  adoptions: z.array(SceneAdoptionSchema),
});

export const CoCreateOpeningSchema = z
  .object({
    personaId: IdSchema,
    greetingIndex: z.number().int().nonnegative(),
  })
  .strict();

export const CreateCoCreateSessionRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    speakerPolicy: z
      .enum(["manual", "round_robin", "natural"])
      .default("natural"),
    targetOutlineNodeId: IdSchema.nullable().default(null),
    authorPersonaId: IdSchema.nullable().default(null),
    directorNote: z.string().trim().max(30_000).nullable().default(null),
    contextTurns: z.number().int().min(4).max(200).default(24),
    participantIds: z.array(IdSchema).max(8).default([]),
    opening: CoCreateOpeningSchema.nullable().default(null),
  })
  .strict();

export const UpdateCoCreateSessionRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    status: z.enum(["active", "paused", "archived"]).optional(),
    speakerPolicy: z.enum(["manual", "round_robin", "natural"]).optional(),
    targetOutlineNodeId: IdSchema.nullable().optional(),
    authorPersonaId: IdSchema.nullable().optional(),
    directorNote: z.string().trim().max(30_000).nullable().optional(),
    contextTurns: z.number().int().min(4).max(200).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export const ReplaceParticipantsRequestSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    participants: z
      .array(
        z.object({
          personaId: IdSchema,
          enabled: z.boolean().default(true),
          talkativeness: z.number().min(0).max(1).default(0.5),
        }),
      )
      .max(30),
  })
  .superRefine((value, context) => {
    const enabledCount = value.participants.filter(
      (participant) => participant.enabled,
    ).length;
    if (enabledCount < 1 || enabledCount > 8) {
      context.addIssue({
        code: "custom",
        path: ["participants"],
        message:
          "A story room must enable between one and eight AI participants",
      });
    }
  });

export const CreateStoryTurnRequestSchema = z
  .object({
    requestId: IdSchema,
    role: z.enum(["user", "director"]).default("user"),
    personaId: IdSchema.nullable().default(null),
    content: z.string().trim().min(1).max(100_000),
    generateReply: z.boolean().default(true),
    speakerPersonaId: IdSchema.nullable().default(null),
    policy: ModelExecutionPolicySchema.optional(),
  })
  .strict();

export const GenerateSwipeRequestSchema = z
  .object({
    requestId: IdSchema,
    speakerPersonaId: IdSchema.nullable().default(null),
  })
  .strict();
export const SelectSwipeRequestSchema = z.object({ swipeId: IdSchema });
export const CreateBranchRequestSchema = z.object({
  fromTurnId: IdSchema,
  name: z.string().trim().min(1).max(200),
  expectedVersion: z.number().int().nonnegative(),
});
export const SelectBranchRequestSchema = z.object({
  branchId: IdSchema,
  expectedVersion: z.number().int().nonnegative(),
});
export const RevertTurnRequestSchema = z.object({
  action: z.literal("revert"),
});

export const CreateSceneAdoptionRequestSchema = z.object({
  requestId: IdSchema,
  branchId: IdSchema,
  fromTurnId: IdSchema,
  toTurnId: IdSchema,
  title: z.string().trim().min(1).max(300),
});

export const DocumentCommentSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  documentId: IdSchema,
  versionId: IdSchema,
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  quote: z.string(),
  body: z.string(),
  status: z.enum(["open", "resolved"]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export const CreateDocumentCommentRequestSchema = z.object({
  versionId: IdSchema,
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  quote: z.string().min(1).max(100_000),
  body: z.string().trim().min(1).max(30_000),
});
export const UpdateDocumentCommentRequestSchema = z.object({
  status: z.enum(["open", "resolved"]),
});

export const EditProposalSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  documentId: IdSchema,
  baseVersionId: IdSchema,
  runId: IdSchema,
  instruction: z.string(),
  selectionStart: z.number().int().nonnegative(),
  selectionEnd: z.number().int().positive(),
  originalText: z.string(),
  replacementText: z.string(),
  proposedContent: z.string(),
  diff: JsonObjectSchema,
  status: z.enum(["proposed", "accepted", "rejected", "superseded"]),
  acceptedVersionId: IdSchema.nullable(),
  createdAt: TimestampSchema,
  decidedAt: TimestampSchema.nullable(),
});
export const CreateSelectionEditRequestSchema = z
  .object({
    baseVersionId: IdSchema,
    draftContentHash: z.string().length(64).nullable().default(null),
    selectionStart: z.number().int().nonnegative(),
    selectionEnd: z.number().int().positive(),
    instruction: z.string().trim().min(1).max(20_000),
    policy: ModelExecutionPolicySchema.optional(),
  })
  .strict();
export const DecideEditProposalRequestSchema = z.object({
  requestId: IdSchema,
  action: z.enum(["accept", "reject"]),
});

export const DocumentDraftSchema = z.object({
  projectId: IdSchema,
  documentId: IdSchema,
  baseVersionId: IdSchema.nullable(),
  content: z.string(),
  contentHash: z.string(),
  updatedAt: TimestampSchema,
});
export const SaveDocumentDraftRequestSchema = z.object({
  baseVersionId: IdSchema.nullable(),
  /** 客户端最近一次见到的草稿 updatedAt；null 断言当前没有草稿。 */
  expectedDraftUpdatedAt: TimestampSchema.nullable(),
  content: z.string().max(5_000_000),
});
export const SetDocumentArchivedRequestSchema = z.object({
  archived: z.boolean(),
  expectedUpdatedAt: TimestampSchema,
});

export const StudioDocumentDetailSchema = z.object({
  document: DocumentSchema,
  currentVersion: DocumentVersionSchema.nullable(),
  draft: DocumentDraftSchema.nullable(),
  versions: z.array(DocumentVersionSchema),
  comments: z.array(DocumentCommentSchema),
  proposals: z.array(EditProposalSchema),
});

export const CreativeRunCreatedSchema = z.object({
  run: NarrativeRunSchema,
  turn: StoryTurnSchema.optional(),
  origin: RunOriginSchema.nullable(),
  result: RunProductResultSchema,
  availableActions: z.array(RunAvailableActionSchema),
});

export type StoryPersonaDto = z.infer<typeof StoryPersonaSchema>;
export type PersonaCardImportResponse = z.infer<
  typeof PersonaCardImportResponseSchema
>;
export type CoCreateOpening = z.infer<typeof CoCreateOpeningSchema>;
export type CreateCoCreateSessionRequest = z.infer<
  typeof CreateCoCreateSessionRequestSchema
>;
export type CoCreateSessionDto = z.infer<typeof CoCreateSessionSchema>;
export type CoCreateSessionDetailDto = z.infer<
  typeof CoCreateSessionDetailSchema
>;
export type StudioDocumentDetailDto = z.infer<
  typeof StudioDocumentDetailSchema
>;
