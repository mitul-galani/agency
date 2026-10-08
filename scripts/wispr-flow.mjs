#!/usr/bin/env node
/**
 * Read Wispr Flow meetings, transcripts, dictations, and notes straight from
 * its local store, read-only. No connector, no sign-in, no network.
 *
 *   node scripts/wispr-flow.mjs meetings [--since ISO] [--until ISO]
 *   node scripts/wispr-flow.mjs transcript <meeting-id> [--live]
 *   node scripts/wispr-flow.mjs meeting <meeting-id>        (metadata + summary + notes)
 *   node scripts/wispr-flow.mjs dictations [--since ISO] [--until ISO]
 *   node scripts/wispr-flow.mjs notes [--since ISO]
 *   node scripts/wispr-flow.mjs info
 *
 * Every command prints one JSON document: { ok, data, warnings }. Times in the
 * store are UTC; --since/--until take any ISO 8601 value, with offset.
 * WISPR_FLOW_DIR overrides the store location.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const storeDir = process.env.WISPR_FLOW_DIR || join(homedir(), "Library", "Application Support", "Wispr Flow");
const dbPath = join(storeDir, "flow.sqlite");

function sql(query, params = []) {
  // The sqlite3 CLI reads a WAL database the app has open without touching it.
  const bound = params.reduce((text, value) => text.replace("?", `'${String(value).replace(/'/g, "''")}'`), query);
  const result = spawnSync("sqlite3", ["-readonly", "-json", dbPath, bound], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error((result.stderr || "sqlite3 failed").trim());
  return result.stdout.trim() ? JSON.parse(result.stdout) : [];
}

function utc(value, fallback) {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Not a date: ${value}`);
  // Match the store's "YYYY-MM-DD HH:MM:SS.mmm +00:00" text so string comparison works.
  return `${date.toISOString().replace("T", " ").replace("Z", "")} +00:00`;
}

function parseJson(text, fallback) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

/** Speaker number in a transcript → person name, from the meeting's speakerMap. */
export function speakerNames(speakerMap) {
  const map = parseJson(speakerMap, null);
  if (!map) return {};
  const names = {};
  for (const [label, assignment] of Object.entries(map.assignments ?? {})) {
    const personId = assignment.user ?? assignment.consensus ?? assignment.dom ?? assignment.llm;
    const person = personId ? map.people?.[personId] : null;
    if (person?.name) names[label] = person.name;
  }
  return names;
}

export function listMeetings({ since, until } = {}) {
  const rows = sql(
    `SELECT id, title, createdAt, modifiedAt, endedAt, calendarOccurrenceStartAtUtc, recordedMs, finalized,
            transcriptReady, summaryReady, participantNames, speakerMap, length(summary) AS summaryChars, length(notes) AS notesChars
     FROM Meetings WHERE isDeleted = 0 AND isTourDemo = 0 AND createdAt >= ? AND createdAt < ? ORDER BY createdAt DESC`,
    [utc(since, "1970-01-01 00:00:00.000 +00:00"), utc(until, "9999-12-31 00:00:00.000 +00:00")],
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    startedAt: new Date(row.createdAt).toISOString(),
    endedAt: row.endedAt ? new Date(row.endedAt).toISOString() : null,
    scheduledAt: row.calendarOccurrenceStartAtUtc ? new Date(row.calendarOccurrenceStartAtUtc).toISOString() : null,
    durationMinutes: row.recordedMs ? Math.round(row.recordedMs / 60000) : null,
    finalized: Boolean(row.finalized),
    transcriptReady: Boolean(row.transcriptReady),
    hasTranscript: existsSync(join(storeDir, "meetings", row.id, "refined.ndjson")) || existsSync(join(storeDir, "meetings", row.id, "live.ndjson")),
    hasSummary: Boolean(row.summaryChars),
    hasNotes: Boolean(row.notesChars),
    participants: parseJson(row.participantNames, []),
    speakers: speakerNames(row.speakerMap),
  }));
}

