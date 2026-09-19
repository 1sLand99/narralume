import { DomainError, type IsoDateTime, type ProjectId } from "./index.js";

export const LORE_SCOPES = ["project", "persona", "session"] as const;
export type LoreScope = (typeof LORE_SCOPES)[number];

export interface Lorebook {
  id: string;
  projectId: ProjectId;
  name: string;
  description: string | null;
  enabledGlobally: boolean;
  scanTurns: number;
  enabled: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  version: number;
}

export interface LoreEntry {
  id: string;
  lorebookId: string;
  title: string;
  content: string;
  keys: readonly string[];
  constant: boolean;
  priority: number;
  enabled: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  version: number;
}

export interface LoreActivationCandidate {
  lorebook: Lorebook;
  entry: LoreEntry;
  scope: LoreScope;
  /** Project, Persona, or story-room id selected by `scope`. */
  scopeId: string;
}

export interface ActivateLoreEntriesInput {
  projectId: ProjectId;
  personaId: string;
  sessionId: string;
  /** Effective selected-branch turns in chronological order. */
  recentTurns: readonly string[];
  /** Current author input is scanned in addition to each book's turn window. */
  authorInput: string | null;
  budgetChars: number;
  candidates: readonly LoreActivationCandidate[];
}

export type LoreActivationDecisionStatus =
  | "activated-constant"
  | "activated-key"
  | "excluded-disabled"
  | "excluded-scope"
  | "excluded-no-match"
  | "excluded-budget";

export interface LoreActivationDecision {
  entryId: string;
  scope: LoreScope;
  status: LoreActivationDecisionStatus;
  matchedKeys: readonly string[];
}

export interface ActivatedLoreEntry {
  entryId: string;
  lorebookId: string;
  scope: LoreScope;
  title: string;
  content: string;
  priority: number;
  matchedKeys: readonly string[];
}

export interface LoreActivationResult {
  activated: readonly ActivatedLoreEntry[];
  decisions: readonly LoreActivationDecision[];
  usedChars: number;
}

interface IndexedCandidate {
  candidate: LoreActivationCandidate;
  index: number;
}

const SCOPE_RANK: Readonly<Record<LoreScope, number>> = {
  project: 0,
  persona: 1,
  session: 2,
};

/**
 * Deterministically activates non-canonical lore references. Callers provide
 * only selected-branch turn text; this function applies each book's own scan
 * window, resolves overlapping scopes, matches keys, and spends the lore-only
 * character budget in stable priority order.
 */
export function activateLoreEntries(
  input: ActivateLoreEntriesInput,
): LoreActivationResult {
  validateActivationInput(input);
  const indexed = input.candidates.map((candidate, index) => ({
    candidate,
    index,
  }));
  const ordered = indexed.toSorted(compareIndexedCandidates);
  const selectedByEntry = selectClosestScopes(input, ordered);
  const decisions: LoreActivationDecision[] = [];
  const activated: ActivatedLoreEntry[] = [];
  let usedChars = 0;

  for (const indexedCandidate of ordered) {
    const { candidate } = indexedCandidate;
    const baseDecision = {
      entryId: candidate.entry.id,
      scope: candidate.scope,
    } as const;

    if (!candidate.lorebook.enabled || !candidate.entry.enabled) {
      decisions.push({
        ...baseDecision,
        status: "excluded-disabled",
        matchedKeys: [],
      });
      continue;
    }
    if (selectedByEntry.get(candidate.entry.id) !== indexedCandidate) {
      decisions.push({
        ...baseDecision,
        status: "excluded-scope",
        matchedKeys: [],
      });
      continue;
    }
    const matchedKeys = candidate.entry.constant
      ? []
      : findMatchedLoreKeys(
          candidate.entry.keys,
          activationTexts(input, candidate.lorebook.scanTurns),
        );
    if (!candidate.entry.constant && matchedKeys.length === 0) {
      decisions.push({
        ...baseDecision,
        status: "excluded-no-match",
        matchedKeys,
      });
      continue;
    }

    const nextUsedChars = usedChars + candidate.entry.content.length;
    if (nextUsedChars > input.budgetChars) {
      decisions.push({
        ...baseDecision,
        status: "excluded-budget",
        matchedKeys,
      });
      continue;
    }

    usedChars = nextUsedChars;
    const status = candidate.entry.constant
      ? "activated-constant"
      : "activated-key";
    decisions.push({ ...baseDecision, status, matchedKeys });
    activated.push({
      entryId: candidate.entry.id,
      lorebookId: candidate.lorebook.id,
      scope: candidate.scope,
      title: candidate.entry.title,
      content: candidate.entry.content,
      priority: candidate.entry.priority,
      matchedKeys,
    });
  }

  return { activated, decisions, usedChars };
}

