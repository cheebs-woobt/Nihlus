// Per-user persisted state that is NOT user preference. Counts of past
// behavior (dismissals + reasons + sites), the user's stated commitment
// for the day, and the "we already prompted you" flag for the daily
// commitment. Separate from UserConfig so a Save click in the popup
// can never overwrite observation data, and so a daily reset can never
// touch allow/block lists.
//
// Reset semantics: lazy and partial. Every read checks whether
// sessionResetDate is today; on mismatch the read returns a fresh
// state that ZEROES commitmentOfTheDay, commitmentPromptSkippedDate,
// and recentlyDismissedSites, but PRESERVES the dismissals log (which
// is a rolling 200-entry FIFO spanning days so "this week" stats work).

const STORAGE_KEY = "sessionState";
const MAX_DISMISSALS = 200;
const MAX_RECENT_DISMISSED_SITES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export type DismissReason = "break" | "work" | "stuck" | "tired" | "later";

// Single ordered source of truth for the reason chips. Rendered in
// this order in the content-script overlay and the popup stats panel,
// so a reshuffle here flows through both UIs without manual sync.
export const DISMISS_REASONS: readonly DismissReason[] = [
  "break",
  "work",
  "stuck",
  "tired",
  "later",
];

export interface DismissalEntry {
  // banterId is -1 for AI-generated banter (no pool index) or the
  // static pool index. Kept on the entry for debugging; not used in
  // any aggregation.
  banterId: number;
  // Full URL the user was on when they dismissed. Stored verbatim;
  // sensitive query params will appear here. The popup never renders
  // the URL, only the derived hostname.
  url: string;
  // Hostname extracted by the worker before persisting. Stored alongside
  // url so aggregation queries don't need to URL-parse 200 entries
  // every popup open.
  hostname: string;
  reason: DismissReason;
  // Unix ms. Used by countByReasonToday / topDismissedSitesThisWeek
  // for time-window filtering.
  timestamp: number;
}

export interface SessionState {
  // YYYY-MM-DD local timezone. Compared against todayIsoDate() on
  // every read; mismatch triggers the daily-reset path.
  sessionResetDate: string;
  // User's stated commitment for today, set via the popup. Empty
  // string when unset (initial state OR after a daily reset).
  commitmentOfTheDay: string;
  // YYYY-MM-DD on which the user dismissed the "What are you working
  // on today?" prompt without setting a commitment. While this equals
  // todayIsoDate() the popup will not re-show the prompt today. Empty
  // string when unset.
  commitmentPromptSkippedDate: string;
  // Rolling FIFO log capped at MAX_DISMISSALS. Spans days; NOT reset
  // at midnight because the "this week" stats panel needs 7 days of
  // history. Oldest entries drop off the front when a new entry would
  // push past the cap.
  dismissals: DismissalEntry[];
  // Most-recent first hostname list (capped, deduped). Used only by
  // the LLM banter prompt as a quick "did you just bounce off these"
  // signal. Reset daily.
  recentlyDismissedSites: string[];
}

export function defaultSessionState(): SessionState {
  return {
    sessionResetDate: todayIsoDate(),
    commitmentOfTheDay: "",
    commitmentPromptSkippedDate: "",
    dismissals: [],
    recentlyDismissedSites: [],
  };
}

export async function getSessionState(): Promise<SessionState> {
  let raw: unknown;
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    raw = result[STORAGE_KEY];
  } catch (err) {
    console.warn("[Nihlus session] read failed; using defaults:", err);
    return defaultSessionState();
  }
  const current = sanitize(raw);
  const today = todayIsoDate();
  if (current.sessionResetDate !== today) {
    const reset: SessionState = {
      sessionResetDate: today,
      commitmentOfTheDay: "",
      commitmentPromptSkippedDate: "",
      // PRESERVE the dismissals log. The "this week" view depends on
      // entries older than today.
      dismissals: current.dismissals,
      recentlyDismissedSites: [],
    };
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: reset });
    } catch (err) {
      console.warn("[Nihlus session] reset write failed:", err);
    }
    return reset;
  }
  return current;
}

// Append a dismissal to the rolling log, trim to cap, and update the
// recently-dismissed-sites cache. Replaces Phase 4's incrementDismissals
// (the count is now derived via countDismissalsToday).
export async function recordDismissal(input: {
  banterId: number;
  url: string;
  hostname: string;
  reason: DismissReason;
}): Promise<SessionState> {
  const cur = await getSessionState();
  const entry: DismissalEntry = {
    banterId: input.banterId,
    url: input.url,
    hostname: input.hostname,
    reason: input.reason,
    timestamp: Date.now(),
  };
  const dismissals = [...cur.dismissals, entry];
  while (dismissals.length > MAX_DISMISSALS) dismissals.shift();
  const recentlyDismissedSites = pushRecentSite(cur.recentlyDismissedSites, input.hostname);
  const next: SessionState = {
    ...cur,
    dismissals,
    recentlyDismissedSites,
  };
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  } catch (err) {
    console.warn("[Nihlus session] recordDismissal write failed:", err);
  }
  return next;
}

