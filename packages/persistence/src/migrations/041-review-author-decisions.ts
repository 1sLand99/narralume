export const migration041 = {
  version: 41,
  name: "review-author-decisions",
  sql: `
    ALTER TABLE review_issues
      ADD COLUMN requires_author_decision INTEGER NOT NULL DEFAULT 0
      CHECK (requires_author_decision IN (0, 1));

    UPDATE review_issues
    SET requires_author_decision = 1
    WHERE id IN (
      SELECT json_extract(issue.value, '$.id')
      FROM review_reports report
      JOIN run_steps step
        ON step.run_id = report.run_id AND step.id = report.step_id
      JOIN json_each(step.output_artifact_json, '$.issues') AS issue
      WHERE report.verdict = 'block'
        AND json_extract(issue.value, '$.requiresAuthorDecision') = 1
    );
  `,
} as const;
