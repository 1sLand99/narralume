export const migration043 = {
  version: 43,
  name: "persona-card-profile",
  sql: `
    ALTER TABLE story_personas
      ADD COLUMN profile_json TEXT NOT NULL
      DEFAULT '{"personality":null,"scenario":null,"exampleDialogue":null,"greetings":[],"creator":{"name":null,"notes":null,"version":null,"tags":[]},"source":{"format":"native","importedAt":null}}'
      CHECK (json_valid(profile_json));
  `,
} as const;
