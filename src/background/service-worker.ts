import { classifyUrl, extractHostname } from "../lib/classify.ts";
import {
  defaultUserConfig,
  loadConfig,
  saveConfig,
  USER_CONFIG_STORAGE_KEY,
} from "../lib/config.ts";

// MV3 service worker. Responsibilities for Phase 2:
//   1. Backfill the default UserConfig on first install so the popup
//      always opens against a real object, not an empty storage row.
//   2. On every tab URL transition, classify the URL against the user's
//      current allow/block lists and console.log the decision. The
//      Phase 3 banter layer will subscribe here later; for now the log
//      is the only visible effect.

chrome.runtime.onInstalled.addListener((details) => {
  console.log("Nihlus service worker installed", details.reason);
  void ensureDefaultConfig();
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  // Two events fire per navigation: changeInfo.url on the navigation
  // commit, and changeInfo.status === "complete" when the page has
  // finished loading. Classify on either signal, but only once per
  // URL transition.
  const url = pickUrl(changeInfo, tab);
  if (url === null) return;
  void classifyAndLog(url);
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
    const reason = decision.matchedEntry !== null
      ? `matched blocked entry "${decision.matchedEntry}"`
      : `not on allow list (whitelist mode)`;
    console.log(`Nihlus would intervene here: ${url}  (${reason})`);
    return;
  }
  if (decision.verdict === "allowed") {
    console.log(`Nihlus allowed ${hostname} (matched "${decision.matchedEntry ?? ""}")`);
    return;
  }
  // Neutral: focus mode off, internal URL, or no list opinion. Log at
  // debug volume so Wyatt can verify the listener fires without
  // drowning the console.
  if (config.focusModeActive) {
    console.debug(`Nihlus neutral: ${hostname} (no list match, blacklist mode)`);
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