export async function setCommitmentOfTheDay(text: string): Promise<SessionState> {
  const cur = await getSessionState();
  const next: SessionState = { ...cur, commitmentOfTheDay: text };
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  } catch (err) {
    console.warn("[Nihlus session] commitment write failed:", err);
  }
  return next;
}

export async function markCommitmentPromptSkippedToday(): Promise<SessionState> {
  const cur = await getSessionState();
  const next: SessionState = {
    ...cur,
    commitmentPromptSkippedDate: todayIsoDate(),
  };
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  } catch (err) {
    console.warn("[Nihlus session] skip-prompt write failed:", err);
  }
  return next;
}

// --- Derived queries (pure, take state as input) -----------------------

export function countDismissalsToday(state: SessionState): number {
  const start = startOfTodayMs();
  let n = 0;
  for (const d of state.dismissals) {
    if (d.timestamp >= start) n += 1;
  }
  return n;
}

export function countByReasonToday(state: SessionState): Record<DismissReason, number> {
  const start = startOfTodayMs();
  const counts: Record<DismissReason, number> = {
    break: 0,
    work: 0,
    stuck: 0,
    tired: 0,
    later: 0,
  };
  for (const d of state.dismissals) {
    if (d.timestamp < start) continue;
    counts[d.reason] += 1;
  }
  return counts;
}

// Top hostnames the user dismissed banter on within the last 7 days
// (rolling, not calendar week). Returned descending by count, capped
// at limit. Empty array when no qualifying dismissals exist.
export function topDismissedSitesThisWeek(
  state: SessionState,
  limit: number = 3,
): Array<{ hostname: string; count: number }> {
  const cutoff = Date.now() - 7 * DAY_MS;
  const counts = new Map<string, number>();
  for (const d of state.dismissals) {
    if (d.timestamp < cutoff) continue;
    if (d.hostname.length === 0) continue;
    counts.set(d.hostname, (counts.get(d.hostname) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([hostname, count]) => ({ hostname, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// Subscribe to changes from other surfaces (worker writing a new
// dismissal while the popup is open). Mirrors subscribeConfig.
export function subscribeSessionState(
  listener: (next: SessionState) => void,
): () => void {
  const handler = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: chrome.storage.AreaName,
  ): void => {
    if (areaName !== "local") return;
    const change = changes[STORAGE_KEY];
    if (change === undefined) return;
    listener(sanitize(change.newValue));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => {
    chrome.storage.onChanged.removeListener(handler);
  };
}

// --- internal helpers --------------------------------------------------

function pushRecentSite(
  current: readonly string[],
  hostname: string | null | undefined,
): string[] {
  if (hostname === null || hostname === undefined || hostname.length === 0) {
    return [...current];
  }
  const filtered = current.filter((h) => h !== hostname);
  filtered.unshift(hostname);
  if (filtered.length > MAX_RECENT_DISMISSED_SITES) {
    filtered.length = MAX_RECENT_DISMISSED_SITES;
  }
  return filtered;
}

function isDismissReason(v: unknown): v is DismissReason {
  return (
    v === "break" ||
    v === "work" ||
    v === "stuck" ||
    v === "tired" ||
    v === "later"
  );
}

function sanitize(raw: unknown): SessionState {
  const def = defaultSessionState();
  if (typeof raw !== "object" || raw === null) return def;
  const o = raw as Record<string, unknown>;

  const date =
    typeof o["sessionResetDate"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o["sessionResetDate"])
      ? o["sessionResetDate"]
      : def.sessionResetDate;

  const commitmentOfTheDay =
    typeof o["commitmentOfTheDay"] === "string" ? o["commitmentOfTheDay"] : "";

  const commitmentPromptSkippedDate =
    typeof o["commitmentPromptSkippedDate"] === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(o["commitmentPromptSkippedDate"])
      ? o["commitmentPromptSkippedDate"]
      : "";

  return {
    sessionResetDate: date,
    commitmentOfTheDay,
    commitmentPromptSkippedDate,
    dismissals: sanitizeDismissals(o["dismissals"]),
    recentlyDismissedSites: sanitizeSiteList(o["recentlyDismissedSites"]),
  };
}

function sanitizeDismissals(raw: unknown): DismissalEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: DismissalEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r["banterId"] !== "number") continue;
    if (typeof r["url"] !== "string") continue;
    if (typeof r["hostname"] !== "string") continue;
    if (!isDismissReason(r["reason"])) continue;
    if (typeof r["timestamp"] !== "number" || !Number.isFinite(r["timestamp"])) continue;
    out.push({
      banterId: r["banterId"],
      url: r["url"],
      hostname: r["hostname"],
      reason: r["reason"],
      timestamp: r["timestamp"],
    });
    if (out.length >= MAX_DISMISSALS) break;
  }
  return out;
}

function sanitizeSiteList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const cleaned = entry.trim().toLowerCase();
    if (cleaned.length === 0) continue;
    if (out.includes(cleaned)) continue;
    out.push(cleaned);
    if (out.length >= MAX_RECENT_DISMISSED_SITES) break;
  }
  return out;
}

function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function todayIsoDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export const SESSION_STATE_STORAGE_KEY = STORAGE_KEY;
