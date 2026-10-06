// Recover the session-only schedules a Claude Code session held, from its
// transcript, so a resumed session can recreate them. Claude crons are never
// written to disk by Claude itself; the transcript is the only record.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const CREATED = /(?:job|task) ([0-9a-f]{8})/;

export async function liveCronsFromTranscript(path, now = new Date()) {
  const defs = new Map();
  const pendingCreate = new Map();
  const pendingDelete = new Map();
  const deleted = new Set();
  const fired = new Map();
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    // Results of a pending create/delete do not mention "Cron"; read them too.
    const awaiting = pendingCreate.size || pendingDelete.size;
    if (!line.includes("Cron") && !line.includes("scheduled_task_fire") && !(awaiting && line.includes("tool_result"))) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type === "system" && row.subtype === "scheduled_task_fire" && row.taskId) {
      fired.set(row.taskId, (fired.get(row.taskId) ?? 0) + 1);
      continue;
    }
    const content = row.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use" && block.name === "CronCreate") pendingCreate.set(block.id, { input: block.input ?? {}, at: row.timestamp });
      if (block.type === "tool_use" && block.name === "CronDelete") pendingDelete.set(block.id, block.input?.id);
      if (block.type !== "tool_result") continue;
      const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      if (pendingCreate.has(block.tool_use_id)) {
        const match = CREATED.exec(text);
        const { input, at } = pendingCreate.get(block.tool_use_id);
        pendingCreate.delete(block.tool_use_id);
        if (match) defs.set(match[1], { input, createdAt: at, recurring: Boolean(input.recurring) || /recurring job/.test(text) });
      }
      if (pendingDelete.has(block.tool_use_id)) {
        if (!/not found|error/i.test(text)) deleted.add(pendingDelete.get(block.tool_use_id));
        pendingDelete.delete(block.tool_use_id);
      }
    }
  }
  const live = [];
  for (const [id, def] of defs) {
    if (deleted.has(id)) continue;
    if (!def.recurring && fired.has(id)) continue;
    if (!def.recurring && def.input.at && new Date(def.input.at) < now) continue;
    live.push({
      oldId: id,
      createdAt: def.createdAt,
      cron: def.input.cron ?? null,
      at: def.input.at ?? null,
      recurring: def.recurring,
      prompt: def.input.prompt ?? "",
      fires: fired.get(id) ?? 0,
    });
  }
  return live.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
