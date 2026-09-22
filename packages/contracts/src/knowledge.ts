import { z } from "zod";
import {
  CanonEntitySchema,
  CanonFactSchema,
  OutlineNodeSchema,
  TimelineEventSchema,
} from "./story.js";
import { KnowledgeRecordSchema } from "./story-state.js";

const Id = z.string().min(1).max(200);
export const KnowledgeCorrectionSchema = z.object({
  recordId: Id,
  projectId: Id,
  replacementRecordId: Id.nullable(),
  reason: z.string().trim().min(1).max(2000),
  createdAt: z.string(),
});

/** Author-side maintenance snapshot; never a character's generation context. */
export const KnowledgeEditorSchema = z.object({
  version: z.string(),
  records: z.array(KnowledgeRecordSchema),
  corrections: z.array(KnowledgeCorrectionSchema),
  entities: z.array(
    CanonEntitySchema.pick({ id: true, name: true, type: true, status: true }),
  ),
  facts: z.array(CanonFactSchema),
  withdrawnFactIds: z.array(Id),
  timeline: z.array(TimelineEventSchema),
  voidedEventIds: z.array(Id),
  outline: z.array(OutlineNodeSchema),
  eligibleNodeIds: z.array(Id),
});
export type KnowledgeEditorDto = z.infer<typeof KnowledgeEditorSchema>;

const writeBase = {
  requestId: Id,
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
};
const changeFields = {
  belief: KnowledgeRecordSchema.shape.belief,
  learnedAtNodeId: Id,
};
export const KnowledgeWriteSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        ...writeBase,
        ...changeFields,
        action: z.literal("register"),
        knowerType: KnowledgeRecordSchema.shape.knowerType,
        knowerEntityId: Id.nullable(),
        factId: Id.nullable(),
        timelineEventId: Id.nullable(),
      })
      .strict(),
    z
      .object({
        ...writeBase,
        ...changeFields,
        action: z.literal("correct"),
        recordId: Id,
        reason: KnowledgeCorrectionSchema.shape.reason,
      })
      .strict(),
    z
      .object({
        ...writeBase,
        action: z.literal("withdraw"),
        recordId: Id,
        reason: KnowledgeCorrectionSchema.shape.reason,
      })
      .strict(),
  ])
  .superRefine((input, context) => {
    if (input.action !== "register") return;
    if (Boolean(input.factId) === Boolean(input.timelineEventId))
      context.addIssue({
        code: "custom",
        path: ["factId"],
        message: "Choose exactly one claim",
      });
    if ((input.knowerType === "character") !== Boolean(input.knowerEntityId))
      context.addIssue({
        code: "custom",
        path: ["knowerEntityId"],
        message: "Only characters require a knower entity",
      });
  });
export type KnowledgeWrite = z.infer<typeof KnowledgeWriteSchema>;
export const KnowledgeWriteResultSchema = z.object({
  record: KnowledgeRecordSchema.nullable(),
  correction: KnowledgeCorrectionSchema.nullable(),
  idempotentReplay: z.boolean(),
});
export type KnowledgeWriteResult = z.infer<typeof KnowledgeWriteResultSchema>;
