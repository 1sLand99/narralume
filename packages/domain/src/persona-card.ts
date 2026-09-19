export const PERSONA_CARD_SOURCE_FORMATS = [
  "native",
  "character-card-v2",
  "character-card-v3",
] as const;

export type PersonaCardSourceFormat =
  (typeof PERSONA_CARD_SOURCE_FORMATS)[number];

export interface PersonaCardProfile {
  personality: string | null;
  scenario: string | null;
  exampleDialogue: string | null;
  greetings: readonly string[];
  creator: {
    name: string | null;
    notes: string | null;
    version: string | null;
    tags: readonly string[];
  };
  source: {
    format: PersonaCardSourceFormat;
    importedAt: string | null;
  };
}

/**
 * Returns a fresh native profile so callers never share mutable greeting or
 * tag arrays through a module-level default object.
 */
export function createDefaultPersonaCardProfile(): PersonaCardProfile {
  return {
    personality: null,
    scenario: null,
    exampleDialogue: null,
    greetings: [],
    creator: {
      name: null,
      notes: null,
      version: null,
      tags: [],
    },
    source: {
      format: "native",
      importedAt: null,
    },
  };
}
