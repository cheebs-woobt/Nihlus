// UserConfig: the persisted shape of every preference the user can set
// from the popup. One row in chrome.storage.local under STORAGE_KEY holds
// the full object; partial writes go through saveConfig which reads the
// current value, merges, and writes back so multiple panels (popup,
// future options page) can never clobber each other's fields.

// Allowed Claude model identifiers. Kept as a string-literal union so
// the popup's <select> options and the service worker's request body
// agree on the same set. New models extend this list; the dropdown
// renders one option per entry. Default chosen for cost + latency.
export const CLAUDE_MODEL_OPTIONS = [
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
] as const;
export type ClaudeModelId = (typeof CLAUDE_MODEL_OPTIONS)[number];
export const DEFAULT_CLAUDE_MODEL: ClaudeModelId = "claude-haiku-4-5";

export interface UserConfig {
  // Master switch. When false, the service worker classifies but skips
  // any future intervention. Default false so a fresh install doesn't
  // nag before the user has set anything up.
  focusModeActive: boolean;
  // Hostnames or hostname fragments treated as on-task. A page matches
  // if any entry is a substring of the URL's hostname (after a lowercase
  // + trim normalization). Empty list means "no explicit allow list";
  // see classifyUrl for the resulting semantics.
  allowedSites: string[];
  // Hostnames or hostname fragments treated as off-task. Same substring
  // semantics as allowedSites. Wins over allowedSites on conflict so a
  // user accidentally adding "youtube.com" to both lists still gets the
  // distraction call.
  blockedSites: string[];
  // Free-text statement of what the user committed to working on for
  // the current hour. Surfaces in future banter / nudge UIs; in Phase 2
  // it is stored and round-tripped only.
  commitmentOfTheHour: string;
  // Anthropic API key. Stored verbatim (no encryption); chrome.storage
  // .local is sandboxed to this extension, but the popup never echoes
  // this back into logs or error strings. Empty string = unset.
  claudeApiKey: string;
  // When true and claudeApiKey is non-empty, the worker calls Claude
  // to generate banter on each distraction. On any failure (no key,
  // 401, 429, network, malformed response) it falls back silently to
  // the static pool.
  aiBanterEnabled: boolean;
  // Model used by generateBanter. Restricted to the union above so
  // typos can't ship to the request body. Migrated to the default on
  // load if a previously-stored value is no longer in the union.
  claudeModel: ClaudeModelId;
  // Whether the overlay plays a soft 440 Hz chime on appearance.
  // Distinct from AI banter: the chime fires for static-pool banter
  // too. Default true per Wyatt's calibration: appearance should
  // notice. Toggle in the popup.
  overlaySoundEnabled: boolean;
  // Phase 6 star-level system. starLevel is a fractional number so
  // small escalations (+0.25 for a distraction visit, +0.5 for a
  // dismiss) can accumulate without overshooting. Math.floor of the
  // value is what drives behavior dispatch and star rendering.
  // Clamped on every adjustStarLevel call to [starMinimum, starMaximum].
  starLevel: number;
  // User-controlled floor. Even after a full clean-focus decay the
  // worker will not drop below this. Slider in advanced popup.
  starMinimum: number;
  // User-controlled ceiling. 5 and 6 are gated behind a warning in the
  // popup because they introduce tab closures + temporary blocks.
  starMaximum: number;
  // Last-N adjustment log. Used by the popup's debug view and by the
  // dismiss-pattern + clean-focus triggers (they read recent timestamps
  // to decide whether to escalate / decay). FIFO capped at 50 entries.
  escalationEvents: EscalationEvent[];
  // Auto-applied hostname blocks added when a level-5/6 close fires.
  // Each entry has its own expiresAt (Unix ms); classifyUrl filters
  // expired entries on read so the popup never has to garbage-collect
  // them. Empty list when no auto-blocks are active.
  temporaryBlacklist: TemporaryBlock[];
}

export interface EscalationEvent {
  // Unix ms when the adjustStarLevel call landed.
  timestamp: number;
  // Signed delta applied. Positive = escalation, negative = de-escalation.
  delta: number;
  // Short reason tag matching the trigger names in the spec:
  // "dismiss" | "distraction-visit" | "rapid-reopen" | "dismiss-pattern"
  // | "clean-focus" | "commitment-complete" | "manual-reset"
  // | "manual-set". Stored as plain string to avoid a future-edit
  // schema migration.
  reason: string;
}

export interface TemporaryBlock {
  hostname: string;
  // Unix ms after which classifyUrl ignores this entry.
  expiresAt: number;
}

export const STAR_LEVEL_FLOOR = 0;
export const STAR_LEVEL_CEILING = 6;
export const MAX_ESCALATION_EVENTS = 50;

const STORAGE_KEY = "userConfig";

export function defaultUserConfig(): UserConfig {
  return {
    focusModeActive: false,
    allowedSites: [],
    blockedSites: [],
    commitmentOfTheHour: "",
    claudeApiKey: "",
    aiBanterEnabled: false,
    claudeModel: DEFAULT_CLAUDE_MODEL,
    overlaySoundEnabled: true,
    starLevel: 1,
    starMinimum: 1,
    starMaximum: 4,
    escalationEvents: [],
    temporaryBlacklist: [],
  };
}

