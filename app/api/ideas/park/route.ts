import { env } from "cloudflare:workers";
import { ensureDatabase } from "../../../../db";
import { normalizeParkedUntil } from "../../../../lib/parked-card";

type ParkAction = {
  id?: number;
  version?: number;
  action?: "park" | "unpark" | "close";
  until?: string | null;
  note?: string;
};

function canManageParked(request: Request) {
  const origin = request.headers.get("origin");
  if (origin) return origin === new URL(request.url).origin;
  const url = new URL(request.url);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (loopback && request.headers.get("x-radar-local-agent") === "1") return true;
  const expected = (env as unknown as { RADAR_AGENT_KEY?: string }).RADAR_AGENT_KEY;
  return Boolean(expected) && request.headers.get("x-radar-agent-key") === expected;
}

export async function POST(request: Request) {
  if (!canManageParked(request)) return Response.json({ error: "Missing agent key" }, { status: 401 });
  const payload = (await request.json()) as ParkAction;
  if (!payload.id || !Number.isInteger(payload.version) || !["park", "unpark", "close"].includes(payload.action ?? "")) {
    return Response.json({ error: "Invalid park action" }, { status: 400 });
  }
  const action = payload.action!;
  const note = payload.note?.trim().slice(0, 5000) ?? "";
  const normalized = normalizeParkedUntil(payload.until);
  if (action === "park" && normalized.error) return Response.json({ error: normalized.error }, { status: 400 });
  if (action === "close" && !note) return Response.json({ error: "Closing a parked card needs a verified note." }, { status: 400 });

  const db = await ensureDatabase();
  const idea = await db.prepare("SELECT id, version, status FROM ideas WHERE id = ?").bind(payload.id).first<{ id: number; version: number; status: string }>();
  if (!idea) return Response.json({ error: "Card not found" }, { status: 404 });
  if (idea.version !== payload.version) return Response.json({ error: "Card changed while you were reading" }, { status: 409 });
  if (action === "park" && !["new", "working"].includes(idea.status)) return Response.json({ error: "Only New or Working cards can be parked" }, { status: 409 });
  if (action !== "park" && idea.status !== "parked") return Response.json({ error: "Card is not parked" }, { status: 409 });

  const update = action === "park"
    ? db.prepare("UPDATE ideas SET status = 'parked', parked_at = CURRENT_TIMESTAMP, parked_until = ?, parked_note = ? WHERE id = ? AND version = ? AND status IN ('new', 'working')").bind(normalized.value, note, payload.id, payload.version)
    : action === "unpark"
      ? db.prepare("UPDATE ideas SET status = 'new', parked_at = NULL, parked_until = NULL, parked_note = '', created_at = CURRENT_TIMESTAMP WHERE id = ? AND version = ? AND status = 'parked'").bind(payload.id, payload.version)
      : db.prepare("UPDATE ideas SET status = 'done', parked_at = NULL, parked_until = NULL, parked_note = '', created_at = CURRENT_TIMESTAMP WHERE id = ? AND version = ? AND status = 'parked'").bind(payload.id, payload.version);
  const label = action === "park" ? (normalized.value ? `Park until ${normalized.value} UTC` : "Park indefinitely") : action === "unpark" ? "Bring back to New" : "Closed during parked review";
  const result = await update.run();
  const changes = Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0);
  if (!changes) return Response.json({ error: "Card changed while you were reading" }, { status: 409 });
  await db.batch([
    db.prepare("INSERT INTO feedback (idea_id, decision, note) VALUES (?, ?, ?)").bind(payload.id, action, note || label),
    db.prepare("INSERT INTO card_attention (idea_id, idea_version, view_count) VALUES (?, ?, 0) ON CONFLICT(idea_id, idea_version) DO NOTHING").bind(payload.id, payload.version),
    db.prepare("INSERT INTO card_interactions (idea_id, idea_version, action, label, active_ms, wall_ms) SELECT idea_id, idea_version, ?, ?, active_ms, MAX(0, CAST((julianday(CURRENT_TIMESTAMP) - julianday(first_seen_at)) * 86400000 AS INTEGER)) FROM card_attention WHERE idea_id = ? AND idea_version = ?").bind(action, label, payload.id, payload.version),
  ]);
  return Response.json({ ok: true, status: action === "park" ? "parked" : action === "unpark" ? "new" : "done", parkedUntil: action === "park" ? normalized.value : null });
}
