"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cardDraftKey, keepSelectedCard, nextCardAfterRemoval } from "../lib/card-focus";
import { cardShortcut } from "../lib/card-shortcut";
import { clusterForCard, type Topic } from "../lib/card-cluster";
import { compareByImpact, impactPoints } from "../lib/rise";
import { MAX_TASK_LENGTH, submitNewTask } from "../lib/task-submission";
import type { DiscoveryStatus } from "../lib/discovery-status";

type Idea = {
  id: number;
  version: number;
  project: string;
  category: string;
  headline: string;
  cardHtml: string;
  agentContext: string;
  score: number;
  riseReach: number;
  riseImpact: number;
  riseStrategicFit: number;
  riseEase: number;
  sourceLabel: string;
  sourceUrl: string;
  agentName: string;
  createdAt: string;
  cardState: "new" | "working" | "parked" | "done" | "rejected";
  status: "new" | "working" | "parked" | "done";
  parkedAt: string | null;
  parkedUntil: string | null;
  parkedNote: string;
  jobId: number | null;
  jobStatus: "queued" | "running" | "done" | "failed" | null;
  jobOutcome: "completed" | "review" | "blocked" | null;
  jobResult: string | null;
  jobLabel: string | null;
  jobInstruction: string | null;
  jobUserFeedback: string | null;
  jobFeedbackRevision: number | null;
  jobUpdatedAt: string | null;
  closedAt: string | null;
  decisionActiveMs: number | null;
  decisionWallMs: number | null;
  decisionAction: "do" | "change" | "no" | null;
  decisionEstimateMs: number | null;
  decisionEstimateReason: string;
};

type RadarState = {
  context: { text: string; createdAt: string } | null;
  topics: Topic[];
  ideas: Idea[];
  laneCounts: Record<Idea["status"], number>;
  jobs: { queued: number; running: number };
  discovery: DiscoveryStatus;
  completionStats: { verified: number; legacy: number; reviewReady: number; dismissed: number; points: number; pointsToday: number; verifiedToday: number };
  decisionMetrics: {
    tracked: number;
    accepted: number;
    changed: number;
    rejected: number;
    parked: number;
    medianActiveMs: number | null;
    medianAcceptedActiveMs: number | null;
    medianFastWallMs: number | null;
    medianFirstActionMs: number | null;
    medianEstimateErrorMs: number | null;
  };
};

type CardAction = {
  action: "do" | "open";
  label?: string;
  prompt?: string;
  url?: string;
};

type AttentionTracker = {
  id: number;
  version: number;
  lastInteractionAt: number;
  lastTickAt: number;
  pendingActiveMs: number;
  totalActiveMs: number;
};

const emptyState: RadarState = {
  context: null,
  topics: [],
  ideas: [],
  laneCounts: { new: 0, working: 0, parked: 0, done: 0 },
  jobs: { queued: 0, running: 0 },
  discovery: { state: "idle", startedAt: null, lastFinishedAt: null, lastResult: "", nextRunAt: null, schedule: null },
  completionStats: { verified: 0, legacy: 0, reviewReady: 0, dismissed: 0, points: 0, pointsToday: 0, verifiedToday: 0 },
  decisionMetrics: {
    tracked: 0,
    accepted: 0,
    changed: 0,
    rejected: 0,
    parked: 0,
    medianActiveMs: null,
    medianAcceptedActiveMs: null,
    medianFastWallMs: null,
    medianFirstActionMs: null,
    medianEstimateErrorMs: null,
  },
};

const CLAUDE_START_COMMAND = "npm run agency:claude";

