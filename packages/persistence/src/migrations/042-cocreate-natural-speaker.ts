export const migration042 = {
  version: 42,
  name: "cocreate-natural-speaker",
  foreignKeysOff: true,
  sql: `
    DROP TRIGGER IF EXISTS "cocreate-sessions-project-write-guard-insert";
    DROP TRIGGER IF EXISTS "cocreate-sessions-project-write-guard-update";
    DROP TRIGGER IF EXISTS "cocreate-participants-project-write-guard-insert";
    DROP TRIGGER IF EXISTS "cocreate-participants-project-write-guard-update";
    DROP TRIGGER IF EXISTS "story-branches-project-write-guard-insert";
    DROP TRIGGER IF EXISTS "story-branches-project-write-guard-update";

    DELETE FROM cocreate_participants
    WHERE persona_id IN (
      SELECT id FROM story_personas WHERE kind = 'author'
    );

    CREATE TABLE cocreate_sessions_new (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','paused','archived')),
      speaker_policy TEXT NOT NULL CHECK (speaker_policy IN ('manual','round_robin','natural')),
      active_branch_id TEXT,
      target_outline_node_id TEXT REFERENCES outline_nodes(id) ON DELETE SET NULL,
      author_persona_id TEXT REFERENCES story_personas(id) ON DELETE SET NULL,
      director_note TEXT,
      context_turns INTEGER NOT NULL DEFAULT 24 CHECK (context_turns BETWEEN 4 AND 200),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
    ) STRICT;

    INSERT INTO cocreate_sessions_new(
      id, project_id, title, status, speaker_policy, active_branch_id,
      target_outline_node_id, author_persona_id, director_note, context_turns,
      created_at, updated_at, version
    )
    SELECT
      id, project_id, title, status,
      CASE speaker_policy WHEN 'auto' THEN 'natural' ELSE speaker_policy END,
      active_branch_id, target_outline_node_id, author_persona_id,
      director_note, context_turns, created_at, updated_at, version
    FROM cocreate_sessions;

    DROP TABLE cocreate_sessions;
    ALTER TABLE cocreate_sessions_new RENAME TO cocreate_sessions;

    CREATE INDEX cocreate_sessions_project_idx
      ON cocreate_sessions(project_id, status, updated_at DESC);

    CREATE TRIGGER "cocreate-sessions-project-write-guard-insert"
    BEFORE INSERT ON cocreate_sessions
    BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM projects
        WHERE id = NEW.project_id AND deleted_at IS NOT NULL
      );
    END;
    CREATE TRIGGER "cocreate-sessions-project-write-guard-update"
    BEFORE UPDATE ON cocreate_sessions
    BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM projects
        WHERE id = NEW.project_id AND deleted_at IS NOT NULL
      );
    END;

    CREATE TRIGGER "cocreate-participants-project-write-guard-insert"
    BEFORE INSERT ON cocreate_participants
    BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM cocreate_sessions session
        JOIN projects project ON project.id = session.project_id
        WHERE session.id = NEW.session_id AND project.deleted_at IS NOT NULL
      );
    END;
    CREATE TRIGGER "cocreate-participants-project-write-guard-update"
    BEFORE UPDATE ON cocreate_participants
    BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM cocreate_sessions session
        JOIN projects project ON project.id = session.project_id
        WHERE session.id = NEW.session_id AND project.deleted_at IS NOT NULL
      );
    END;

    CREATE TRIGGER "story-branches-project-write-guard-insert"
    BEFORE INSERT ON story_branches
    BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM cocreate_sessions session
        JOIN projects project ON project.id = session.project_id
        WHERE session.id = NEW.session_id AND project.deleted_at IS NOT NULL
      );
    END;
    CREATE TRIGGER "story-branches-project-write-guard-update"
    BEFORE UPDATE ON story_branches
    BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM cocreate_sessions session
        JOIN projects project ON project.id = session.project_id
        WHERE session.id = NEW.session_id AND project.deleted_at IS NOT NULL
      );
    END;
  `,
} as const;
