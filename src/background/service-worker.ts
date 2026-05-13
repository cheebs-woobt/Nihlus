import { pickBanter } from "../lib/banter.ts";
import { classifyUrl, extractHostname } from "../lib/classify.ts";
import {
  defaultUserConfig,
  loadConfig,
  saveConfig,
  USER_CONFIG_STORAGE_KEY,
} from "../lib/config.ts";
import {
  isBanterDismissedMessage,
  type ShowBanterMessage,
} from "../lib/messages.ts";
import { incrementDismissals } from "../lib/session-state.ts";

// MV3 service worker. Responsibilities for Phase 3:
//   1. Backfill the default UserConfig on first install (Phase 2).
//   2. On every tab URL transition, classify the URL and console.log
//      the decision (Phase 2).
//   3. NEW: when a navigation completes on a distracting URL, send a
//      ShowBanterMessage to the tab's content script unless that tab
//      is inside its 30-second dismissal cooldown or has already had
//      banter shown for the same URL this nav.
//   4. NEW: receive BanterDismissedMessage from the content script,
//      arm the per-tab cooldown, and increment sessionDismissals.

// Per-tab cooldown: a dismissal silences banter on this tab for
// COOLDOWN_MS. In-memory because the cooldown is session-scoped and
// tab IDs are not stable across browser restarts anyway.
const COOLDOWN_MS = 30_000;
const tabCooldownExpiresAt = new Map<number, number>();

// Dedupe: avoid re-showing banter when a tab fires "complete" twice
// for the same URL (e.g. iframe loads, SPA route changes that touch
// onUpdated). Cleared on tab removal so we don't accumulate.
const lastBanterUrlByTab = new Map<number, string>();

chrome.runtime.onInstalled.addListener((details) => {
  console.log("Nihlus service worker installed", details.reason);
  void ensureDefaultConfig();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = pickUrl(changeInfo, tab);
  if (url !== null) {
    void classifyAndLog(url);
  }
  // Banter only fires on "complete" so the content script has had a
  // chance to inject. URL-only events (the early commit signal) are
  // logged above but don't trigger overlays.
  if (changeInfo.status !== "complete") return;
  const finalUrl = typeof tab.url === "string" ? tab.url : url;
  if (finalUrl === null) return;
  void maybeSendBanter(tabId, finalUrl);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabCooldownExpiresAt.delete(tabId);
  lastBanterUrlByTab.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!isBanterDismissedMessage(message)) return;
  const tabId = sender.tab?.id;
  if (tabId !== undefined) {
    tabCooldownExpiresAt.set(tabId, Date.now() + COOLDOWN_MS);
  }
  void incrementDismissals().then((state) => {
    console.log(
      `Nihlus banter dismissed (id ${message.banterId}). Session dismissals today: ${state.sessionDismissals}`,
    );
  });
});

async function ensureDefaultConfig(): Promise<void> {
  try {
    const result = await chrome.storage.local.get(USER_CONFIG_STORAGE_KEY);
    if (result[USER_CONFIG_STORAGE_KEY] !== undefined) return;
    await saveConfig(defaultUserConfig());
    console.log("Nihlus wrote default UserConfig on first install");
  } catch (err) {
    console.warn("Nihlus ensureDefaultConfig failed:", err);
  }
}

async function classifyAndLog(url: string): Promise<void> {
  const hostname = extractHostname(url);
  if (hostname === null) return;

  const config = await loadConfig();
  const decision = classifyUrl(config, url);

  if (decision.verdict === "distracting") {
    const reason =
      decision.matchedEntry !== null
        ? `matched blocked entry "${decision.matchedEntry}"`
        : `not on allow list (whitelist mode)`;
    console.log(`Nihlus would intervene here: ${url}  (${reason})`);
    return;
  }
  if (decision.verdict === "allowed") {
    console.log(`Nihlus allowed ${hostname} (matched "${decision.matchedEntry ?? ""}")`);
    return;
  }
  if (config.focusModeActive) {
    console.debug(`Nihlus neutral: ${hostname} (no list match, blacklist mode)`);
  }
}

async function maybeSendBanter(tabId: number, url: string): Promise<void> {
  const hostname = extractHostname(url);
  if (hostname === null) return;

  // Dismissal cooldown.
  const cooldownExpiry = tabCooldownExpiresAt.get(tabId) ?? 0;
  if (Date.now() < cooldownExpiry) {
    console.debug(`Nihlus banter suppressed: tab ${tabId} cooldown active`);
    return;
  }

  // Dedupe same-URL re-fires within the same tab.
  if (lastBanterUrlByTab.get(tabId) === url) return;

  const config = await loadConfig();
  const decision = classifyUrl(config, url);
  if (decision.verdict !== "distracting") return;

  const pick = pickBanter();
  lastBanterUrlByTab.set(tabId, url);

  const message: ShowBanterMessage = {
    type: "nihlus/show-banter",
    message: pick.message,
    banterId: pick.id,
  };

  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    // Common: the page rejected the content script (chrome://, the
    // web store, PDF viewer, sandboxed iframe) so no listener is
    // present. Quiet log so we can debug without noise.
    console.debug(`Nihlus banter send failed for tab ${tabId}:`, err);
  }
}

function pickUrl(
  changeInfo: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab,
): string | null {
  if (changeInfo.url !== undefined) return changeInfo.url;
  if (changeInfo.status === "complete" && typeof tab.url === "string") {
    return tab.url;
  }
  return null;
}
