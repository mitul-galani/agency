import { ensureDatabase } from "../../../db";
import { canUpdateJob, ideaStatusForOutcome, jobLeaseWindow, MAX_CONCURRENT_JOBS, resolveTicketOutcome, type StoredJobStatus, type TicketOutcome } from "../../../lib/job-lifecycle";
import { UPDATE_JOB_STATUS_SQL } from "../../../lib/job-instructions";
import { WAKE_PARKED_SQL } from "../../../lib/parked-card";
import { canUseQueue } from "../../../lib/queue-auth";

export async function GET(request: Request) {
  if (!canUseQueue(request)) return Response.json({ error: "Missing agent key" }, { status: 401 });
  const db = await ensureDatabase();
  await db.prepare(WAKE_PARKED_SQL).run();
  const requestedJobId = Number(new URL(request.url).searchParams.get("id"));
  const jobId = Number.isInteger(requestedJobId) && requestedJobId > 0 ? requestedJobId : null;
  if (jobId) {
    const job = await db.prepare(`
      SELECT id, idea_id AS ideaId, action, button_label AS buttonLabel, instruction,
             user_feedback AS userFeedback, feedback_revision AS feedbackRevision,
             card_context AS cardContext, status, result, ticket_outcome AS ticketOutcome,
             created_at AS createdAt, updated_at AS updatedAt
      FROM agent_jobs WHERE id = ?
    `).bind(jobId).first<{ id: number; ideaId: number } & Record<string, unknown>>();
    if (!job) return Response.json({ error: "Job not found" }, { status: 404 });
    const earlier = await db.prepare(`
      SELECT id, action, button_label AS buttonLabel, user_feedback AS note, status, ticket_outcome AS outcome,
             substr(result, 1, 600) AS result, created_at AS createdAt
      FROM agent_jobs WHERE idea_id = ? AND id < ? ORDER BY id ASC
    `).bind(job.ideaId, job.id).all();
    return Response.json({ jobs: [{ ...job, history: earlier.results }] });
  }
  const leaseWindow = jobLeaseWindow();
  const jobs = await db.prepare(`
    WITH latest_jobs AS (
      SELECT job.*
      FROM agent_jobs job
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_jobs newer
        WHERE newer.idea_id = job.idea_id AND newer.id > job.id
      )
    ), capacity AS (
      SELECT MAX(0, ? - COUNT(*)) AS slots
      FROM latest_jobs
      WHERE status = 'running' AND updated_at > datetime('now', ?)
    )
    SELECT
      id,
      idea_id AS ideaId,
      action,
      button_label AS buttonLabel,
      instruction,
      user_feedback AS userFeedback,
      feedback_revision AS feedbackRevision,
      card_context AS cardContext,
      ticket_outcome AS ticketOutcome,
      'queued' AS status,
      status = 'running' AS reclaimed,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM latest_jobs
    WHERE status = 'queued'
      OR (status = 'running' AND updated_at <= datetime('now', ?))
    ORDER BY status = 'running' ASC, id ASC
    LIMIT (SELECT slots FROM capacity)
  `).bind(MAX_CONCURRENT_JOBS, leaseWindow, leaseWindow).all<{ id: number; ideaId: number } & Record<string, unknown>>();
  // Include earlier feedback and results so the agent can continue from context.
  const history = await Promise.all(jobs.results.map(async (job) => {
    const rows = await db.prepare(`
      SELECT id, action, button_label AS buttonLabel, user_feedback AS note, status, ticket_outcome AS outcome,
             substr(result, 1, 600) AS result, created_at AS createdAt
      FROM agent_jobs WHERE idea_id = ? AND id < ? ORDER BY id ASC
    `).bind(job.ideaId, job.id).all();
    return rows.results;
  }));
  return Response.json({ jobs: jobs.results.map((job, index) => ({ ...job, history: history[index] })) });
}

export async function POST(request: Request) {
  if (!canUseQueue(request)) return Response.json({ error: "Missing agent key" }, { status: 401 });
  const payload = (await request.json()) as { id?: number; status?: "running" | "done" | "failed"; result?: string; ticketOutcome?: TicketOutcome; feedbackRevision?: number };
  if (!payload.id || !["running", "done", "failed"].includes(payload.status ?? "")) return Response.json({ error: "Invalid job update" }, { status: 400 });
  if ((payload.status === "done" || payload.status === "failed") && !payload.result?.trim()) return Response.json({ error: "A finished job needs a concise result" }, { status: 400 });
  if (payload.ticketOutcome && !["completed", "review", "blocked"].includes(payload.ticketOutcome)) return Response.json({ error: "Invalid ticket outcome" }, { status: 400 });
  if (payload.status === "done" && payload.ticketOutcome === "blocked") return Response.json({ error: "A done job cannot be blocked" }, { status: 400 });
  if (payload.status === "failed" && payload.ticketOutcome && payload.ticketOutcome !== "blocked") return Response.json({ error: "A failed job must be blocked" }, { status: 400 });
  const db = await ensureDatabase();
  const job = await db.prepare("SELECT idea_id AS ideaId, action, status, feedback_revision AS feedbackRevision FROM agent_jobs WHERE id = ?").bind(payload.id).first<{ ideaId: number; action: string; status: StoredJobStatus; feedbackRevision: number }>();
  if (!job) return Response.json({ error: "Job not found" }, { status: 404 });
  if (job.status === payload.status && (job.status === "done" || job.status === "failed")) {
    return Response.json({ ok: true });
  }
  if (!canUpdateJob(job.status, payload.status!)) {
    return Response.json({ error: `Job is already ${job.status}` }, { status: 409 });
  }
  if (job.feedbackRevision > 0 && payload.feedbackRevision !== job.feedbackRevision) {
    return Response.json({ error: "New instructions arrived. Read the job again before continuing.", feedbackRevision: job.feedbackRevision }, { status: 409 });
  }
  const ticketOutcome = resolveTicketOutcome(payload.status!, payload.ticketOutcome);
  const updated = await db.prepare(UPDATE_JOB_STATUS_SQL)
    .bind(payload.status, payload.result?.slice(0, 20_000) ?? "", ticketOutcome, payload.id, job.status, job.feedbackRevision).run();
  if (!Number((updated as { meta?: { changes?: number } }).meta?.changes ?? 0)) {
    return Response.json({ error: "New instructions arrived. Read the job again before continuing." }, { status: 409 });
  }
  if ((payload.status === "done" || payload.status === "failed") && job.action !== "no") {
    const ideaStatus = ideaStatusForOutcome(ticketOutcome);
    await db.prepare(`
      UPDATE ideas SET status = ?
      WHERE id = ? AND status IN ('new', 'working')
        AND NOT EXISTS (
          SELECT 1 FROM agent_jobs newer
          WHERE newer.idea_id = ? AND newer.id > ?
        )
    `).bind(ideaStatus, job.ideaId, job.ideaId, payload.id).run();
  }
  return Response.json({ ok: true, ticketOutcome, ideaStatus: ideaStatusForOutcome(ticketOutcome) });
}
