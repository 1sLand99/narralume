export const migration045 = {
  version: 45,
  name: "knowledge-corrections",
  sql: `
    CREATE TABLE knowledge_corrections (
      record_id TEXT PRIMARY KEY REFERENCES knowledge_records(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      replacement_record_id TEXT REFERENCES knowledge_records(id) ON DELETE CASCADE,
      reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
      created_at TEXT NOT NULL,
      CHECK(record_id != replacement_record_id)
    ) STRICT;
    CREATE INDEX knowledge_corrections_project_idx ON knowledge_corrections(project_id, created_at, record_id);
    CREATE TRIGGER "knowledge-corrections-project-write-guard-insert"
    BEFORE INSERT ON knowledge_corrections BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM projects WHERE id = NEW.project_id AND deleted_at IS NOT NULL
      );
    END;
    CREATE TRIGGER "knowledge-corrections-project-write-guard-update"
    BEFORE UPDATE ON knowledge_corrections BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM projects WHERE id = NEW.project_id AND deleted_at IS NOT NULL
      );
    END;
  `,
} as const;
