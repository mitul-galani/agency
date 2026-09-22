export const APPEND_JOB_INSTRUCTION_SQL = `
  UPDATE agent_jobs
  SET user_feedback = CASE
        WHEN trim(user_feedback) = '' THEN ?
        ELSE user_feedback || '\n\nAdditional instruction:\n' || ?
      END,
      feedback_revision = feedback_revision + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = ? AND idea_id = ? AND status IN ('queued', 'running')
    AND NOT EXISTS (
      SELECT 1 FROM agent_jobs newer
      WHERE newer.idea_id = agent_jobs.idea_id AND newer.id > agent_jobs.id
    )
  RETURNING feedback_revision AS feedbackRevision
`;

export const UPDATE_JOB_STATUS_SQL = `
  UPDATE agent_jobs
  SET status = ?, result = ?, ticket_outcome = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ? AND status = ? AND feedback_revision = ?
`;
