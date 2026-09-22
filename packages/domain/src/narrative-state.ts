import type { IsoDateTime, ProjectId } from "./index.js";

export interface RelationshipEvent {
  id: string;
  projectId: ProjectId;
  fromEntityId: string;
  toEntityId: string;
  relation: string;
  intensity: number | null;
  state: Readonly<Record<string, unknown>>;
  outlineNodeId: string | null;
  storyTime: string | null;
  sourceId: string | null;
  supersedesEventId: string | null;
  createdAt: IsoDateTime;
}

export interface TimelineEvent {
  id: string;
  projectId: ProjectId;
  title: string;
  description: string | null;
  outlineNodeId: string | null;
  storyTimeStart: string | null;
  storyTimeEnd: string | null;
  sequence: number;
  participants: readonly string[];
  causes: readonly string[];
  visibility: "omniscient" | "reader" | "author_secret";
  sourceId: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type ForeshadowStatus =
  "planned" | "planted" | "developing" | "resolved" | "abandoned";

export interface Foreshadow {
  id: string;
  projectId: ProjectId;
  title: string;
  description: string;
  status: ForeshadowStatus;
  importance: 1 | 2 | 3 | 4 | 5;
  targetFromNodeId: string | null;
  targetToNodeId: string | null;
  dependencies: readonly string[];
  evidenceNodeIds: readonly string[];
  resolutionNodeId: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface KnowledgeRecord {
  id: string;
  projectId: ProjectId;
  knowerType: "reader" | "character";
  knowerEntityId: string | null;
  factId: string | null;
  timelineEventId: string | null;
  learnedAtNodeId: string;
  belief: "known" | "believed" | "suspected" | "false_belief";
  sourceId: string | null;
  createdAt: IsoDateTime;
}

export interface KnowledgeCorrection {
  recordId: string;
  projectId: ProjectId;
  replacementRecordId: string | null;
  reason: string;
  createdAt: IsoDateTime;
}

export interface NarrativeSummary {
  id: string;
  projectId: ProjectId;
  scopeType: "scene" | "chapter" | "arc" | "volume" | "book" | "session";
  scopeId: string;
  summary: string;
  stateDelta: Readonly<Record<string, unknown>>;
  sourceHash: string;
  createdAt: IsoDateTime;
}
