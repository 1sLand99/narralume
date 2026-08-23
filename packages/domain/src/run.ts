import type { IsoDateTime, ProjectId } from "./index.js";

export const RUN_MODES = [
  "autopilot",
  "chapter-gate",
  "director",
  "co-create",
  "manual",
] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const RUN_STATUSES = [
  "pending",
  "running",
  "paused",
  "awaiting_user",
  "failed_recoverable",
  "failed",
  "cancelled",
  "completed",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type RunStepStatus =
  "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export type ChapterStepKind =
  | "context.compile"
  | "scene.plan"
  | "draft.generate"
  | "deterministic.check"
  | "semantic.review"
  | "revision.generate"
  | "chapter.settle"
  | "chapter.commit";

export type AutomationStepKind =
  | "foundation.generate"
  | "foundation.stage"
  | "outline.generate"
  | "outline.commit"
  | "steer.classify"
  | "arc.review"
  | "volume.review";

export type CollaborationStepKind =
  | "cocreate.context"
  | "cocreate.respond"
  | "cocreate.stage"
  | "adoption.prepare"
  | "adoption.settle"
  | "adoption.commit"
  | "edit.transform"
  | "edit.stage";

export type DeliveryStepKind =
  "import.analyze" | "import.stage" | "style.extract";

export type AssistantStepKind =
  "assistant.context" | "assistant.respond" | "assistant.stage";

export type CanonCandidateStepKind =
  "canon.context" | "canon.candidate" | "canon.stage";

export type RunStepKind =
  | ChapterStepKind
  | AutomationStepKind
  | CollaborationStepKind
  | DeliveryStepKind
  | AssistantStepKind
  | CanonCandidateStepKind;

export interface RunBudgetUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  costUsd: number;
  wallTimeMs: number;
}

export interface NarrativeRun {
  id: string;
  projectId: ProjectId;
  recipe: string;
  recipeVersion: number;
  mode: RunMode;
  status: RunStatus;
  targetOutlineNodeId: string | null;
  policy: Readonly<Record<string, unknown>>;
  budgetUsage: RunBudgetUsage;
  revisionCycle: number;
  pauseRequested: boolean;
  cancelRequested: boolean;
  currentStepId: string | null;
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  version: number;
}

export interface NarrativeRunStep {
  id: string;
  runId: string;
  ordinal: number;
  kind: RunStepKind;
  cycle: number;
  status: RunStepStatus;
  idempotencyKey: string;
  inputHash: string | null;
  outputArtifact: Readonly<Record<string, unknown>> | null;
  outputHash: string | null;
  error: RunStepError | null;
  attempt: number;
  maxAttempts: number;
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface RunStepError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
  usage?: RunBudgetUsage;
}

export interface NarrativeRunEvent {
  id: number;
  runId: string;
  stepId: string | null;
  sequence: number;
  type: string;
  payload: Readonly<Record<string, unknown>>;
  createdAt: IsoDateTime;
}

export interface NarrativeCheckpoint {
  id: string;
  runId: string;
  stepId: string | null;
  kind: string;
  state: Readonly<Record<string, unknown>>;
  stateHash: string;
  createdAt: IsoDateTime;
}

export interface RunSnapshot {
  run: NarrativeRun;
  steps: readonly NarrativeRunStep[];
  events: readonly NarrativeRunEvent[];
  latestCheckpoint: NarrativeCheckpoint | null;
}

export const ZERO_BUDGET_USAGE: RunBudgetUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  calls: 0,
  costUsd: 0,
  wallTimeMs: 0,
});
