import { z } from "zod";
import {
  CanonEntitySchema,
  CanonFactSchema,
  ForeshadowSchema,
  RelationshipEventSchema,
  TimelineEventSchema,
} from "./story.js";

const IdSchema = z.string().min(1).max(200);
export const StoryStateQuerySchema = z.discriminatedUnion("audience", [
  z.object({ chapterId: IdSchema, audience: z.literal("author") }).strict(),
  z.object({ chapterId: IdSchema, audience: z.literal("reader") }).strict(),
  z
    .object({
      chapterId: IdSchema,
      audience: z.literal("character"),
      characterId: IdSchema,
    })
    .strict(),
]);
export type StoryStateQuery = z.infer<typeof StoryStateQuerySchema>;

export const KnowledgeRecordSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  knowerType: z.enum(["reader", "character"]),
  knowerEntityId: IdSchema.nullable(),
  factId: IdSchema.nullable(),
  timelineEventId: IdSchema.nullable(),
  learnedAtNodeId: IdSchema,
  belief: z.enum(["known", "believed", "suspected", "false_belief"]),
  sourceId: IdSchema.nullable(),
  createdAt: z.string(),
});

export const StoryStateSnapshotSchema = z.object({
  chapterId: IdSchema,
  audience: z.enum(["author", "reader", "character"]),
  characterId: IdSchema.nullable(),
  entities: z.array(
    CanonEntitySchema.pick({ id: true, name: true, type: true, status: true }),
  ),
  facts: z.array(CanonFactSchema),
  knowledge: z.array(
    z.object({
      record: KnowledgeRecordSchema,
      fact: CanonFactSchema.nullable(),
      event: TimelineEventSchema.pick({
        id: true,
        title: true,
        outlineNodeId: true,
      }).nullable(),
    }),
  ),
  relationships: z.array(RelationshipEventSchema),
  timeline: z.array(TimelineEventSchema),
  foreshadows: z.array(
    ForeshadowSchema.pick({
      id: true,
      title: true,
      description: true,
      importance: true,
      targetFromNodeId: true,
      targetToNodeId: true,
      evidenceNodeIds: true,
      resolutionNodeId: true,
    }).extend({ currentStatus: ForeshadowSchema.shape.status }),
  ),
});
export type StoryStateSnapshotDto = z.infer<typeof StoryStateSnapshotSchema>;
