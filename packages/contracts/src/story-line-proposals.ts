import { z } from "zod";
import { StoryCompassSchema, StoryLongLineSchema } from "./automation.js";
import { CanonCandidateDecisionSchema } from "./canon-candidate.js";

export const StoryLineProgressProposalSchema = z
  .object({
    lineIndex: z.number().int().nonnegative(),
    rationale: z.string().trim().min(1).max(4_000),
    status: StoryLongLineSchema.shape.status,
    progress: z.string().trim().min(1).max(4_000),
    openPromises: z.array(z.string().trim().min(1).max(1_000)).max(30),
    nextDevelopment: z.string().trim().max(4_000),
    evidenceChapterIds: z.array(z.string().min(1)).min(1).max(30),
  })
  .strict();

export const StoryLineProposalChangesSchema = z.object({
  kind: z.literal("story_line_progress"),
  scopeNodeId: z.string(),
  compass: StoryCompassSchema,
  evidenceFingerprint: z.string(),
  evidence: z.array(
    z.object({ chapterId: z.string(), title: z.string(), summary: z.string() }),
  ),
  items: z.array(StoryLineProgressProposalSchema),
});

export const StoryLineProposalSetSchema = z.object({
  id: z.string(),
  scopeNodeId: z.string(),
  createdAt: z.string(),
  stale: z.boolean(),
  evidence: StoryLineProposalChangesSchema.shape.evidence,
  items: z.array(
    z.object({
      id: z.string(),
      rationale: z.string(),
      before: StoryLongLineSchema,
      after: StoryLongLineSchema,
      decision: CanonCandidateDecisionSchema.nullable(),
    }),
  ),
});
export type StoryLineProposalSetDto = z.infer<
  typeof StoryLineProposalSetSchema
>;
export type StoryLineProgressProposal = z.infer<
  typeof StoryLineProgressProposalSchema
>;
