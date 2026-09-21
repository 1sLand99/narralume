import type { IsoDateTime, ProjectId } from "./index.js";
import type { RunMode } from "./run.js";

export type FoundationCandidateKind = "intent" | "compass" | "entity";
export type FoundationCandidateStatus = "pending" | "adopted" | "discarded";

export interface StoryLongLine {
  title: string;
  promise: string;
  status: "open" | "developing" | "resolved";
  /** Optional author-maintained stage record; absence means progress is not recorded. */
  development?:
    | {
        scopeNodeId: string | null;
        stageGoal: string;
        progress: string;
        openPromises: readonly string[];
        nextDevelopment: string;
        evidenceChapterIds: readonly string[];
      }
    | undefined;
}

export interface StoryCompass {
  projectId: ProjectId;
  corePromise: string;
  endingDirection: string | null;
  longLines: readonly StoryLongLine[];
  themeQuestions: readonly string[];
  target: Readonly<{
    chapters: number;
    wordsPerChapter: number;
    volumes: number;
  }>;
  constraints: readonly string[];
  version: number;
  updatedAt: IsoDateTime;
}

export interface FoundationCandidateSet {
  id: string;
  projectId: ProjectId;
  sourceRunId: string;
  title: string;
  status: "open" | "partially_adopted" | "adopted" | "discarded";
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface FoundationCandidate {
  id: string;
  setId: string;
  projectId: ProjectId;
  kind: FoundationCandidateKind;
  label: string;
  payload: Readonly<Record<string, unknown>>;
  editedPayload: Readonly<Record<string, unknown>> | null;
  status: FoundationCandidateStatus;
  adoptedRefType: string | null;
  adoptedRefId: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export const AUTOPILOT_SESSION_STATUSES = [
  "pending",
  "planning",
  "running",
  "paused",
  "awaiting_user",
  "failed",
  "cancelled",
  "completed",
] as const;
export type AutopilotSessionStatus =
  (typeof AUTOPILOT_SESSION_STATUSES)[number];

export interface AutopilotSession {
  id: string;
  projectId: ProjectId;
  mode: Extract<RunMode, "autopilot" | "chapter-gate">;
  status: AutopilotSessionStatus;
  targetChapters: number;
  windowSize: number;
  maxRevisionCycles: number;
  chapterPolicy: Readonly<Record<string, unknown>>;
  currentRunId: string | null;
  currentOutlineNodeId: string | null;
  completedChapters: number;
  skippedChapters: number;
  pauseRequested: boolean;
  cancelRequested: boolean;
  replanRequested: boolean;
  activeNotes: readonly string[];
  lastError: Readonly<Record<string, unknown>> | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
  version: number;
}

export type AutopilotRunRole = "rolling-plan" | "chapter" | "closing-review";

export interface AutopilotRunLink {
  sessionId: string;
  runId: string;
  role: AutopilotRunRole;
  outlineNodeId: string | null;
  sequence: number;
  createdAt: IsoDateTime;
  processedAt: IsoDateTime | null;
  outcome: string | null;
}

export const STEER_CLASSIFICATIONS = [
  "immediate_current",
  "next_scene",
  "future_plan",
  "canon_change",
  "rewrite_existing",
  "temporary_director_note",
] as const;
export type SteerClassification = (typeof STEER_CLASSIFICATIONS)[number];

export interface StorySteer {
  id: string;
  projectId: ProjectId;
  sessionId: string | null;
  targetRunId: string | null;
  content: string;
  classification: SteerClassification | null;
  status:
    | "pending"
    | "classifying"
    | "classified"
    | "applied"
    | "awaiting_confirmation"
    | "rejected";
  effectiveBoundary: "immediate" | "next_scene" | "next_chapter" | "future";
  rationale: string | null;
  risk: "low" | "medium" | "high" | null;
  classificationRunId: string | null;
  appliedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface PlanningReview {
  id: string;
  projectId: ProjectId;
  sessionId: string;
  runId: string;
  scopeType: "arc" | "volume";
  outlineNodeId: string;
  summary: string;
  scores: Readonly<Record<string, number>>;
  recommendations: readonly string[];
  sourceHash: string;
  createdAt: IsoDateTime;
}
