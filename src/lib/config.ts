// UserConfig: the persisted shape of every preference the user can set
// from the popup. One row in chrome.storage.local under STORAGE_KEY holds
// the full object; partial writes go through saveConfig which reads the
// current value, merges, and writes back so multiple panels (popup,
// future options page) can never clobber each other's fields.

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
}

const STORAGE_KEY = "userConfig";

export function defaultUserConfig(): UserConfig {
  return {
    focusModeActive: false,
    allowedSites: [],
    blockedSites: [],
    commitmentOfTheHour: "",
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
  };
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
