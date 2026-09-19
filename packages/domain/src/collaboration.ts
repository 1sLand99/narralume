import { sha256Hex } from "./crypto.js";
import { DomainError, type IsoDateTime, type ProjectId } from "./index.js";
import type { PersonaCardProfile } from "./persona-card.js";

export type PersonaKind = "author" | "narrator" | "character";
export type PersonaStatus = "active" | "retired";

export interface StoryPersona {
  id: string;
  projectId: ProjectId;
  kind: PersonaKind;
  entityId: string | null;
  name: string;
  description: string | null;
  instructions: string;
  voice: Readonly<Record<string, unknown>>;
  profile: PersonaCardProfile;
  status: PersonaStatus;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  version: number;
}

export interface CoCreateSession {
  id: string;
  projectId: ProjectId;
  title: string;
  status: "active" | "paused" | "archived";
  speakerPolicy: "manual" | "round_robin" | "natural";
  activeBranchId: string | null;
  targetOutlineNodeId: string | null;
  authorPersonaId: string | null;
  directorNote: string | null;
  contextTurns: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  version: number;
}

export interface CoCreateParticipant {
  sessionId: string;
  personaId: string;
  position: number;
  enabled: boolean;
  talkativeness: number;
  createdAt: IsoDateTime;
}

export const MAX_ACTIVE_COCREATE_AI_PARTICIPANTS = 8;

export interface NaturalSpeakerCandidate {
  personaId: string;
  name: string;
  position: number;
  enabled: boolean;
  talkativeness: number;
}

export interface SelectNaturalSpeakerInput {
  sessionId: string;
  branchId: string;
  headTurnId: string | null;
  requestId: string;
  candidates: readonly NaturalSpeakerCandidate[];
  requestedPersonaId?: string | null;
  recentAuthorInput?: string | null;
  previousSpeakerPersonaId?: string | null;
}

export interface NaturalSpeakerSelection {
  speakerPersonaId: string;
  reason: "explicit" | "mention" | "weighted";
  stableHash: string;
}

/**
 * Enforces the product limit for the AI participant list supplied by a caller.
 * Disabled participants remain in the room and do not count toward the limit.
 */
export function assertActiveCoCreateAiParticipantLimit(
  participants: readonly Pick<CoCreateParticipant, "enabled">[],
): void {
  const enabledCount = participants.filter(({ enabled }) => enabled).length;
  if (enabledCount > MAX_ACTIVE_COCREATE_AI_PARTICIPANTS) {
    throw new DomainError(
      "cocreate.participant.enabled_limit_exceeded",
      `A co-create session can enable at most ${MAX_ACTIVE_COCREATE_AI_PARTICIPANTS} AI participants`,
    );
  }
}

/**
 * Selects exactly one speaker before context compilation. The decision is pure:
 * equal input always returns the same speaker and hash.
 */
export function selectNaturalSpeaker(
  input: SelectNaturalSpeakerInput,
): NaturalSpeakerSelection {
  validateNaturalSpeakerSeed(input);
  validateNaturalSpeakerCandidates(input.candidates);
  assertActiveCoCreateAiParticipantLimit(input.candidates);

  const stableHash = sha256Hex(
    JSON.stringify([
      input.sessionId,
      input.branchId,
      input.headTurnId,
      input.requestId,
    ]),
  );
  const enabled = input.candidates
    .filter(({ enabled: isEnabled }) => isEnabled)
    .toSorted(compareNaturalSpeakerCandidates);

  const requestedPersonaId = input.requestedPersonaId?.trim();
  if (requestedPersonaId) {
    const requested = enabled.find(
      ({ personaId }) => personaId === requestedPersonaId,
    );
    if (!requested) {
      throw new DomainError(
        "cocreate.speaker.unavailable",
        "The requested speaker is not enabled in this co-create session",
      );
    }
    return {
      speakerPersonaId: requested.personaId,
      reason: "explicit",
      stableHash,
    };
  }

  if (enabled.length === 0) throwNoNaturalSpeakerCandidate();

  const mentioned = findLastMentionedCandidate(
    input.recentAuthorInput ?? "",
    enabled,
  );
  if (mentioned) {
    return {
      speakerPersonaId: mentioned.personaId,
      reason: "mention",
      stableHash,
    };
  }

  const willing = enabled.filter(({ talkativeness }) => talkativeness > 0);
  if (willing.length === 0) throwNoNaturalSpeakerCandidate();

  const withoutPrevious = willing.filter(
    ({ personaId }) => personaId !== input.previousSpeakerPersonaId,
  );
  const weightedPool = withoutPrevious.length > 0 ? withoutPrevious : willing;
  const totalWeight = weightedPool.reduce(
    (total, { talkativeness }) => total + talkativeness,
    0,
  );
  let target = hashFraction(stableHash) * totalWeight;
  for (const candidate of weightedPool) {
    target -= candidate.talkativeness;
    if (target < 0) {
      return {
        speakerPersonaId: candidate.personaId,
        reason: "weighted",
        stableHash,
      };
    }
  }

  // Floating-point rounding can only leave the target on the upper boundary.
  return {
    speakerPersonaId: weightedPool.at(-1)!.personaId,
    reason: "weighted",
    stableHash,
  };
}