export function getMeeting(id) {
  const [row] = sql("SELECT id, title, createdAt, endedAt, participantNames, speakerMap, summary, notes, shareSlug FROM Meetings WHERE id = ? AND isDeleted = 0", [id]);
  if (!row) throw new Error(`No meeting ${id}`);
  const names = speakerNames(row.speakerMap);
  // Summaries reference speakers as <@speaker:N>; resolve them to names.
  const resolve = (text) => (text ?? "").replace(/<@speaker:(\d+)>/g, (_, label) => names[label] ?? `Speaker ${label}`);
  return {
    id: row.id,
    title: row.title,
    startedAt: new Date(row.createdAt).toISOString(),
    endedAt: row.endedAt ? new Date(row.endedAt).toISOString() : null,
    participants: parseJson(row.participantNames, []),
    speakers: names,
    summary: resolve(row.summary),
    notes: resolve(row.notes),
    shareUrl: row.shareSlug ? `https://notes.wisprflow.ai/shared/${row.shareSlug}` : null,
  };
}

/** The transcript as [{ at, speaker, text }], refined first, live as a fallback. */
export function getTranscript(id, { live = false } = {}) {
  const dir = join(storeDir, "meetings", id);
  let names = {};
  if (existsSync(dbPath)) {
    const [row] = sql("SELECT speakerMap FROM Meetings WHERE id = ?", [id]);
    names = speakerNames(row?.speakerMap);
  }
  const refined = join(dir, "refined.ndjson");
  const liveFile = join(dir, "live.ndjson");
  const file = !live && existsSync(refined) ? refined : existsSync(liveFile) ? liveFile : null;
  if (!file) throw new Error(`No transcript files for meeting ${id}`);
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const turns = [];
  for (const line of lines) {
    const entry = parseJson(line, null);
    if (!entry || !entry.text || entry.meta) continue;
    const label = String(entry.speaker?.id ?? "");
    const speaker = entry.speaker?.name ?? names[label] ?? (entry.speaker?.source === "system" ? "Others" : entry.speaker?.source === "mic" ? "Mic" : `Speaker ${label}`);
    turns.push({ at: entry.timestamp, speaker, text: entry.text.trim() });
  }
  return { id, source: file.endsWith("refined.ndjson") ? "refined" : "live", turns };
}

export function listDictations({ since, until } = {}) {
  return sql(
    `SELECT transcriptEntityId AS id, timestamp, app, url, numWords, duration,
            COALESCE(NULLIF(editedText, ''), NULLIF(formattedText, ''), asrText) AS text
     FROM History WHERE isArchived = 0 AND timestamp >= ? AND timestamp < ? ORDER BY timestamp DESC`,
    [utc(since, "1970-01-01 00:00:00.000 +00:00"), utc(until, "9999-12-31 00:00:00.000 +00:00")],
  ).filter((row) => row.text).map((row) => ({ ...row, timestamp: new Date(row.timestamp).toISOString() }));
}

export function listNotes({ since } = {}) {
  return sql(
    "SELECT id, title, content, createdAt, modifiedAt FROM Notes WHERE isDeleted = 0 AND modifiedAt >= ? ORDER BY modifiedAt DESC",
    [utc(since, "1970-01-01 00:00:00.000 +00:00")],
  ).map((row) => ({ ...row, createdAt: new Date(row.createdAt).toISOString(), modifiedAt: new Date(row.modifiedAt).toISOString() }));
}

export function info() {
  const [counts] = sql("SELECT (SELECT count(*) FROM Meetings WHERE isDeleted = 0) AS meetings, (SELECT count(*) FROM History WHERE isArchived = 0) AS dictations, (SELECT count(*) FROM Notes WHERE isDeleted = 0) AS notes");
  return { storeDir, dbPath, ...counts };
}

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i += 1;
      } else out[key] = true;
    } else out._.push(args[i]);
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("wispr-flow.mjs")) {
  const args = flags(process.argv.slice(2));
  const [command, id] = args._;
  const warnings = [];
  try {
    if (!existsSync(dbPath)) throw new Error(`Wispr Flow store not found at ${storeDir}`);
    let data;
    if (command === "meetings") data = listMeetings(args);
    else if (command === "meeting") data = getMeeting(id);
    else if (command === "transcript") data = getTranscript(id, { live: Boolean(args.live) });
    else if (command === "dictations") data = listDictations(args);
    else if (command === "notes") data = listNotes(args);
    else if (command === "info") data = info();
    else throw new Error("Usage: wispr-flow.mjs meetings|meeting <id>|transcript <id> [--live]|dictations|notes|info [--since ISO] [--until ISO]");
    if (command === "transcript" && data.source === "live") warnings.push("Refined transcript not ready yet; this is the live transcript.");
    console.log(JSON.stringify({ ok: true, data, warnings }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message, warnings }, null, 2));
    process.exit(1);
  }
}
