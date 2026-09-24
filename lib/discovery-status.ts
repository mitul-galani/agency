export type DiscoverySchedule = {
  // First minute mark, kept for older callers; `minutes` is the full list.
  minute: number;
  minutes: number[];
  startHour: number;
  endHour: number;
  timeZone: string;
};

export type DiscoveryStatusRow = {
  state: string;
  runId: string;
  startedAt: string | null;
  lastFinishedAt: string | null;
  lastResult: string;
  scheduleMinute: number | null;
  scheduleMinutes: string | null;
  scheduleStartHour: number | null;
  scheduleEndHour: number | null;
  scheduleTimeZone: string | null;
  updatedAt: string;
};

export type DiscoveryStatus = {
  state: "idle" | "running" | "failed" | "stale";
  startedAt: string | null;
  lastFinishedAt: string | null;
  lastResult: string;
  nextRunAt: string | null;
  // The scheduled run that should have started by now but never reported.
  missedRunAt: string | null;
  schedule: DiscoverySchedule | null;
};

export const DISCOVERY_STATUS_SELECT = `
  SELECT
    state,
    run_id AS runId,
    started_at AS startedAt,
    last_finished_at AS lastFinishedAt,
    last_result AS lastResult,
    schedule_minute AS scheduleMinute,
    schedule_minutes AS scheduleMinutes,
    schedule_start_hour AS scheduleStartHour,
    schedule_end_hour AS scheduleEndHour,
    schedule_time_zone AS scheduleTimeZone,
    updated_at AS updatedAt
  FROM discovery_status
  WHERE id = 1
`;

const MAX_RUNNING_MS = 90 * 60 * 1000;
// Session crons fire a few minutes late and a pass takes a few more, so wait
// this long after a scheduled minute before calling the run missed.
export const MISSED_RUN_GRACE_MS = 20 * 60 * 1000;

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function validMinute(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 59;
}

/** Accepts `minute`, `minutes`, or both, and returns the normalized minute list. */
export function scheduleMinutes(value: { minute?: unknown; minutes?: unknown }) {
  const list = Array.isArray(value.minutes) ? value.minutes : value.minute === undefined ? [] : [value.minute];
  if (!list.length || !list.every(validMinute)) return null;
  return [...new Set(list as number[])].sort((a, b) => a - b);
}

export function serializeScheduleMinutes(minutes: number[]) {
  return minutes.join(",");
}

export function parseScheduleMinutes(stored: string | null, fallback: number | null) {
  const parsed = (stored ?? "").split(",").map((part) => part.trim()).filter(Boolean).map(Number).filter(validMinute);
  if (parsed.length) return [...new Set(parsed)].sort((a, b) => a - b);
  return fallback === null ? null : [fallback];
}

export function isValidDiscoverySchedule(value: unknown): value is DiscoverySchedule {
  if (!value || typeof value !== "object") return false;
  const schedule = value as Partial<DiscoverySchedule>;
  if (!scheduleMinutes(schedule)) return false;
  if (schedule.minute !== undefined && !validMinute(schedule.minute)) return false;
  if (!Number.isInteger(schedule.startHour) || schedule.startHour! < 0 || schedule.startHour! > 23) return false;
  if (!Number.isInteger(schedule.endHour) || schedule.endHour! < schedule.startHour! || schedule.endHour! > 23) return false;
  if (!schedule.timeZone || schedule.timeZone.length > 80) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: schedule.timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

export function nextDiscoveryRun(now: Date, schedule: DiscoverySchedule) {
  const firstMinute = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
  // Scanning real instants keeps this correct across daylight-saving changes.
  for (let offset = 0; offset < 60 * 72; offset += 1) {
    const candidate = new Date(firstMinute + offset * 60_000);
    const parts = zonedParts(candidate, schedule.timeZone);
    const hour = Number(parts.hour);
    if (schedule.minutes.includes(Number(parts.minute)) && hour >= schedule.startHour && hour <= schedule.endHour) {
      return candidate.toISOString();
    }
  }
  return null;
}

export function previousDiscoveryRun(now: Date, schedule: DiscoverySchedule) {
  const lastMinute = Math.floor(now.getTime() / 60_000) * 60_000;
  for (let offset = 0; offset < 60 * 72; offset += 1) {
    const candidate = new Date(lastMinute - offset * 60_000);
    const parts = zonedParts(candidate, schedule.timeZone);
    const hour = Number(parts.hour);
    if (schedule.minutes.includes(Number(parts.minute)) && hour >= schedule.startHour && hour <= schedule.endHour) {
      return candidate.toISOString();
    }
  }
  return null;
}

function parseDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function presentDiscoveryStatus(row: DiscoveryStatusRow | null, now = new Date()): DiscoveryStatus {
  const minutes = row ? parseScheduleMinutes(row.scheduleMinutes ?? null, row.scheduleMinute) : null;
  const schedule = !row || !minutes
    || row.scheduleStartHour === null || row.scheduleEndHour === null || !row.scheduleTimeZone
    ? null
    : {
        minute: minutes[0],
        minutes,
        startHour: row.scheduleStartHour,
        endHour: row.scheduleEndHour,
        timeZone: row.scheduleTimeZone,
      };
  const startedAt = row?.startedAt ?? null;
  const started = parseDate(startedAt);
  const finished = parseDate(row?.lastFinishedAt ?? null);
  // A schedule row only proves a coordinator once existed. If the last
  // scheduled minute passed without a start, the coordinator is gone and the
  // sidebar must say so instead of promising a next run forever.
  const expected = schedule && row?.state !== "running" ? previousDiscoveryRun(now, schedule) : null;
  const expectedAt = expected ? new Date(expected) : null;
  const lastActivity = Math.max(started?.getTime() ?? 0, finished?.getTime() ?? 0);
  const missed = Boolean(expectedAt
    && now.getTime() - expectedAt.getTime() > MISSED_RUN_GRACE_MS
    && lastActivity < expectedAt.getTime());
  const state = row?.state === "running" && started && now.getTime() - started.getTime() > MAX_RUNNING_MS
    ? "stale"
    : row?.state === "running" || row?.state === "failed"
      ? row.state
      : missed
        ? "stale"
        : "idle";
  return {
    state,
    startedAt,
    lastFinishedAt: row?.lastFinishedAt ?? null,
    lastResult: row?.lastResult ?? "",
    nextRunAt: schedule ? nextDiscoveryRun(now, schedule) : null,
    missedRunAt: missed ? expected : null,
    schedule,
  };
}
