export const migration044 = {
  version: 44,
  name: "lorebooks",
  sql: `
    CREATE TABLE lorebooks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
      description TEXT CHECK (description IS NULL OR length(description) <= 20000),
      enabled_globally INTEGER NOT NULL DEFAULT 0 CHECK (enabled_globally IN (0, 1)),
      scan_turns INTEGER NOT NULL DEFAULT 24 CHECK (scan_turns BETWEEN 0 AND 200),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
      UNIQUE(project_id, name)
    ) STRICT;

    CREATE INDEX lorebooks_project_enabled_idx
      ON lorebooks(project_id, enabled, enabled_globally, name, id);

    CREATE TABLE lore_entries (
      id TEXT PRIMARY KEY,
      lorebook_id TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
      content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 100000),
      keys_json TEXT NOT NULL
        CHECK (json_valid(keys_json) AND json_type(keys_json) = 'array'),
      constant INTEGER NOT NULL DEFAULT 0 CHECK (constant IN (0, 1)),
      priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -1000000 AND 1000000),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
      CHECK (constant = 1 OR json_array_length(keys_json) > 0),
      UNIQUE(lorebook_id, title)
    ) STRICT;

    CREATE INDEX lore_entries_book_activation_idx
      ON lore_entries(lorebook_id, enabled, priority DESC, id);

    CREATE TABLE persona_lorebooks (
      persona_id TEXT NOT NULL REFERENCES story_personas(id) ON DELETE CASCADE,
      lorebook_id TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
      PRIMARY KEY(persona_id, lorebook_id)
    ) WITHOUT ROWID;

    CREATE INDEX persona_lorebooks_book_idx
      ON persona_lorebooks(lorebook_id, persona_id);

    CREATE TABLE cocreate_session_lorebooks (
      session_id TEXT NOT NULL REFERENCES cocreate_sessions(id) ON DELETE CASCADE,
      lorebook_id TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
      PRIMARY KEY(session_id, lorebook_id)
    ) WITHOUT ROWID;

    CREATE INDEX cocreate_session_lorebooks_book_idx
      ON cocreate_session_lorebooks(lorebook_id, session_id);

    CREATE TRIGGER "persona-lorebooks-project-match-insert"
    BEFORE INSERT ON persona_lorebooks
    BEGIN
      SELECT RAISE(ABORT, 'lorebook.project_mismatch') WHERE EXISTS (
        SELECT 1
        FROM story_personas persona, lorebooks lorebook
        WHERE persona.id = NEW.persona_id
          AND lorebook.id = NEW.lorebook_id
          AND persona.project_id <> lorebook.project_id
      );
    END;
    CREATE TRIGGER "persona-lorebooks-project-match-update"
    BEFORE UPDATE ON persona_lorebooks
    BEGIN
      SELECT RAISE(ABORT, 'lorebook.project_mismatch') WHERE EXISTS (
        SELECT 1
        FROM story_personas persona, lorebooks lorebook
        WHERE persona.id = NEW.persona_id
          AND lorebook.id = NEW.lorebook_id
          AND persona.project_id <> lorebook.project_id
      );
    END;

    CREATE TRIGGER "cocreate-session-lorebooks-project-match-insert"
    BEFORE INSERT ON cocreate_session_lorebooks
    BEGIN
      SELECT RAISE(ABORT, 'lorebook.project_mismatch') WHERE EXISTS (
        SELECT 1
        FROM cocreate_sessions session, lorebooks lorebook
        WHERE session.id = NEW.session_id
          AND lorebook.id = NEW.lorebook_id
          AND session.project_id <> lorebook.project_id
      );
    END;
    CREATE TRIGGER "cocreate-session-lorebooks-project-match-update"
    BEFORE UPDATE ON cocreate_session_lorebooks
    BEGIN
      SELECT RAISE(ABORT, 'lorebook.project_mismatch') WHERE EXISTS (
        SELECT 1
        FROM cocreate_sessions session, lorebooks lorebook
        WHERE session.id = NEW.session_id
          AND lorebook.id = NEW.lorebook_id
          AND session.project_id <> lorebook.project_id
      );
    END;

    CREATE TRIGGER "lorebooks-project-write-guard-insert"
    BEFORE INSERT ON lorebooks
    BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM projects
        WHERE id = NEW.project_id AND deleted_at IS NOT NULL
      );
    END;
    CREATE TRIGGER "lorebooks-project-write-guard-update"
    BEFORE UPDATE ON lorebooks
    BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM projects
        WHERE id = NEW.project_id AND deleted_at IS NOT NULL
      );
    END;
    CREATE TRIGGER "lorebooks-project-write-guard-delete"
    BEFORE DELETE ON lorebooks
    BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM projects
        WHERE id = OLD.project_id AND deleted_at IS NOT NULL
      );
    END;

    CREATE TRIGGER "lore-entries-project-write-guard-insert"
    BEFORE INSERT ON lore_entries
    BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM lorebooks lorebook
        JOIN projects project ON project.id = lorebook.project_id
        WHERE lorebook.id = NEW.lorebook_id AND project.deleted_at IS NOT NULL
      );
    END;
    CREATE TRIGGER "lore-entries-project-write-guard-update"
    BEFORE UPDATE ON lore_entries
    BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM lorebooks lorebook
        JOIN projects project ON project.id = lorebook.project_id
        WHERE lorebook.id = NEW.lorebook_id AND project.deleted_at IS NOT NULL
      );
    END;
    CREATE TRIGGER "lore-entries-project-write-guard-delete"
    BEFORE DELETE ON lore_entries
    BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM lorebooks lorebook
        JOIN projects project ON project.id = lorebook.project_id
        WHERE lorebook.id = OLD.lorebook_id AND project.deleted_at IS NOT NULL
      );
    END;

    CREATE TRIGGER "persona-lorebooks-project-write-guard-insert"
    BEFORE INSERT ON persona_lorebooks
    BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM story_personas persona
        JOIN projects project ON project.id = persona.project_id
        WHERE persona.id = NEW.persona_id AND project.deleted_at IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM lorebooks lorebook
        JOIN projects project ON project.id = lorebook.project_id
        WHERE lorebook.id = NEW.lorebook_id AND project.deleted_at IS NOT NULL
      );
    END;
    CREATE TRIGGER "persona-lorebooks-project-write-guard-update"
    BEFORE UPDATE ON persona_lorebooks
    BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM story_personas persona
        JOIN projects project ON project.id = persona.project_id
        WHERE persona.id = NEW.persona_id AND project.deleted_at IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM lorebooks lorebook
        JOIN projects project ON project.id = lorebook.project_id
        WHERE lorebook.id = NEW.lorebook_id AND project.deleted_at IS NOT NULL
      );
    END;
    CREATE TRIGGER "persona-lorebooks-project-write-guard-delete"
    BEFORE DELETE ON persona_lorebooks
    BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM story_personas persona
        JOIN projects project ON project.id = persona.project_id
        WHERE persona.id = OLD.persona_id AND project.deleted_at IS NOT NULL
      ) AND EXISTS (
        SELECT 1 FROM lorebooks lorebook
        WHERE lorebook.id = OLD.lorebook_id
      );
    END;

    CREATE TRIGGER "cocreate-session-lorebooks-project-write-guard-insert"
    BEFORE INSERT ON cocreate_session_lorebooks
    BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM cocreate_sessions session
        JOIN projects project ON project.id = session.project_id
        WHERE session.id = NEW.session_id AND project.deleted_at IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM lorebooks lorebook
        JOIN projects project ON project.id = lorebook.project_id
        WHERE lorebook.id = NEW.lorebook_id AND project.deleted_at IS NOT NULL
      );
    END;
    CREATE TRIGGER "cocreate-session-lorebooks-project-write-guard-update"
    BEFORE UPDATE ON cocreate_session_lorebooks
    BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM cocreate_sessions session
        JOIN projects project ON project.id = session.project_id
        WHERE session.id = NEW.session_id AND project.deleted_at IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM lorebooks lorebook
        JOIN projects project ON project.id = lorebook.project_id
        WHERE lorebook.id = NEW.lorebook_id AND project.deleted_at IS NOT NULL
      );
    END;
    CREATE TRIGGER "cocreate-session-lorebooks-project-write-guard-delete"
    BEFORE DELETE ON cocreate_session_lorebooks
    BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM cocreate_sessions session
        JOIN projects project ON project.id = session.project_id
        WHERE session.id = OLD.session_id AND project.deleted_at IS NOT NULL
      ) AND EXISTS (
        SELECT 1 FROM lorebooks lorebook
        WHERE lorebook.id = OLD.lorebook_id
      );
    END;
  `,
} as const;
