import {
  CharacterCardV3ExportSchema,
  CharacterCardV3InputSchema,
  PERSONA_CARD_LIMITS,
  PersonaCardImportReportSchema,
  PersonaCardProfileSchema,
  type CharacterCardV3Export,
  type CharacterCardV3Input,
  type CharacterCardV3Lorebook,
  type PersonaCardImportReport,
} from "@narralume/contracts";
import type { PersonaCardProfile, StoryPersona } from "@narralume/domain";

import { ServiceError } from "./service-error.js";

export type PersonaCardImportSource =
  "character-card-v3-json" | "character-card-v3-png";

export interface ParsedPersonaCardV3 {
  name: string;
  description: string | null;
  profile: PersonaCardProfile;
  report: PersonaCardImportReport;
  characterBook: CharacterCardV3Lorebook | null;
}

export class PersonaCardServiceError extends ServiceError {
  constructor(code: string, message: string, statusCode = 422) {
    super(code, message, statusCode);
    this.name = "PersonaCardServiceError";
  }
}

export function parseCharacterCardV3(
  value: unknown,
  input: { sourceFormat: PersonaCardImportSource; importedAt: string },
): ParsedPersonaCardV3 {
  const parsed = CharacterCardV3InputSchema.safeParse(value);
  if (!parsed.success) {
    const error = new PersonaCardServiceError(
      "persona_card.schema_invalid",
      "The file is not a supported Character Card V3 document",
    );
    error.cause = parsed.error;
    throw error;
  }
  const data = parsed.data.data;
  const greetings = [data.first_mes, ...data.alternate_greetings]
    .map((greeting) => greeting.trim())
    .filter(Boolean);
  const profile = PersonaCardProfileSchema.parse({
    personality: optionalText(data.personality),
    scenario: optionalText(data.scenario),
    exampleDialogue: optionalText(data.mes_example),
    greetings,
    creator: {
      name: optionalText(data.creator),
      notes: optionalText(data.creator_notes),
      version: optionalText(data.character_version),
      tags: data.tags,
    },
    source: {
      format: "character-card-v3",
      importedAt: input.importedAt,
    },
  }) as PersonaCardProfile;

  return {
    name: data.name,
    description: optionalText(data.description),
    profile,
    report: buildImportReport(parsed.data, value, input.sourceFormat),
    characterBook: data.character_book ?? null,
  };
}

export function exportCharacterCardV3(
  persona: Pick<StoryPersona, "name" | "description" | "profile">,
): CharacterCardV3Export {
  const greetings = persona.profile.greetings
    .map((greeting) => greeting.trim())
    .filter(Boolean);
  return CharacterCardV3ExportSchema.parse({
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: persona.name,
      description: persona.description ?? "",
      personality: persona.profile.personality ?? "",
      scenario: persona.profile.scenario ?? "",
      first_mes: greetings[0] ?? "",
      mes_example: persona.profile.exampleDialogue ?? "",
      creator_notes: persona.profile.creator.notes ?? "",
      system_prompt: "",
      post_history_instructions: "",
      alternate_greetings: greetings.slice(1),
      tags: [...persona.profile.creator.tags],
      creator: persona.profile.creator.name ?? "",
      character_version: persona.profile.creator.version ?? "",
      extensions: {},
      group_only_greetings: [],
    },
  });
}

function buildImportReport(
  card: CharacterCardV3Input,
  raw: unknown,
  sourceFormat: PersonaCardImportSource,
): PersonaCardImportReport {
  const items: PersonaCardImportReport["items"][number][] = [
    ...[
      "data.name",
      "data.description",
      "data.personality",
      "data.scenario",
      "data.first_mes",
      "data.alternate_greetings",
      "data.mes_example",
    ].map((path) => ({
      path,
      disposition: "imported" as const,
      reasonCode: "safe-field" as const,
    })),
    ...[
      "data.creator",
      "data.creator_notes",
      "data.character_version",
      "data.tags",
    ].map((path) => ({
      path,
      disposition: "imported" as const,
      reasonCode: "creator-metadata" as const,
    })),
  ];

  if (card.data.system_prompt.trim()) {
    items.push({
      path: "data.system_prompt",
      disposition: "unsupported",
      reasonCode: "prompt-override-blocked",
    });
  }
  if (card.data.post_history_instructions.trim()) {
    items.push({
      path: "data.post_history_instructions",
      disposition: "unsupported",
      reasonCode: "prompt-override-blocked",
    });
  }
  if (Object.keys(card.data.extensions).length > 0) {
    items.push({
      path: "data.extensions",
      disposition: "unsupported",
      reasonCode: "extension-not-executed",
    });
  }
  if (card.data.character_book) {
    items.push({
      path: "data.character_book",
      disposition: "imported",
      reasonCode: "character-book-imported",
    });
    if (card.data.character_book.recursive_scanning) {
      items.push({
        path: "data.character_book.recursive_scanning",
        disposition: "unsupported",
        reasonCode: "extension-not-executed",
      });
    }
    card.data.character_book.entries.forEach((entry, index) => {
      if (entry.use_regex || entry.selective || entry.secondary_keys?.length) {
        items.push({
          path: `data.character_book.entries.${index}`,
          disposition: "unsupported",
          reasonCode: "extension-not-executed",
        });
      }
    });
  }
  if ((card.data.assets?.length ?? 0) > 0) {
    items.push({
      path: "data.assets",
      disposition: "unsupported",
      reasonCode: "asset-deferred",
    });
  }
  if (card.data.group_only_greetings.length > 0) {
    items.push({
      path: "data.group_only_greetings",
      disposition: "unsupported",
      reasonCode: "group-greeting-deferred",
    });
  }
  items.push(...unknownFieldItems(raw));

  return PersonaCardImportReportSchema.parse({
    sourceFormat,
    specVersion: "3.0",
    items: items.slice(0, PERSONA_CARD_LIMITS.reportItems),
  });
}

function unknownFieldItems(
  raw: unknown,
): PersonaCardImportReport["items"][number][] {
  if (!isObject(raw)) return [];
  const items: PersonaCardImportReport["items"][number][] = [];
  const knownTopLevel = new Set(["spec", "spec_version", "data"]);
  for (const key of Object.keys(raw)) {
    if (!knownTopLevel.has(key)) items.push(unknownItem(key));
  }
  const data = raw.data;
  if (!isObject(data)) return items;
  const knownData = new Set([
    "name",
    "description",
    "personality",
    "scenario",
    "first_mes",
    "mes_example",
    "creator_notes",
    "system_prompt",
    "post_history_instructions",
    "alternate_greetings",
    "tags",
    "creator",
    "character_version",
    "extensions",
    "group_only_greetings",
    "character_book",
    "assets",
    "nickname",
    "creator_notes_multilingual",
    "source",
    "creation_date",
    "modification_date",
  ]);
  for (const key of Object.keys(data)) {
    if (!knownData.has(key)) items.push(unknownItem(`data.${key}`));
  }
  return items;
}

function unknownItem(path: string): PersonaCardImportReport["items"][number] {
  return {
    path,
    disposition: "ignored",
    reasonCode: "unknown-field-ignored",
  };
}

function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
