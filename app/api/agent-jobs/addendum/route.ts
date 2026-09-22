import { ensureDatabase } from "../../../../db";
import { APPEND_JOB_INSTRUCTION_SQL } from "../../../../lib/job-instructions";
import { canUseQueue } from "../../../../lib/queue-auth";

type Addendum = {
  jobId?: number;
  ideaId?: number;
  note?: string;
};

export async function POST(request: Request) {
  if (!canUseQueue(request)) return Response.json({ error: "Missing agent key" }, { status: 401 });
  const payload = (await request.json()) as Addendum;
  const note = payload.note?.trim().slice(0, 5000) ?? "";
  if (!payload.jobId || !payload.ideaId || !note) return Response.json({ error: "Add an instruction" }, { status: 400 });

  const db = await ensureDatabase();
  const job = await db.prepare(APPEND_JOB_INSTRUCTION_SQL).bind(note, note, payload.jobId, payload.ideaId).first<{ feedbackRevision: number }>();
  if (!job) return Response.json({ error: "Agency already finished or replaced this job" }, { status: 409 });
  await db.prepare("INSERT INTO feedback (idea_id, decision, note) VALUES (?, 'addendum', ?)").bind(payload.ideaId, note).run();
  return Response.json({ ok: true, feedbackRevision: job.feedbackRevision });
}
