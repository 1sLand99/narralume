import { describe, expect, it } from "vitest";

import {
  assertActiveCoCreateAiParticipantLimit,
  DomainError,
  MAX_ACTIVE_COCREATE_AI_PARTICIPANTS,
  selectNaturalSpeaker,
  sha256Hex,
  type NaturalSpeakerCandidate,
  type SelectNaturalSpeakerInput,
} from "../src/index.js";

const baseCandidates: readonly NaturalSpeakerCandidate[] = [
  {
    personaId: "lin-zhao",
    name: "林昭",
    position: 0,
    enabled: true,
    talkativeness: 0.4,
  },
  {
    personaId: "alice-smith",
    name: "Alice Smith",
    position: 1,
    enabled: true,
    talkativeness: 0.6,
  },
];

function select(
  overrides: Partial<SelectNaturalSpeakerInput> = {},
): ReturnType<typeof selectNaturalSpeaker> {
  return selectNaturalSpeaker({
    sessionId: "session-1",
    branchId: "branch-1",
    headTurnId: "turn-7",
    requestId: "request-1",
    candidates: baseCandidates,
    ...overrides,
  });
}

function expectDomainCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error("Expected a domain error");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

describe("natural co-create speaker selection", () => {
  it("gives an explicitly requested enabled speaker highest priority", () => {
    const selection = select({
      requestedPersonaId: "lin-zhao",
      recentAuthorInput: "Alice Smith，请你回答。",
      candidates: [
        { ...baseCandidates[0]!, talkativeness: 0 },
        baseCandidates[1]!,
      ],
    });

    expect(selection).toMatchObject({
      speakerPersonaId: "lin-zhao",
      reason: "explicit",
    });
    expect(selection.stableHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects an explicit speaker who is not enabled", () => {
    expectDomainCode(
      () =>
        select({
          requestedPersonaId: "lin-zhao",
          candidates: [
            { ...baseCandidates[0]!, enabled: false },
            baseCandidates[1]!,
          ],
        }),
      "cocreate.speaker.unavailable",
    );
  });

  it("uses the last complete name mention and permits a quiet role to answer", () => {
    const selection = select({
      recentAuthorInput:
        "Alice Smithson 不在场。林昭先等等，最后请 ALICE SMITH 接话。",
      candidates: [
        baseCandidates[0]!,
        { ...baseCandidates[1]!, talkativeness: 0 },
      ],
    });

    expect(selection).toMatchObject({
      speakerPersonaId: "alice-smith",
      reason: "mention",
    });
  });

  it("does not treat a partial ASCII name as a mention", () => {
    const selection = select({
      recentAuthorInput: "Alice Smithson 应该不会来。",
      candidates: [
        { ...baseCandidates[0]!, talkativeness: 1 },
        { ...baseCandidates[1]!, talkativeness: 0 },
      ],
    });

    expect(selection).toMatchObject({
      speakerPersonaId: "lin-zhao",
      reason: "weighted",
    });
  });

  it("excludes the previous speaker while another willing role exists", () => {
    expect(select({ previousSpeakerPersonaId: "lin-zhao" })).toMatchObject({
      speakerPersonaId: "alice-smith",
      reason: "weighted",
    });
  });

  it("allows the only willing role to speak consecutively", () => {
    expect(
      select({
        previousSpeakerPersonaId: "lin-zhao",
        candidates: [
          baseCandidates[0]!,
          { ...baseCandidates[1]!, talkativeness: 0 },
        ],
      }),
    ).toMatchObject({
      speakerPersonaId: "lin-zhao",
      reason: "weighted",
    });
  });

  it("uses talkativeness as deterministic weighted ranges", () => {
    expect(select()).toMatchObject({ speakerPersonaId: "lin-zhao" });
    expect(
      select({
        candidates: [
          { ...baseCandidates[0]!, talkativeness: 0.1 },
          { ...baseCandidates[1]!, talkativeness: 0.9 },
        ],
      }),
    ).toMatchObject({ speakerPersonaId: "alice-smith" });
  });

  it("is stable for identical seed data and candidate configuration", () => {
    const first = select();
    const replay = select({ candidates: [...baseCandidates].reverse() });

    expect(replay).toEqual(first);
    expect(first.stableHash).toBe(
      sha256Hex(
        JSON.stringify(["session-1", "branch-1", "turn-7", "request-1"]),
      ),
    );
  });

  it("fails with a stable code when nobody is eligible", () => {
    expectDomainCode(
      () =>
        select({
          candidates: baseCandidates.map((candidate) => ({
            ...candidate,
            talkativeness: 0,
          })),
        }),
      "cocreate.speaker.no_candidate",
    );
    expectDomainCode(
      () =>
        select({
          candidates: baseCandidates.map((candidate) => ({
            ...candidate,
            enabled: false,
          })),
        }),
      "cocreate.speaker.no_candidate",
    );
  });

  it("validates talkativeness and the deterministic seed", () => {
    expectDomainCode(
      () =>
        select({
          candidates: [{ ...baseCandidates[0]!, talkativeness: Number.NaN }],
        }),
      "cocreate.talkativeness.invalid",
    );
    expectDomainCode(
      () => select({ requestId: "  " }),
      "cocreate.speaker.seed_invalid",
    );
  });
});

describe("co-create AI participant limit", () => {
  it("allows eight enabled roles and ignores disabled roles", () => {
    const participants = Array.from(
      { length: MAX_ACTIVE_COCREATE_AI_PARTICIPANTS + 12 },
      (_, index) => ({
        enabled: index < MAX_ACTIVE_COCREATE_AI_PARTICIPANTS,
      }),
    );

    expect(() =>
      assertActiveCoCreateAiParticipantLimit(participants),
    ).not.toThrow();
  });

  it("rejects a ninth enabled role with a stable code", () => {
    expectDomainCode(
      () =>
        assertActiveCoCreateAiParticipantLimit(
          Array.from(
            { length: MAX_ACTIVE_COCREATE_AI_PARTICIPANTS + 1 },
            () => ({ enabled: true }),
          ),
        ),
      "cocreate.participant.enabled_limit_exceeded",
    );
  });
});