export interface StoryBranch {
  id: string;
  sessionId: string;
  parentBranchId: string | null;
  forkedFromTurnId: string | null;
  name: string;
  status: "active" | "archived";
  headTurnId: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type StoryTurnRole = "user" | "assistant" | "director" | "system";

export interface StoryTurn {
  id: string;
  projectId: ProjectId;
  sessionId: string;
  branchId: string;
  parentTurnId: string | null;
  ordinal: number;
  role: StoryTurnRole;
  personaId: string | null;
  content: string;
  status: "active" | "reverted" | "adopted";
  selectedSwipeId: string | null;
  sourceRunId: string | null;
  metadata: Readonly<Record<string, unknown>>;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface TurnSwipe {
  id: string;
  turnId: string;
  ordinal: number;
  content: string;
  speakerPersonaId: string | null;
  sourceRunId: string | null;
  status: "candidate" | "selected" | "rejected";
  metadata: Readonly<Record<string, unknown>>;
  createdAt: IsoDateTime;
}

export interface SceneAdoption {
  id: string;
  projectId: ProjectId;
  sessionId: string;
  branchId: string;
  fromTurnId: string;
  toTurnId: string;
  outlineNodeId: string;
  documentId: string;
  documentVersionId: string;
  runId: string;
  canonChangeSetId: string | null;
  createdAt: IsoDateTime;
}

export interface DocumentComment {
  id: string;
  projectId: ProjectId;
  documentId: string;
  versionId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
  body: string;
  status: "open" | "resolved";
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface EditProposal {
  id: string;
  projectId: ProjectId;
  documentId: string;
  baseVersionId: string;
  runId: string;
  instruction: string;
  selectionStart: number;
  selectionEnd: number;
  originalText: string;
  replacementText: string;
  proposedContent: string;
  diff: Readonly<Record<string, unknown>>;
  status: "proposed" | "accepted" | "rejected" | "superseded";
  acceptedVersionId: string | null;
  createdAt: IsoDateTime;
  decidedAt: IsoDateTime | null;
}

export function validateTextRange(
  content: string,
  start: number,
  end: number,
): void {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > content.length
  ) {
    throw new DomainError(
      "text.range.invalid",
      "Text selection is outside the current version range",
    );
  }
}

export function requireCreativeText(
  value: string,
  code: string,
  label: string,
): string {
  const text = value.trim();
  if (!text) throw new DomainError(code, `${label} must not be empty`);
  return text;
}

function validateNaturalSpeakerSeed(input: SelectNaturalSpeakerInput): void {
  if (
    !input.sessionId.trim() ||
    !input.branchId.trim() ||
    !input.requestId.trim()
  ) {
    throw new DomainError(
      "cocreate.speaker.seed_invalid",
      "Natural speaker selection requires session, branch, and request ids",
    );
  }
}

function validateNaturalSpeakerCandidates(
  candidates: readonly NaturalSpeakerCandidate[],
): void {
  const personaIds = new Set<string>();
  for (const candidate of candidates) {
    if (
      !candidate.personaId.trim() ||
      !candidate.name.trim() ||
      !Number.isInteger(candidate.position) ||
      candidate.position < 0
    ) {
      throw new DomainError(
        "cocreate.speaker.candidate_invalid",
        "Natural speaker candidates require an id, name, and valid position",
      );
    }
    if (personaIds.has(candidate.personaId)) {
      throw new DomainError(
        "cocreate.participant.duplicate",
        "The same persona cannot join the session more than once",
      );
    }
    personaIds.add(candidate.personaId);
    if (
      !Number.isFinite(candidate.talkativeness) ||
      candidate.talkativeness < 0 ||
      candidate.talkativeness > 1
    ) {
      throw new DomainError(
        "cocreate.talkativeness.invalid",
        "Speaking tendency must be between 0 and 1",
      );
    }
  }
}

function compareNaturalSpeakerCandidates(
  left: NaturalSpeakerCandidate,
  right: NaturalSpeakerCandidate,
): number {
  if (left.position !== right.position) return left.position - right.position;
  if (left.personaId === right.personaId) return 0;
  return left.personaId < right.personaId ? -1 : 1;
}

function findLastMentionedCandidate(
  authorInput: string,
  candidates: readonly NaturalSpeakerCandidate[],
): NaturalSpeakerCandidate | null {
  const text = normalizeMentionText(authorInput);
  if (!text) return null;

  let best:
    | {
        candidate: NaturalSpeakerCandidate;
        index: number;
        nameLength: number;
      }
    | undefined;
  for (const candidate of candidates) {
    const name = normalizeMentionText(candidate.name);
    const index = lastCompleteMentionIndex(text, name);
    if (index < 0) continue;
    if (
      best === undefined ||
      index > best.index ||
      (index === best.index && name.length > best.nameLength)
    ) {
      best = { candidate, index, nameLength: name.length };
    }
  }
  return best?.candidate ?? null;
}

function lastCompleteMentionIndex(text: string, name: string): number {
  let index = text.lastIndexOf(name);
  while (index >= 0) {
    const before = index > 0 ? text[index - 1] : undefined;
    const after = text[index + name.length];
    const hasCompleteStart =
      !isAsciiWordCharacter(name[0]) || !isAsciiWordCharacter(before);
    const hasCompleteEnd =
      !isAsciiWordCharacter(name.at(-1)) || !isAsciiWordCharacter(after);
    if (hasCompleteStart && hasCompleteEnd) {
      return index;
    }
    index = index === 0 ? -1 : text.lastIndexOf(name, index - 1);
  }
  return -1;
}

function normalizeMentionText(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function isAsciiWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /^[a-z0-9_]$/iu.test(value);
}

function hashFraction(hash: string): number {
  return Number.parseInt(hash.slice(0, 13), 16) / 0x10_0000_0000_0000;
}

function throwNoNaturalSpeakerCandidate(): never {
  throw new DomainError(
    "cocreate.speaker.no_candidate",
    "No enabled co-create participant is eligible to speak",
  );
}
