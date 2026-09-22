import { ensureDatabase } from "../../../db";
import {
  DISCOVERY_STATUS_SELECT,
  isValidDiscoverySchedule,
  presentDiscoveryStatus,
  type DiscoverySchedule,
  type DiscoveryStatusRow,
} from "../../../lib/discovery-status";
import { canUseQueue } from "../../../lib/queue-auth";

type DiscoveryStatusEvent = {
  event?: "configure" | "start" | "complete" | "failed";
  runId?: string;
  at?: string;
  result?: string;
  schedule?: DiscoverySchedule;
};

function validTimestamp(value: string | undefined) {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function currentStatus(db: Awaited<ReturnType<typeof ensureDatabase>>) {
  const row = await db.prepare(DISCOVERY_STATUS_SELECT).first<DiscoveryStatusRow>();
  return presentDiscoveryStatus(row);
}

export async function GET(request: Request) {
  if (!canUseQueue(request)) return Response.json({ error: "Missing agent key" }, { status: 401 });
  const db = await ensureDatabase();
  return Response.json(await currentStatus(db));
}

export async function POST(request: Request) {
  if (!canUseQueue(request)) return Response.json({ error: "Missing agent key" }, { status: 401 });
  const payload = (await request.json()) as DiscoveryStatusEvent;
  if (!payload.event || !["configure", "start", "complete", "failed"].includes(payload.event)) {
    return Response.json({ error: "Invalid discovery event" }, { status: 400 });
  }
  if (payload.schedule !== undefined && !isValidDiscoverySchedule(payload.schedule)) {
    return Response.json({ error: "Invalid discovery schedule" }, { status: 400 });
  }
  const at = validTimestamp(payload.at);
  if (!at) return Response.json({ error: "Invalid discovery timestamp" }, { status: 400 });
  const db = await ensureDatabase();
  const schedule = payload.schedule;

  if (payload.event === "configure") {
    if (!schedule) return Response.json({ error: "A schedule is required" }, { status: 400 });
    await db.prepare(`
      INSERT INTO discovery_status (
        id, state, schedule_minute, schedule_start_hour, schedule_end_hour, schedule_time_zone, updated_at
      ) VALUES (1, 'idle', ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        schedule_minute = excluded.schedule_minute,
        schedule_start_hour = excluded.schedule_start_hour,
        schedule_end_hour = excluded.schedule_end_hour,
        schedule_time_zone = excluded.schedule_time_zone,
        updated_at = excluded.updated_at
    `).bind(schedule.minute, schedule.startHour, schedule.endHour, schedule.timeZone, at).run();
    return Response.json(await currentStatus(db));
  }

  const runId = payload.runId?.trim().slice(0, 160);
  if (!runId) return Response.json({ error: "A run ID is required" }, { status: 400 });

  if (payload.event === "start") {
    await db.prepare(`
      INSERT INTO discovery_status (
        id, state, run_id, started_at, schedule_minute, schedule_start_hour,
        schedule_end_hour, schedule_time_zone, updated_at
      ) VALUES (1, 'running', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = 'running',
        run_id = excluded.run_id,
        started_at = excluded.started_at,
        schedule_minute = COALESCE(excluded.schedule_minute, discovery_status.schedule_minute),
        schedule_start_hour = COALESCE(excluded.schedule_start_hour, discovery_status.schedule_start_hour),
        schedule_end_hour = COALESCE(excluded.schedule_end_hour, discovery_status.schedule_end_hour),
        schedule_time_zone = COALESCE(excluded.schedule_time_zone, discovery_status.schedule_time_zone),
        updated_at = excluded.updated_at
    `).bind(
      runId,
      at,
      schedule?.minute ?? null,
      schedule?.startHour ?? null,
      schedule?.endHour ?? null,
      schedule?.timeZone ?? null,
      at,
    ).run();
    return Response.json(await currentStatus(db));
  }

  const current = await db.prepare("SELECT run_id AS runId, state FROM discovery_status WHERE id = 1").first<{ runId: string; state: string }>();
  if (!current || current.runId !== runId || current.state !== "running") {
    return Response.json({ error: "This discovery run is no longer current" }, { status: 409 });
  }
  const state = payload.event === "complete" ? "idle" : "failed";
  const result = payload.result?.trim().slice(0, 2_000) || (state === "idle" ? "Discovery completed." : "Discovery failed.");
  const updated = await db.prepare(`
    UPDATE discovery_status
    SET state = ?, last_finished_at = ?, last_result = ?, updated_at = ?
    WHERE id = 1 AND run_id = ? AND state = 'running'
  `).bind(state, at, result, at, runId).run();
  if (!Number((updated as { meta?: { changes?: number } }).meta?.changes ?? 0)) {
    return Response.json({ error: "This discovery run is no longer current" }, { status: 409 });
  }
  return Response.json(await currentStatus(db));
}
