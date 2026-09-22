export type DiscoverySchedule = {
  minute: number;
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
    schedule_start_hour AS scheduleStartHour,
    schedule_end_hour AS scheduleEndHour,
    schedule_time_zone AS scheduleTimeZone,
    updated_at AS updatedAt
  FROM discovery_status
  WHERE id = 1
`;

const MAX_RUNNING_MS = 90 * 60 * 1000;

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function isValidDiscoverySchedule(value: unknown): value is DiscoverySchedule {
  if (!value || typeof value !== "object") return false;
  const schedule = value as Partial<DiscoverySchedule>;
  if (!Number.isInteger(schedule.minute) || schedule.minute! < 0 || schedule.minute! > 59) return false;
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
    if (Number(parts.minute) === schedule.minute && hour >= schedule.startHour && hour <= schedule.endHour) {
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
  const schedule = row?.scheduleMinute === null || row?.scheduleMinute === undefined
    || row.scheduleStartHour === null || row.scheduleEndHour === null || !row.scheduleTimeZone
    ? null
    : {
        minute: row.scheduleMinute,
        startHour: row.scheduleStartHour,
        endHour: row.scheduleEndHour,
        timeZone: row.scheduleTimeZone,
      };
  const startedAt = row?.startedAt ?? null;
  const started = parseDate(startedAt);
  const state = row?.state === "running" && started && now.getTime() - started.getTime() > MAX_RUNNING_MS
    ? "stale"
    : row?.state === "running" || row?.state === "failed"
      ? row.state
      : "idle";
  return {
    state,
    startedAt,
    lastFinishedAt: row?.lastFinishedAt ?? null,
    lastResult: row?.lastResult ?? "",
    nextRunAt: schedule ? nextDiscoveryRun(now, schedule) : null,
    schedule,
  };
}
