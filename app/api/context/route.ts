import { ensureDatabase } from "../../../db";
import { combineContextItems, MAX_CONTEXT_ITEM_LENGTH, type ContextItem } from "../../../lib/context-items";
import { MAX_CONTEXT_LENGTH } from "../../../lib/task-submission";

function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

type ContextRow = ContextItem;

async function readItems(db: Awaited<ReturnType<typeof ensureDatabase>>) {
  const rows = await db.prepare("SELECT id, text, position, created_at AS createdAt, updated_at AS updatedAt FROM context_items ORDER BY position, created_at, id").all<ContextRow>();
  return rows.results;
}

function validateItem(text: string) {
  if (!text || text.length > MAX_CONTEXT_ITEM_LENGTH) return `Each context note must be 1–${MAX_CONTEXT_ITEM_LENGTH} characters.`;
  return null;
}

function validateCombined(items: ContextRow[]) {
  return combineContextItems(items).length <= MAX_CONTEXT_LENGTH ? null : `All context notes together must be at most ${MAX_CONTEXT_LENGTH} characters.`;
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Blocked origin" }, { status: 403 });
  const payload = (await request.json()) as { text?: string; replaceAll?: boolean };
  const text = payload.text?.trim() ?? "";
  const itemError = validateItem(text);
  if (itemError) return Response.json({ error: itemError }, { status: 400 });
  const db = await ensureDatabase();
  const current = await readItems(db);
  const id = crypto.randomUUID();
  const item: ContextRow = { id, text, position: payload.replaceAll ? 0 : current.length, createdAt: "", updatedAt: "" };
  const next = payload.replaceAll ? [item] : [...current, item];
  const combinedError = validateCombined(next);
  if (combinedError) return Response.json({ error: combinedError }, { status: 400 });
  const combined = combineContextItems(next);
  const writes = payload.replaceAll
    ? [
        db.prepare("DELETE FROM context_items"),
        db.prepare("INSERT INTO context_items (id, text, position) VALUES (?, ?, 0)").bind(id, text),
        db.prepare("INSERT INTO contexts (text) VALUES (?)").bind(combined),
      ]
    : [
        db.prepare("INSERT INTO context_items (id, text, position) VALUES (?, ?, ?)").bind(id, text, item.position),
        db.prepare("INSERT INTO contexts (text) VALUES (?)").bind(combined),
      ];
  await db.batch(writes);
  const created = await db.prepare("SELECT id, text, position, created_at AS createdAt, updated_at AS updatedAt FROM context_items WHERE id = ?").bind(id).first<ContextRow>();
  return Response.json({ ok: true, item: created }, { status: 201 });
}

export async function PATCH(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Blocked origin" }, { status: 403 });
  const payload = (await request.json()) as { id?: string; text?: string };
  const id = payload.id?.trim() ?? "";
  const text = payload.text?.trim() ?? "";
  const itemError = validateItem(text);
  if (!id || itemError) return Response.json({ error: itemError || "Context note ID is required." }, { status: 400 });
  const db = await ensureDatabase();
  const current = await readItems(db);
  if (!current.some((item) => item.id === id)) return Response.json({ error: "Context note not found." }, { status: 404 });
  const next = current.map((item) => item.id === id ? { ...item, text } : item);
  const combinedError = validateCombined(next);
  if (combinedError) return Response.json({ error: combinedError }, { status: 400 });
  await db.batch([
    db.prepare("UPDATE context_items SET text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(text, id),
    db.prepare("INSERT INTO contexts (text) VALUES (?)").bind(combineContextItems(next)),
  ]);
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Blocked origin" }, { status: 403 });
  const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  if (!id) return Response.json({ error: "Context note ID is required." }, { status: 400 });
  const db = await ensureDatabase();
  const current = await readItems(db);
  if (!current.some((item) => item.id === id)) return Response.json({ error: "Context note not found." }, { status: 404 });
  const next = current.filter((item) => item.id !== id);
  await db.batch([
    db.prepare("DELETE FROM context_items WHERE id = ?").bind(id),
    db.prepare("INSERT INTO contexts (text) VALUES (?)").bind(combineContextItems(next)),
  ]);
  return Response.json({ ok: true });
}
