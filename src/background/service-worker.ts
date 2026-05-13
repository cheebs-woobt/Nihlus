import { pickBanter } from "../lib/banter.ts";
import { classifyUrl, extractHostname } from "../lib/classify.ts";
import {
  defaultUserConfig,
  loadConfig,
  saveConfig,
  USER_CONFIG_STORAGE_KEY,
  type UserConfig,
} from "../lib/config.ts";
import {
  deriveTimeOfDay,
  generateBanter,
  type BanterContext,
  type GenerateBanterResult,
} from "../lib/llm.ts";
import {
  isBanterDismissedMessage,
  type ShowBanterMessage,
} from "../lib/messages.ts";
import {
  countDismissalsToday,
  getSessionState,
  recordDismissal,
} from "../lib/session-state.ts";

// MV3 service worker. Phase 4 responsibilities (additive over Phase 3):
//   - When aiBanterEnabled is true and an API key is set, generateBanter
//     is the primary picker. On any failure (no key, auth, rate-limit,
//     network, malformed, empty) the worker falls back silently to the
//     static pool and logs the reason at warn level (never the key).
//   - The last 3 AI-generated banters are passed back into the next
//     call so the model can avoid repeating itself.
//   - The dismissed-banter handler additionally pushes the hostname
//     into sessionState.recentlyDismissedSites for the next prompt.

const COOLDOWN_MS = 30_000;
const RECENT_BANTER_CACHE = 3;

const tabCooldownExpiresAt = new Map<number, number>();
const lastBanterUrlByTab = new Map<number, string>();

// Rolling cache of the most recent AI-generated banter strings. Held
// here (not in storage) because rotation is session-scope and the
// service worker tear-down naturally resets it.
const recentAiBanters: string[] = [];

chrome.runtime.onInstalled.addListener((details) => {
  console.log("Nihlus service worker installed", details.reason);
  void ensureDefaultConfig();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = pickUrl(changeInfo, tab);
  if (url !== null) {
    void classifyAndLog(url);
  }
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
  // Resolve the URL the user was on when they dismissed so we can
  // record a complete entry. lastBanterUrlByTab is what we displayed
  // banter for; falls back to "" silently when the tab record is gone
  // (e.g. tab closed mid-dismissal).
  const url = tabId !== undefined ? lastBanterUrlByTab.get(tabId) ?? "" : "";
  const hostname = url.length > 0 ? extractHostname(url) ?? "" : "";
  void recordDismissal({
    banterId: message.banterId,
    url,
    hostname,
    reason: message.reason,
  }).then((state) => {
    const todayCount = countDismissalsToday(state);
    console.log(
      `Nihlus banter dismissed (${message.reason}, id ${message.banterId}). ` +
        `Today: ${todayCount} dismissals.`,
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

  const cooldownExpiry = tabCooldownExpiresAt.get(tabId) ?? 0;
  if (Date.now() < cooldownExpiry) {
    console.debug(`Nihlus banter suppressed: tab ${tabId} cooldown active`);
    return;
  }
  if (lastBanterUrlByTab.get(tabId) === url) return;

  const config = await loadConfig();
  const decision = classifyUrl(config, url);
  if (decision.verdict !== "distracting") return;

  const { message, banterId, source } = await pickAnyBanter(config, url);
  lastBanterUrlByTab.set(tabId, url);

  const out: ShowBanterMessage = {
    type: "nihlus/show-banter",
    message,
    banterId,
  };

  try {
    await chrome.tabs.sendMessage(tabId, out);
    console.debug(`Nihlus sent ${source} banter (id ${banterId}) to tab ${tabId}`);
  } catch (err) {
    console.debug(`Nihlus banter send failed for tab ${tabId}:`, err);
  }
}

interface BanterChoice {
  message: string;
  banterId: number;
  source: "ai" | "static";
}

// Decides between AI-generated and static-pool banter for the current
// distraction. AI is primary when both aiBanterEnabled and a non-empty
// claudeApiKey are present; any failure reason falls back silently to
// the static pool so the user always sees some line. The AI branch
// also rotates the recent-banter cache.
async function pickAnyBanter(config: UserConfig, url: string): Promise<BanterChoice> {
  if (config.aiBanterEnabled && config.claudeApiKey.length > 0) {
    const session = await getSessionState();
    const ctx: BanterContext = {
      url,
      commitmentOfTheDay: session.commitmentOfTheDay,
      commitmentOfTheHour: config.commitmentOfTheHour,
      dismissalCountToday: countDismissalsToday(session),
      timeOfDay: deriveTimeOfDay(),
      recentlyDismissedSites: session.recentlyDismissedSites,
      recentBanters: recentAiBanters,
    };
    const result = await generateBanter(ctx, {
      apiKey: config.claudeApiKey,
      model: config.claudeModel,
    });
    if (result.ok) {
      pushRecentAiBanter(result.message);
      // AI banters share id -1: they're not pool-indexable. The id is
      // round-tripped on dismissal for logging only, so a sentinel
      // works.
      return { message: result.message, banterId: -1, source: "ai" };
    }
    logAiFallback(result);
  }
  const pick = pickBanter();
  return { message: pick.message, banterId: pick.id, source: "static" };
}

function pushRecentAiBanter(message: string): void {
  recentAiBanters.push(message);
  while (recentAiBanters.length > RECENT_BANTER_CACHE) {
    recentAiBanters.shift();
  }
}

function logAiFallback(result: GenerateBanterResult & { ok: false }): void {
  // Reason is enum-safe so no key value can leak through here.
  console.warn(`Nihlus AI banter failed (${result.reason}); using static pool.`);
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