export function normalizeLoreMatchText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function validateActivationInput(input: ActivateLoreEntriesInput): void {
  if (
    !input.projectId.trim() ||
    !input.personaId.trim() ||
    !input.sessionId.trim() ||
    !Number.isSafeInteger(input.budgetChars) ||
    input.budgetChars < 0
  ) {
    throw new DomainError(
      "lore.activation.input.invalid",
      "Lore activation requires valid project, Persona, session, and budget values",
    );
  }
  const fingerprints = new Map<string, string>();
  for (const { lorebook, entry, scopeId } of input.candidates) {
    if (
      !lorebook.id.trim() ||
      !entry.id.trim() ||
      entry.lorebookId !== lorebook.id ||
      !scopeId.trim() ||
      !Number.isSafeInteger(lorebook.scanTurns) ||
      lorebook.scanTurns < 0 ||
      !Number.isSafeInteger(entry.priority)
    ) {
      throw new DomainError(
        "lore.activation.candidate.invalid",
        "Lore activation candidates require consistent ids, scan windows, and priorities",
      );
    }
    const fingerprint = JSON.stringify([
      lorebook.id,
      lorebook.projectId,
      lorebook.enabledGlobally,
      lorebook.scanTurns,
      lorebook.enabled,
      entry.lorebookId,
      entry.title,
      entry.content,
      entry.keys,
      entry.constant,
      entry.priority,
      entry.enabled,
    ]);
    const existing = fingerprints.get(entry.id);
    if (existing !== undefined && existing !== fingerprint) {
      throw new DomainError(
        "lore.activation.candidate.conflict",
        "Duplicate Lore activation candidates must contain the same entry and Lorebook state",
      );
    }
    fingerprints.set(entry.id, fingerprint);
  }
}

function selectClosestScopes(
  input: ActivateLoreEntriesInput,
  ordered: readonly IndexedCandidate[],
): Map<string, IndexedCandidate> {
  const selected = new Map<string, IndexedCandidate>();
  for (const indexedCandidate of ordered) {
    const { candidate } = indexedCandidate;
    if (!isCandidateInScope(input, candidate)) continue;
    const current = selected.get(candidate.entry.id);
    if (
      !current ||
      SCOPE_RANK[candidate.scope] > SCOPE_RANK[current.candidate.scope]
    ) {
      selected.set(candidate.entry.id, indexedCandidate);
    }
  }
  return selected;
}

function isCandidateInScope(
  input: ActivateLoreEntriesInput,
  candidate: LoreActivationCandidate,
): boolean {
  if (candidate.lorebook.projectId !== input.projectId) return false;
  switch (candidate.scope) {
    case "project":
      return (
        candidate.scopeId === input.projectId &&
        candidate.lorebook.enabledGlobally
      );
    case "persona":
      return candidate.scopeId === input.personaId;
    case "session":
      return candidate.scopeId === input.sessionId;
  }
}

function activationTexts(
  input: ActivateLoreEntriesInput,
  scanTurns: number,
): readonly string[] {
  const texts = scanTurns === 0 ? [] : input.recentTurns.slice(-scanTurns);
  return input.authorInput === null ? texts : [...texts, input.authorInput];
}

function findMatchedLoreKeys(
  keys: readonly string[],
  texts: readonly string[],
): string[] {
  const normalizedTexts = texts.map(normalizeLoreMatchText);
  const seen = new Set<string>();
  const matched: string[] = [];
  for (const key of keys) {
    const normalizedKey = normalizeLoreMatchText(key);
    if (
      !normalizedKey ||
      seen.has(normalizedKey) ||
      !normalizedTexts.some((text) => text.includes(normalizedKey))
    ) {
      continue;
    }
    seen.add(normalizedKey);
    matched.push(key);
  }
  return matched;
}

function compareIndexedCandidates(
  left: IndexedCandidate,
  right: IndexedCandidate,
): number {
  const leftCandidate = left.candidate;
  const rightCandidate = right.candidate;
  return (
    rightCandidate.entry.priority - leftCandidate.entry.priority ||
    SCOPE_RANK[rightCandidate.scope] - SCOPE_RANK[leftCandidate.scope] ||
    compareStrings(leftCandidate.entry.id, rightCandidate.entry.id) ||
    compareStrings(leftCandidate.lorebook.id, rightCandidate.lorebook.id) ||
    compareStrings(leftCandidate.scopeId, rightCandidate.scopeId) ||
    left.index - right.index
  );
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