// Load the persisted UserConfig, backfilling any missing fields with
// defaults. Returns defaults wholesale when the key is absent (fresh
// install) or the stored shape is unrecognizable (manual edit gone
// wrong). Never throws; on storage API failure the caller is given a
// usable default instead of a rejection.
export async function loadConfig(): Promise<UserConfig> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const raw: unknown = result[STORAGE_KEY];
    return sanitizeConfig(raw);
  } catch (err) {
    console.warn("[Nihlus config] loadConfig failed; using defaults:", err);
    return defaultUserConfig();
  }
}

// Persist a complete UserConfig. The popup edits its own local copy
// then calls saveConfig once with the final value; this avoids
// partial-write races between concurrent fields and matches Phase 2's
// "save button" UX.
export async function saveConfig(config: UserConfig): Promise<void> {
  const clean = sanitizeConfig(config);
  await chrome.storage.local.set({ [STORAGE_KEY]: clean });
}

// Subscribe to storage changes. Returns an unsubscribe handle so React
// effects can detach on unmount. Listener fires only when STORAGE_KEY
// changes and only in local storage area, so future sync-storage usage
// elsewhere won't accidentally trip it.
export function subscribeConfig(listener: (next: UserConfig) => void): () => void {
  const handler = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: chrome.storage.AreaName,
  ): void => {
    if (areaName !== "local") return;
    const change = changes[STORAGE_KEY];
    if (change === undefined) return;
    listener(sanitizeConfig(change.newValue));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => {
    chrome.storage.onChanged.removeListener(handler);
  };
}

function sanitizeConfig(raw: unknown): UserConfig {
  const def = defaultUserConfig();
  if (typeof raw !== "object" || raw === null) return def;
  const o = raw as Record<string, unknown>;
  return {
    focusModeActive: typeof o["focusModeActive"] === "boolean" ? o["focusModeActive"] : def.focusModeActive,
    allowedSites: sanitizeSiteList(o["allowedSites"]),
    blockedSites: sanitizeSiteList(o["blockedSites"]),
    commitmentOfTheHour:
      typeof o["commitmentOfTheHour"] === "string" ? o["commitmentOfTheHour"] : def.commitmentOfTheHour,
    claudeApiKey:
      typeof o["claudeApiKey"] === "string" ? o["claudeApiKey"] : def.claudeApiKey,
    aiBanterEnabled:
      typeof o["aiBanterEnabled"] === "boolean" ? o["aiBanterEnabled"] : def.aiBanterEnabled,
    claudeModel: sanitizeModelId(o["claudeModel"]),
    overlaySoundEnabled:
      typeof o["overlaySoundEnabled"] === "boolean"
        ? o["overlaySoundEnabled"]
        : def.overlaySoundEnabled,
    starLevel: clampNumber(o["starLevel"], STAR_LEVEL_FLOOR, STAR_LEVEL_CEILING, def.starLevel),
    starMinimum: clampInt(o["starMinimum"], STAR_LEVEL_FLOOR, 3, def.starMinimum),
    starMaximum: clampInt(o["starMaximum"], 1, STAR_LEVEL_CEILING, def.starMaximum),
    escalationEvents: sanitizeEscalationEvents(o["escalationEvents"]),
    temporaryBlacklist: sanitizeTempBlacklist(o["temporaryBlacklist"]),
  };
}

function clampNumber(raw: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, raw));
}

function clampInt(raw: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(raw)));
}

function sanitizeEscalationEvents(raw: unknown): EscalationEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: EscalationEvent[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r["timestamp"] !== "number" || !Number.isFinite(r["timestamp"])) continue;
    if (typeof r["delta"] !== "number" || !Number.isFinite(r["delta"])) continue;
    if (typeof r["reason"] !== "string") continue;
    out.push({
      timestamp: r["timestamp"],
      delta: r["delta"],
      reason: r["reason"],
    });
    if (out.length >= MAX_ESCALATION_EVENTS) break;
  }
  return out;
}

function sanitizeTempBlacklist(raw: unknown): TemporaryBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: TemporaryBlock[] = [];
  const now = Date.now();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r["hostname"] !== "string") continue;
    if (typeof r["expiresAt"] !== "number" || !Number.isFinite(r["expiresAt"])) continue;
    // Drop already-expired entries on the read path so the stored list
    // doesn't grow without bound across long sessions.
    if (r["expiresAt"] <= now) continue;
    out.push({ hostname: r["hostname"], expiresAt: r["expiresAt"] });
  }
  return out;
}

function sanitizeModelId(raw: unknown): ClaudeModelId {
  if (typeof raw !== "string") return DEFAULT_CLAUDE_MODEL;
  for (const id of CLAUDE_MODEL_OPTIONS) {
    if (id === raw) return id;
  }
  return DEFAULT_CLAUDE_MODEL;
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
  }
  return out;
}

// Exported for the popup so it can run the same normalization as
// saveConfig before display/edit, keeping the round-trip stable.
export { sanitizeSiteList };

export const USER_CONFIG_STORAGE_KEY = STORAGE_KEY;