function formatDuration(milliseconds: number | null) {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return "Not set";
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function formatParkedUntil(value: string | null) {
  if (!value) return "until you bring it back";
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return "until its return time";
  return `until ${date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

function decisionLabel(action: Idea["decisionAction"]) {
  if (action === "do") return "Accepted";
  if (action === "no") return "Skipped";
  return "Changed";
}

function formatDiscoveryTime(value: string | null) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  const day = date.toLocaleDateString("en-CA");
  const today = new Date().toLocaleDateString("en-CA");
  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString("en-CA");
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (day === today) return `Today, ${time}`;
  if (day === tomorrow) return `Tomorrow, ${time}`;
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function DiscoveryRunStatus({ discovery }: { discovery: DiscoveryStatus }) {
  const running = discovery.state === "running";
  const label = running
    ? "Running now"
    : discovery.state === "failed"
      ? "Last run failed"
      : discovery.state === "stale"
        ? "Run status unclear"
        : discovery.schedule
          ? "Scheduled"
          : "Not scheduled";
  return (
    <section className={`radar-discovery-status is-${discovery.state}`} aria-label={`Discovery: ${label}`} aria-live="polite">
      <header><i aria-hidden="true" /><strong>Discovery</strong><span>{label}</span></header>
      <dl>
        <div><dt>{running || discovery.state === "stale" ? "Started" : "Last"}</dt><dd>{formatDiscoveryTime(running || discovery.state === "stale" ? discovery.startedAt : discovery.lastFinishedAt)}</dd></div>
        <div><dt>Next</dt><dd>{discovery.nextRunAt ? formatDiscoveryTime(discovery.nextRunAt) : "No recurring run"}</dd></div>
      </dl>
    </section>
  );
}


type SortKey = "newest" | "score" | "effort";
type SortMode = { key: SortKey; dir: "desc" | "asc" };
const SORT_KEY = "radar-sort-v2";
const DEFAULT_SORT: SortMode = { key: "score", dir: "desc" };

function readSortMode(): SortMode {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(SORT_KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as Partial<SortMode>) : null;
    if (parsed && (parsed.key === "newest" || parsed.key === "score" || parsed.key === "effort") && (parsed.dir === "asc" || parsed.dir === "desc")) return { key: parsed.key, dir: parsed.dir };
  } catch { /* private mode */ }
  return DEFAULT_SORT;
}

// Newest = the card an agent created or replaced most recently (created_at resets on every replacement).
function compareByNewest(left: Idea, right: Idea) {
  return (right.createdAt ?? "").localeCompare(left.createdAt ?? "") || right.id - left.id;
}

// Cards without an agent estimate come last.
function compareByEffort(left: Idea, right: Idea) {
  return (left.decisionEstimateMs ?? Infinity) - (right.decisionEstimateMs ?? Infinity) || right.id - left.id;
}

function ideasForView(ideas: Idea[], view: Idea["status"], sort: SortMode = DEFAULT_SORT) {
  const compare = sort.key === "newest" ? compareByNewest : sort.key === "effort" ? compareByEffort : compareByImpact;
  return ideas.filter((idea) => idea.status === view).toSorted((left, right) => {
    if (sort.key === "effort") {
      if (left.decisionEstimateMs === null) return right.decisionEstimateMs === null ? right.id - left.id : 1;
      if (right.decisionEstimateMs === null) return -1;
    }
    return sort.dir === "asc" ? -compare(left, right) : compare(left, right);
  });
}

function summarizeJobResult(result: string) {
  const firstLine = result
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*#>]+|\d+[.)])\s*/, "").trim())
    .find(Boolean) ?? "";
  if (firstLine.length <= 180) return firstLine;
  const clipped = firstLine.slice(0, 177);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, lastSpace > 120 ? lastSpace : 177)}…`;
}

function AgentCard({ idea, actionable, onAction, onInteraction }: { idea: Idea; actionable: boolean; onAction: (action: CardAction) => void; onInteraction: (action: string, label: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const renderedCardIdRef = useRef<number | null>(null);
  const onActionRef = useRef(onAction);
  const onInteractionRef = useRef(onInteraction);

  useEffect(() => {
    onActionRef.current = onAction;
    onInteractionRef.current = onInteraction;
  }, [onAction, onInteraction]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const detailsState = renderedCardIdRef.current === idea.id
      ? new Map(Array.from(root.querySelectorAll("details"), (detail) => [detail.querySelector("summary")?.textContent, detail.open]))
      : new Map();
    root.innerHTML = `<style>:host{display:block;font-family:inherit}*{box-sizing:border-box}[data-radar-action]{min-height:44px;cursor:pointer}[data-radar-action="open"]{display:inline-flex!important;align-items:center;gap:.38em}[data-radar-action="open"]::after{content:"↗";font-size:.8em;line-height:1;opacity:.68;transform:translateY(-.08em)}</style>${idea.cardHtml}`;
    root.querySelectorAll('[data-radar-action="change"], [data-radar-action="no"]').forEach((button) => button.remove());
    root.querySelectorAll("details").forEach((detail) => {
      const open = detailsState.get(detail.querySelector("summary")?.textContent);
      if (open !== undefined) detail.open = open;
    });
    renderedCardIdRef.current = idea.id;
    root.querySelectorAll<HTMLElement>('[data-radar-action="open"]').forEach((button) => {
      if (!button.title) button.title = "Opens a link";
    });
    if (!actionable) {
      root.querySelectorAll<HTMLElement>("[data-radar-action]").forEach((button) => {
        if (button.dataset.radarAction === "open") return;
        button.setAttribute("aria-disabled", "true");
        button.style.pointerEvents = "none";
        button.style.opacity = "0.5";
      });
    }
    const click = (event: Event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-radar-action]") : null;
      if (!target) {
        const summary = event.target instanceof Element ? event.target.closest<HTMLElement>("summary") : null;
        if (summary) onInteractionRef.current("details", (summary.textContent || "Details").trim().slice(0, 120));
        return;
      }
      const action = target.dataset.radarAction;
      if (!action || !["do", "open"].includes(action)) return;
      if (!actionable && action !== "open") return;
      event.preventDefault();
      onActionRef.current({
        action: action as CardAction["action"],
        label: (target.getAttribute("aria-label") || target.textContent || "").trim(),
        prompt: target.dataset.radarPrompt || "",
        url: target.dataset.radarUrl || "",
      });
    };
    root.addEventListener("click", click);
    return () => {
      root.removeEventListener("click", click);
    };
  }, [actionable, idea.id, idea.cardHtml, idea.jobOutcome]);

  return (
    <div className="radar-agent-card">
      <div className="radar-agent-card-scroll" ref={hostRef} />
    </div>
  );
}


function dayKey(value: string | null) {
  if (!value) return "earlier";
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return "earlier";
  return date.toLocaleDateString("en-CA");
}

function dayLabel(key: string) {
  if (key === "earlier") return "Earlier";
  const today = new Date().toLocaleDateString("en-CA");
  const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString("en-CA");
  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";
  return new Date(`${key}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function DoneList({ ideas, topics, onAction, onInteraction }: { ideas: Idea[]; topics: Topic[]; onAction: (idea: Idea, action: CardAction) => void; onInteraction: (idea: Idea, action: string, label: string) => void }) {
  const [day, setDay] = useState<string>("all");
  const [openId, setOpenId] = useState<number | null>(null);
  const [cardHtml, setCardHtml] = useState<Record<number, string>>({});
  useEffect(() => {
    if (!openId || cardHtml[openId]) return;
    let cancelled = false;
    fetch(`/api/state?view=done&only=${openId}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((state: { ideas: Idea[] }) => {
        const html = state.ideas[0]?.cardHtml ?? "";
        if (!cancelled) setCardHtml((current) => ({ ...current, [openId]: html }));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [openId, cardHtml]);
  const groups = useMemo(() => {
    const map = new Map<string, Idea[]>();
    for (const idea of ideas) {
      const key = dayKey(idea.closedAt ?? idea.jobUpdatedAt);
      map.set(key, [...(map.get(key) ?? []), idea]);
    }
    return [...map.entries()].toSorted(([a], [b]) => (a === "earlier" ? 1 : b === "earlier" ? -1 : a < b ? 1 : -1));
  }, [ideas]);
  const shown = day === "all" ? groups : groups.filter(([key]) => key === day);
  const pointsFor = (idea: Idea) => (idea.cardState !== "rejected" && idea.jobOutcome === "completed" ? impactPoints(idea) : 0);
  return (
    <section className="radar-done">
      <nav className="radar-done-days" aria-label="Filter done by day">
        <button className={day === "all" ? "is-active" : ""} onClick={() => setDay("all")}>All <b>{ideas.length}</b></button>
        {groups.slice(0, 8).map(([key, items]) => (
          <button key={key} className={day === key ? "is-active" : ""} onClick={() => setDay(key)}>{dayLabel(key)} <b>{items.length}</b></button>
        ))}
      </nav>
      <div className="radar-done-scroll">
        {shown.map(([key, items]) => (
          <section key={key} className="radar-done-day">
            <h2>{dayLabel(key)} <span>{items.length} closed · {items.reduce((sum, idea) => sum + pointsFor(idea), 0)} pts</span></h2>
            <ul>
              {items.map((idea) => {
                const cluster = clusterForCard(idea, topics) || "none";
                const dismissed = idea.cardState === "rejected";
                const open = openId === idea.id;
                return (
                  <li key={idea.id} className={open ? "is-open" : ""}>
                    <button className="radar-done-row" onClick={() => { setOpenId(open ? null : idea.id); onInteraction(idea, open ? "collapse" : "expand", "Done list"); }} aria-expanded={open}>
                      <i className={`is-${cluster}`} />
                      <strong>{idea.headline}</strong>
                      <span>{idea.jobLabel || decisionLabel(idea.decisionAction)}{!dismissed && idea.jobOutcome === "completed" ? " · verified" : !dismissed && idea.jobOutcome === "review" ? " · reviewed" : ""}{idea.decisionActiveMs ? ` · ${formatDuration(idea.decisionActiveMs)}` : ""}</span>
                      <em className={dismissed ? "is-dismissed" : ""}>{dismissed ? "Dismissed" : pointsFor(idea) ? `+${pointsFor(idea)}` : ""}</em>
                    </button>
                    {open && (
                      <div className="radar-done-card">
                        <p className="radar-done-result">{idea.jobResult ? summarizeJobResult(idea.jobResult) : `${idea.jobLabel || "Agency"} finished this step.`}</p>
                        {cardHtml[idea.id] || idea.cardHtml
                          ? <AgentCard idea={{ ...idea, cardHtml: cardHtml[idea.id] || idea.cardHtml }} actionable={false} onAction={(action) => onAction(idea, action)} onInteraction={(action, label) => onInteraction(idea, action, label)} />
                          : <p className="radar-done-empty">Loading card…</p>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {!shown.length && <p className="radar-done-empty">Nothing done on that day.</p>}
      </div>
    </section>
  );
}

export function Agency() {
  const [data, setData] = useState<RadarState>(emptyState);
  const [view, setView] = useState<Idea["status"]>("new");
  const [cluster, setCluster] = useState<string>("all");
  const [sort, setSort] = useState<SortMode>(readSortMode);
  const sortRef = useRef<SortMode>(sort);
  useEffect(() => {
    sortRef.current = sort;
    try { window.localStorage.setItem(SORT_KEY, JSON.stringify(sort)); } catch { /* private mode */ }
  }, [sort]);
  const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null);
  // Poll responses may resolve after the user has already moved to another card.
  // Keep the navigation anchor outside React's render timing so a refresh can
  // never select a different card from the one the user is currently reading.
  const selectedIdeaRef = useRef<Idea | null>(null);
  const [composer, setComposer] = useState<"task" | "context" | null>(null);
  const [contextDraft, setContextDraft] = useState("");
  const [taskDraft, setTaskDraft] = useState("");
  const [taskSubmitting, setTaskSubmitting] = useState(false);
  const taskSubmittingRef = useRef(false);
  const [composerError, setComposerError] = useState("");
  const [feedbackDrafts, setFeedbackDrafts] = useState<Record<string, string>>({});
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [, setLiveDecision] = useState({ key: "", activeMs: 0 });
  const liveDecisionByCardRef = useRef<Record<string, number>>({});
  const attentionTrackerRef = useRef<AttentionTracker | null>(null);
  const loadRequestRef = useRef(0);
  // `?card=<id>` opens one exact card on first load, whatever lane it sits in.
  const deepLinkHandledRef = useRef(false);

  const selectIdea = useCallback((idea: Idea | null) => {
    selectedIdeaRef.current = idea;
    setSelectedIdea(idea);
  }, []);

  const load = useCallback(async (
    targetView: Idea["status"] = view,
    selection?: { preferred: Idea | null; excludeId?: number },
  ) => {
    const requestId = ++loadRequestRef.current;
    const stateUrl = new URL("/api/state", window.location.origin);
    stateUrl.searchParams.set("view", targetView);
    if (targetView === "done") stateUrl.searchParams.set("light", "1");
    const deepLinkedCardId = Number(new URLSearchParams(window.location.search).get("card"));
    const requestedCardId = selection?.preferred?.id
      ?? selectedIdeaRef.current?.id
      ?? (!deepLinkHandledRef.current && Number.isInteger(deepLinkedCardId) && deepLinkedCardId > 0 ? deepLinkedCardId : null);
    if (requestedCardId) stateUrl.searchParams.set("card", String(requestedCardId));
    const response = await fetch(stateUrl, { cache: "no-store" });
    const next = (await response.json()) as RadarState;
    if (requestId !== loadRequestRef.current) return;
    if (!deepLinkHandledRef.current) {
      deepLinkHandledRef.current = true;
      const requestedId = Number(new URLSearchParams(window.location.search).get("card"));
      const requested = next.ideas.find((idea) => idea.id === requestedId);
      if (requested) {
        setData(next);
        setView(requested.status);
        selectIdea(requested);
        setLoading(false);
        return;
      }
    }
    const visible = ideasForView(next.ideas, targetView, sortRef.current).filter((idea) => idea.id !== selection?.excludeId);
    setData(next);
    const anchor = selection ? selection.preferred : selectedIdeaRef.current;
    selectIdea(keepSelectedCard(anchor, visible, next.ideas));
    setLoading(false);
  }, [selectIdea, view]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!selectedIdea) return;
    const url = new URL(window.location.href);
    url.searchParams.set("card", String(selectedIdea.id));
    window.history.replaceState(null, "", url);
  }, [selectedIdea]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const refresh = async () => {
      try {
        await load();
      } finally {
        if (!cancelled) timer = window.setTimeout(refresh, document.hidden ? 30000 : 10000);
      }
    };
    timer = window.setTimeout(refresh, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [load]);

  const laneIdeas = useMemo(() => ideasForView(data.ideas, view, sort), [data.ideas, view, sort]);
  const visibleIdeas = useMemo(
    () => (cluster === "all" ? laneIdeas : laneIdeas.filter((idea) => clusterForCard(idea, data.topics) === cluster)),
    [laneIdeas, cluster, data.topics],
  );
  const clusterCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const topic of data.topics) counts[topic.id] = 0;
    for (const idea of laneIdeas) { const id = clusterForCard(idea, data.topics); if (id) counts[id] = (counts[id] ?? 0) + 1; }
    return counts;
  }, [laneIdeas, data.topics]);
  function selectCluster(next: string) {
    setComposer(null);
    recordCardInteraction(active, "lane", `cluster:${next}`);
    setCluster(next);
    const nextVisible = next === "all" ? laneIdeas : laneIdeas.filter((idea) => clusterForCard(idea, data.topics) === next);
    if (!active || !nextVisible.some((idea) => idea.id === active.id)) selectIdea(nextVisible[0] ?? null);
    setMessage("");
  }
  const laneCounts = data.laneCounts;
  const active = selectedIdea;
  const selectedIndex = active === null ? -1 : visibleIdeas.findIndex((idea) => idea.id === active.id);
  const activeIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const latestSelected = active ? data.ideas.find((idea) => idea.id === active.id) : undefined;
  const feedbackKey = active ? cardDraftKey(active) : "";
  const feedback = feedbackKey ? feedbackDrafts[feedbackKey] ?? "" : "";
  const activeLiveState = latestSelected ?? active;
  const activeJob = useMemo(() => activeLiveState?.jobId ? ({
    id: activeLiveState.jobId,
    status: activeLiveState.jobStatus,
    outcome: activeLiveState.jobOutcome,
    result: activeLiveState.jobResult?.trim() ?? "",
    label: activeLiveState.jobLabel?.trim() ?? "",
    instruction: activeLiveState.jobInstruction?.trim() ?? "",
    feedback: activeLiveState.jobUserFeedback?.trim() ?? "",
    feedbackRevision: Number(activeLiveState.jobFeedbackRevision ?? 0),
  }) : null, [activeLiveState]);
  const jobInFlight = activeJob?.status === "queued" || activeJob?.status === "running";
  const lastRoundInstruction = activeJob ? [activeJob.instruction, activeJob.feedback].filter(Boolean).join("\n") : "";
  const showLastRound = view === "new" && activeJob && !jobInFlight && (lastRoundInstruction || activeJob.result);
  const attentionIdeaId = active?.id ?? null;
  const attentionIdeaVersion = active?.version ?? null;
  const attentionDecisionAction = active?.decisionAction ?? null;
  const attentionInitialActiveMs = Number(active?.decisionActiveMs ?? 0);

  const takePendingActiveMs = useCallback((id: number, version: number, flush = true) => {
    const tracker = attentionTrackerRef.current;
    if (!tracker || tracker.id !== id || tracker.version !== version) return 0;
    const now = Date.now();
    const elapsed = Math.min(15_000, Math.max(0, now - tracker.lastTickAt));
    tracker.lastTickAt = now;
    if (document.visibilityState === "visible" && document.hasFocus() && now - tracker.lastInteractionAt <= 60_000) {
      tracker.pendingActiveMs += elapsed;
      tracker.totalActiveMs += elapsed;
      liveDecisionByCardRef.current[`${id}:${version}`] = tracker.totalActiveMs;
      setLiveDecision({ key: `${id}:${version}`, activeMs: tracker.totalActiveMs });
    }
    if (!flush) return 0;
    const pending = Math.min(15_000, Math.round(tracker.pendingActiveMs));
    tracker.pendingActiveMs = 0;
    return pending;
  }, []);

  useEffect(() => {
    if (attentionIdeaId === null || attentionIdeaVersion === null || attentionDecisionAction || composer) return;
    const id = attentionIdeaId;
    const version = attentionIdeaVersion;
    const now = Date.now();
    const totalActiveMs = Math.max(attentionInitialActiveMs, liveDecisionByCardRef.current[`${id}:${version}`] ?? 0);
    const tracker: AttentionTracker = { id, version, lastInteractionAt: now, lastTickAt: now, pendingActiveMs: 0, totalActiveMs };
    attentionTrackerRef.current = tracker;

    const sendAttention = (event: "view" | "active", activeMs = 0) => {
      void fetch("/api/ideas/attention", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, version, event, activeMs }),
        keepalive: true,
      }).catch(() => undefined);
    };
    const markInteraction = () => {
      if (attentionTrackerRef.current !== tracker) return;
      const interactionAt = Date.now();
      if (interactionAt - tracker.lastInteractionAt > 60_000) tracker.lastTickAt = interactionAt;
      tracker.lastInteractionAt = interactionAt;
    };
    const tick = () => {
      const activeMs = takePendingActiveMs(id, version);
      if (activeMs) sendAttention("active", activeMs);
    };

    sendAttention("view");
    const events: Array<keyof WindowEventMap> = ["pointerdown", "pointermove", "keydown", "scroll", "touchstart"];
    events.forEach((event) => window.addEventListener(event, markInteraction, { passive: true }));
    const displayTimer = window.setInterval(() => takePendingActiveMs(id, version, false), 1_000);
    const flushTimer = window.setInterval(tick, 5_000);
    return () => {
      window.clearInterval(displayTimer);
      window.clearInterval(flushTimer);
      events.forEach((event) => window.removeEventListener(event, markInteraction));
      const activeMs = takePendingActiveMs(id, version);
      if (activeMs) sendAttention("active", activeMs);
      if (attentionTrackerRef.current === tracker) attentionTrackerRef.current = null;
    };
  }, [attentionDecisionAction, attentionIdeaId, attentionIdeaVersion, attentionInitialActiveMs, composer, takePendingActiveMs]);

  const recordCardInteraction = useCallback((target: Idea | null, action: string, label: string) => {
    if (!target) return;
    const activeMs = takePendingActiveMs(target.id, target.version);
    void fetch("/api/ideas/attention", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: target.id, version: target.version, event: "interaction", action, label, activeMs }),
      keepalive: true,
    }).catch(() => undefined);
  }, [takePendingActiveMs]);

  const move = useCallback((direction: number) => {
    if (!visibleIdeas.length) return;
    recordCardInteraction(active, direction > 0 ? "next" : "back", direction > 0 ? "Next card" : "Previous card");
    const currentIndex = active ? visibleIdeas.findIndex((idea) => idea.id === active.id) : -1;
    const startingIndex = currentIndex >= 0 ? currentIndex : direction > 0 ? -1 : 0;
    const nextIndex = (startingIndex + direction + visibleIdeas.length) % visibleIdeas.length;
    selectIdea(visibleIdeas[nextIndex]);
    setMessage("");
  }, [active, recordCardInteraction, selectIdea, visibleIdeas]);

  const sendToAgent = useCallback(async (target: Idea, action: "do" | "change" | "no", label: string, prompt = "", note = "") => {
    const activeMs = takePendingActiveMs(target.id, target.version);
    const response = await fetch("/api/ideas/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: target.id, version: target.version, status: target.status, action, label, prompt, note, activeMs }),
    });
    if (response.status === 409) {
      const tracker = attentionTrackerRef.current;
      if (tracker?.id === target.id && tracker.version === target.version) tracker.pendingActiveMs += activeMs;
      // A click racing a revision is not approval for the new action. Refresh
      // the card, keep the draft, and never replay the rejected action.
      await load();
      setMessage("Nothing sent. Check the current card and try again. Your draft is saved.");
      return false;
    }
    if (!response.ok) {
      const tracker = attentionTrackerRef.current;
      if (tracker?.id === target.id && tracker.version === target.version) tracker.pendingActiveMs += activeMs;
      setMessage("That did not reach the agent. Try once more.");
      return false;
    }
    await response.json().catch(() => undefined);
    const targetDraftKey = cardDraftKey(target);
    setFeedbackDrafts((current) => {
      const next = { ...current };
      delete next[targetDraftKey];
      return next;
    });
    setMessage("");
    const targetView = action === "no" ? view : "new";
    const nextSelection = targetView === view
      ? nextCardAfterRemoval(target.id, visibleIdeas)
      : ideasForView(data.ideas, targetView, sortRef.current)[0] ?? null;
    setView(targetView);
    selectIdea(nextSelection);
    await load(targetView, { preferred: nextSelection, excludeId: target.id });
    return true;
  }, [data.ideas, load, selectIdea, takePendingActiveMs, view, visibleIdeas]);

  const handleCardAction = useCallback((payload: CardAction) => {
      if (!active) return;
      const label = payload.label?.slice(0, 120) || payload.action;
      const prompt = payload.prompt?.slice(0, 5000) || "";
      if (payload.action === "open") {
        if (!payload.url) return;
        recordCardInteraction(active, "open", label);
        const url = new URL(payload.url, window.location.origin);
        if (url.protocol === "http:" || url.protocol === "https:") window.open(url.href, "_blank", "noopener,noreferrer");
        return;
      }
      void sendToAgent(active, payload.action, label, prompt);
  }, [active, recordCardInteraction, sendToAgent]);

  const submitFeedback = useCallback(async () => {
    const note = feedback.trim();
    const target = active;
    if (!target || !note || feedbackSubmitting) return;

    setFeedbackSubmitting(true);
    try {
      if (jobInFlight && activeJob) {
        const response = await fetch("/api/agent-jobs/addendum", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId: activeJob.id, ideaId: target.id, note }),
        });
        if (response.status === 409) {
          await load();
          setMessage("That step just finished. Your note is still here so you can send it as a follow-up.");
          return;
        }
        if (!response.ok) {
          setMessage("That instruction did not reach Agency. Try once more.");
          return;
        }
        const targetDraftKey = cardDraftKey(target);
        setFeedbackDrafts((current) => {
          const next = { ...current };
          delete next[targetDraftKey];
          return next;
        });
        setMessage("Added to the current job. Agency must read it before finishing.");
        await load(view, { preferred: target });
        return;
      }
      await sendToAgent(
        target,
        "change",
        "New context",
        "",
        note,
      );
    } finally {
      setFeedbackSubmitting(false);
    }
  }, [active, activeJob, feedback, feedbackSubmitting, jobInFlight, load, sendToAgent, view]);

  const submitImprove = useCallback(async () => {
    if (!active || jobInFlight || feedbackSubmitting) return;

    setFeedbackSubmitting(true);
    try {
      await sendToAgent(
        active,
        "change",
        "Auto-improve",
        "Auto-improve this card using the Agency skill.",
      );
    } finally {
      setFeedbackSubmitting(false);
    }
  }, [active, feedbackSubmitting, jobInFlight, sendToAgent]);

  const submitSkip = useCallback(async () => {
    if (!active || jobInFlight || feedbackSubmitting) return;

    setFeedbackSubmitting(true);
    try {
      await sendToAgent(active, "no", "Skip");
    } finally {
      setFeedbackSubmitting(false);
    }
  }, [active, feedbackSubmitting, jobInFlight, sendToAgent]);

  const submitTogglePark = useCallback(async () => {
    const target = active;
    if (!target || jobInFlight || feedbackSubmitting) return;
    const action = target.status === "parked" ? "unpark" : "park";
    setFeedbackSubmitting(true);
    try {
      const response = await fetch("/api/ideas/park", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: target.id, version: target.version, action, until: null }),
      });
      if (response.status === 409) {
        await load();
        setMessage("That card changed. Check it and try again.");
        return;
      }
      if (!response.ok) {
        setMessage(action === "park" ? "That card could not be parked. Try once more." : "That card could not be brought back. Try once more.");
        return;
      }
      const nextSelection = nextCardAfterRemoval(target.id, visibleIdeas);
      selectIdea(nextSelection);
      setMessage(action === "park" ? "Parked. It will stay there until you or Agency brings it back." : "Moved back to New.");
      await load(view, { preferred: nextSelection, excludeId: target.id });
    } finally {
      setFeedbackSubmitting(false);
    }
  }, [active, feedbackSubmitting, jobInFlight, load, selectIdea, view, visibleIdeas]);

  useEffect(() => {
    if (!active || composer) return;
    const shortcut = (event: KeyboardEvent) => {
      if (event.key === "Escape" && composer) {
        event.preventDefault();
        setComposer(null);
        return;
      }
      const action = cardShortcut({
        key: event.key,
        editable: event.composedPath().some((target) => target instanceof HTMLElement
          && (target.isContentEditable || target.matches("input, textarea, select"))),
        repeat: event.repeat,
        composing: event.isComposing,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
      });
      if (action === "skip") {
        event.preventDefault();
        void submitSkip();
      } else if (action === "improve") {
        event.preventDefault();
        void submitImprove();
      } else if (action === "park") {
        event.preventDefault();
        void submitTogglePark();
      } else if (action === "previous") {
        event.preventDefault();
        move(-1);
      } else if (action === "next") {
        event.preventDefault();
        move(1);
      } else if (action === "focus") {
        const box = document.querySelector<HTMLTextAreaElement>(".radar-inline-change textarea");
        if (box && !box.disabled) {
          event.preventDefault();
          box.focus();
        }
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [active, composer, move, submitImprove, submitSkip, submitTogglePark]);


  async function submitTell() {
    if (taskSubmittingRef.current) return;
    const task = taskDraft.trim();
    const dream = contextDraft.trim();
    if (composer === "task" ? !task : !dream) return;
    taskSubmittingRef.current = true;
    setTaskSubmitting(true);
    setComposerError("");
    try {
      if (composer === "task") {
        const { jobId } = await submitNewTask(task);
        const newIdeas = ideasForView(data.ideas, "new", sort);
        const filtered = newIdeas.filter((idea) => cluster === "all" || clusterForCard(idea, data.topics) === cluster);
        const candidates = filtered.length ? filtered : newIdeas;
        const next = active ? nextCardAfterRemoval(active.id, candidates) ?? candidates[0] ?? null : candidates[0] ?? null;
        if (!filtered.length) setCluster("all");
        setTaskDraft("");
        setComposer(null);
        setView("new");
        selectIdea(next);
        setMessage(`Task queued · #${jobId}. You can keep reviewing.`);
        // Refresh failure must not make a saved task look unsent.
        void load("new", { preferred: next }).catch(() => undefined);
      } else {
        const response = await fetch("/api/context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: dream }) });
        if (!response.ok) {
          const result = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(result?.error || "Your context was not saved. Try again.");
        }
        setComposer(null);
        await load();
      }
    } catch (error) {
      setComposerError(error instanceof TypeError
        ? "Could not confirm delivery. Your draft is still here; check Working before sending again."
        : error instanceof Error ? error.message : "Could not send. Your draft is still here.");
    } finally {
      taskSubmittingRef.current = false;
      setTaskSubmitting(false);
    }
  }

  function selectView(next: Idea["status"]) {
    setComposer(null);
    recordCardInteraction(active, "lane", next);
    setView(next);
    selectIdea(null);
    setMessage("");
  }

  function updateFeedback(value: string) {
    if (!active) return;
    const key = cardDraftKey(active);
    setFeedbackDrafts((current) => ({ ...current, [key]: value }));
  }

  function openNewTask() {
    recordCardInteraction(active, "new_task", "New Task");
    setMessage("");
    setComposerError("");
    setContextDraft(data.context?.text ?? "");
    setComposer("task");
  }

  function copyClaudeCommand() {
    void navigator.clipboard.writeText(CLAUDE_START_COMMAND).then(
      () => setMessage("Copied. Run it in a second terminal while Agency is open."),
      () => setMessage(`Copy this command: ${CLAUDE_START_COMMAND}`),
    );
  }


  if (loading) return <main className="radar-loading">Opening Agency…</main>;
  if (!data.context?.text?.trim()) {
    return (
      <main className="radar-onboarding-shell">
        <section className="radar-onboarding" aria-labelledby="onboarding-title">
          <header className="radar-onboarding-intro">
            <div className="radar-onboarding-brand"><span aria-hidden="true">A</span><strong>Agency</strong></div>
            <p>Personal operating layer</p>
            <h1 id="onboarding-title">Turn your real work into a clear queue.</h1>
            <small>Agency uses your local Claude session and the apps already connected to it. Your cards and profile stay on this machine.</small>
          </header>

          <div className="radar-onboarding-grid">
            <section className="radar-onboarding-form">
              <label htmlFor="agency-dream">What should Agency help you stay on top of?</label>
              <p>Describe your role, current priorities, recurring responsibilities, and anything it should ignore.</p>
              <textarea id="agency-dream" value={contextDraft} onChange={(event) => setContextDraft(event.target.value)} placeholder="I want one place to see the decisions, follow-ups, and work that need my attention…" />
              {composerError && <p className="radar-task-error" role="alert">{composerError}</p>}
              <button className="is-primary" disabled={taskSubmitting || !contextDraft.trim()} onClick={() => void submitTell()}>{taskSubmitting ? "Saving…" : "Save and continue"}</button>
            </section>

            <aside className="radar-onboarding-connections">
              <h2>Your existing connections come with you</h2>
              <p>Do not paste credentials into Agency. Claude checks the services it can already access and tells you what needs attention.</p>
              <div className="radar-source-list" aria-label="Example sources">
                {['Slack', 'Granola', 'Notion', 'Gmail', 'Calendar', 'GitHub'].map((source) => <span key={source}>{source}</span>)}
              </div>
              <ol>
                <li><strong>Set your focus</strong><span>Give Agency enough context to judge what matters.</span></li>
                <li><strong>Start Claude</strong><span>One command launches the coordinator with your existing Claude login.</span></li>
                <li><strong>Review prepared work</strong><span>Approve, redirect, park, or dismiss each card.</span></li>
              </ol>
            </aside>
          </div>

          <footer className="radar-onboarding-note">Local by default. No hosted account, shared database, or separate API key required.</footer>
        </section>
      </main>
    );
  }

  return (
    <main className="radar-shell">
      <aside className="radar-sidebar">
        <div className="radar-brand">
          <span className="radar-brand-mark" aria-hidden="true">A</span>
          <span><strong>Agency</strong><small>Personal work shell</small></span>
        </div>

        <button className={`radar-tell${composer ? " is-open" : ""}`} disabled={taskSubmitting} onClick={() => (composer ? setComposer(null) : openNewTask())}>
          <span aria-hidden="true">+</span> New task
        </button>

        <nav className="radar-lanes" aria-label="Agency queue">
          <span className="radar-nav-label">Queue</span>
          <button aria-label={`New, ${laneCounts.new} tickets`} className={view === "new" ? "is-active" : ""} onClick={() => selectView("new")}><span>New</span><b>{laneCounts.new}</b></button>
          <button aria-label={`Working, ${laneCounts.working} tickets`} className={view === "working" ? "is-active" : ""} onClick={() => selectView("working")}><span>Working</span><b>{laneCounts.working}</b></button>
          <button aria-label={`Parked, ${laneCounts.parked} tickets`} className={view === "parked" ? "is-active" : ""} onClick={() => selectView("parked")}><span>Parked</span><b>{laneCounts.parked}</b></button>
          <button aria-label={`Done, ${laneCounts.done} tickets`} className={view === "done" ? "is-active" : ""} onClick={() => selectView("done")}><span>Done</span><b>{laneCounts.done}</b></button>
        </nav>

        <div className="radar-sidebar-bottom">
          <DiscoveryRunStatus discovery={data.discovery} />
          <Link className="radar-scores" href="/stats" title="Points today and all time. Opens stats.">
            <span className="is-today"><b>{data.completionStats.pointsToday.toLocaleString("en-US")}</b><i>today</i></span>
            <span><b>{data.completionStats.points.toLocaleString("en-US")}</b><i>total</i></span>
          </Link>
          <Link className="radar-settings-link" href="/settings">Settings</Link>
          <footer className="radar-footer">
            <i /> {data.jobs.running ? `${data.jobs.running} jobs running` : data.jobs.queued ? `${data.jobs.queued} queued` : "Agency is ready"}
          </footer>
        </div>
      </aside>

      <section className="radar-main">
      <header className="radar-header">
        <div className="radar-view-title">
          <span>{view === "new" ? "Focus queue" : view === "working" ? "In progress" : view === "parked" ? "Out of the way" : "Work history"}</span>
          <strong>{view === "new" ? "Ready for you" : view === "working" ? "Agency is working" : view === "parked" ? "Parked for later" : "Closed"}</strong>
        </div>
        <div className="radar-header-right">
          {active && composer === null && view !== "done" && (
            <span className="radar-card-chips" title={`This card: score ${impactPoints(active)} of 10, about ${formatDuration(active.decisionEstimateMs)} to decide.`}>
              <span><b>{impactPoints(active)}</b><i>score</i></span>
              <span><b>{formatDuration(active.decisionEstimateMs)}</b><i>effort</i></span>
            </span>
          )}
        </div>
      </header>


      <nav className="radar-clusters" aria-label="Filter by kind of work">
        <div className="radar-sort" role="group" aria-label="Sort">
          {([["newest", "Newest"], ["score", "Score"], ["effort", "Effort"]] as const).map(([key, label]) => {
            const activeKey = sort.key === key;
            return (
              <button
                key={key}
                className={activeKey ? "is-active" : ""}
                title={activeKey ? "Click again to flip the direction" : `Sort by ${label.toLowerCase()}`}
                onClick={() => {
                  setComposer(null);
                  const next: SortMode = activeKey ? { key, dir: sort.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" };
                  setSort(next);
                  const reordered = ideasForView(data.ideas, view, next).filter((idea) => cluster === "all" || clusterForCard(idea, data.topics) === cluster);
                  selectIdea(reordered[0] ?? null);
                  recordCardInteraction(active, "lane", `sort:${next.key}:${next.dir}`);
                }}
              >{label}{activeKey && <i aria-label={sort.dir === "desc" ? "descending" : "ascending"}>{sort.dir === "desc" ? "↓" : "↑"}</i>}</button>
            );
          })}
        </div>
        <button className={cluster === "all" ? "is-active" : ""} onClick={() => selectCluster("all")}>All <b>{laneIdeas.length}</b></button>
        {data.topics.map((item) => (
          <button key={item.id} className={cluster === item.id ? "is-active" : ""} title={item.hint} onClick={() => selectCluster(item.id)}>
            {item.label} <b>{clusterCounts[item.id] ?? 0}</b>
          </button>
        ))}
      </nav>

      {composer === "task" ? (
        <section className="radar-task" aria-busy={taskSubmitting}>
          <label className="is-once">
            <span>New task</span>
            <textarea value={taskDraft} disabled={taskSubmitting} maxLength={MAX_TASK_LENGTH} onChange={(event) => setTaskDraft(event.target.value)} placeholder="One task, in your words. Agency carries your dream with it." />
          </label>
          {composerError && <p className="radar-task-error" role="alert">{composerError}</p>}
          <footer>
            <Link className="radar-settings-link" href="/settings">Edit my dream and topics in Settings</Link>
            <button className="is-dark" disabled={taskSubmitting || !taskDraft.trim()} onClick={() => void submitTell()}>{taskSubmitting ? "Sending…" : "Send"}</button>
          </footer>
        </section>
      ) : view === "done" ? (
        <DoneList ideas={visibleIdeas} topics={data.topics} onAction={(idea, action) => { if (action.action === "open" && action.url) window.open(new URL(action.url, window.location.origin).toString(), "_blank", "noopener"); }} onInteraction={(idea, action, label) => recordCardInteraction(idea, action, label)} />
      ) : active ? (
        <section className="radar-workspace">
          {active.status === "parked" && <span className="radar-parked" role="status">Parked {formatParkedUntil(active.parkedUntil)}</span>}
          {jobInFlight && activeJob && (
            <section className="radar-job-brief" aria-label="Your instructions for this job">
              <header><span>Your instructions</span><b>{activeJob.status === "queued" ? "Queued" : "In progress"}</b></header>
              <strong>{activeJob.label || "Work on this card"}</strong>
              {activeJob.instruction && <p>{activeJob.instruction}</p>}
              {activeJob.feedback && <p className="is-feedback">{activeJob.feedback}</p>}
            </section>
          )}
          {showLastRound && activeJob && (
            <section className="radar-last-round" aria-label="Last round with Agency">
              <header><span>Last round</span><b>{activeJob.outcome === "review" ? "Back for review" : activeJob.status === "failed" ? "Needs attention" : "Finished"}</b></header>
              {lastRoundInstruction && <div><strong>What you asked</strong><p>{lastRoundInstruction}</p></div>}
              <div><strong>What Agency did</strong><p>{activeJob.result || "No completion note was saved."}</p></div>
            </section>
          )}
          <section className="radar-card-host">
            <AgentCard idea={active} actionable={!jobInFlight} onAction={handleCardAction} onInteraction={(action, label) => recordCardInteraction(active, action, label)} />
          </section>

          <section className="radar-inline-change">
            <textarea
              aria-label={jobInFlight ? "Add an instruction to the current job" : "Change this card"}
              value={feedback}
              rows={1}
              disabled={feedbackSubmitting}
              onChange={(event) => { updateFeedback(event.target.value); event.target.style.height = "auto"; event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`; }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                void submitFeedback();
              }}
              placeholder={feedbackSubmitting
                ? "Adding your instruction…"
                : jobInFlight
                  ? "Add another instruction while Agency works…"
                  : "Add context or say what to change… Enter sends, Shift+Enter adds a line"}
            />
            <div className="radar-inline-actions">
              <button
                className="is-park radar-shortcut-hint"
                disabled={jobInFlight || feedbackSubmitting}
                aria-keyshortcuts="P"
                aria-label={active.status === "parked" ? "Bring this card back to New" : "Park this card"}
                data-shortcut-hint={active.status === "parked" ? "Bring back · P" : "Park · P"}
                onClick={() => void submitTogglePark()}
              >{active.status === "parked" ? "Bring back" : "Park"}<kbd>P</kbd></button>
              <button
                className="is-skip radar-shortcut-hint"
                disabled={jobInFlight || feedbackSubmitting}
                aria-keyshortcuts="S"
                aria-label="Skip this card"
                data-shortcut-hint="Skip · S"
                onClick={() => void submitSkip()}
              >Skip <kbd>S</kbd></button>
              <button
                className="is-improve radar-shortcut-hint"
                disabled={jobInFlight || feedbackSubmitting}
                aria-keyshortcuts="I"
                onClick={() => void submitImprove()}
                aria-label="Auto-improve this card"
                data-shortcut-hint="Auto-improve · I"
              >Improve <kbd>I</kbd></button>
              <button
                className="is-send radar-shortcut-hint"
                disabled={feedbackSubmitting || !feedback.trim()}
                aria-label={jobInFlight ? "Add instruction" : "Send"}
                data-shortcut-hint={jobInFlight ? "Add instruction · Enter" : "Send · Enter in feedback"}
                onClick={() => void submitFeedback()}
              >{jobInFlight ? "Add" : "Send"} <kbd>↵</kbd></button>
            </div>
          </section>

          <div className="radar-next">
            <button className="radar-shortcut-hint" data-shortcut-hint="Previous card · ←" data-shortcut-side="start" aria-keyshortcuts="ArrowLeft" onClick={() => move(-1)} aria-label="Previous card">← Back</button>
            <span>{selectedIndex >= 0 ? `${activeIndex + 1} of ${visibleIdeas.length}` : `Pinned · ${visibleIdeas.length} ${view}`}</span>
            <button className="radar-shortcut-hint" data-shortcut-hint="Next card · →" aria-keyshortcuts="ArrowRight" onClick={() => move(1)} aria-label="Next card">Next →</button>
          </div>
        </section>
      ) : view === "new" && !Object.values(laneCounts).some(Boolean) ? (
        <section className="radar-empty radar-empty-setup">
          <div>
            <span className="radar-setup-kicker">Your focus is saved</span>
            <h2>Start your Agency coordinator</h2>
            <p>Keep this app open, then run the command below in a second terminal. Claude will use its existing connections, verify each source with a live read, and prepare your first cards.</p>
            <div className="radar-command">
              <code>{CLAUDE_START_COMMAND}</code>
              <button onClick={copyClaudeCommand}>Copy</button>
            </div>
            <small>Agency never asks you to paste Slack, Granola, Notion, or Gmail credentials into this app.</small>
          </div>
        </section>
      ) : (
        <section className="radar-empty"><strong>{view === "new" ? "You are caught up." : view === "working" ? "No agents working." : view === "parked" ? "Nothing parked." : "Nothing done yet."}</strong></section>
      )}

      {!composer && message && <div className="radar-message" role="status">{message}</div>}

      {data.decisionMetrics.tracked > 0 && <footer className="radar-main-footer">You decide in {formatDuration(data.decisionMetrics.medianAcceptedActiveMs)} on average</footer>}
      </section>
    </main>
  );
}
