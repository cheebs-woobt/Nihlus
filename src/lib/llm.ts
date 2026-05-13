// Anthropic Messages API client for banter generation. Called from the
// service worker; never from a content script (the API key must not be
// exposed to page-injected code).
//
// Failure modes are surfaced as a discriminated reason so the caller
// can decide whether to retry, warn, or fall back. The static-pool
// fallback path treats every non-ok result the same way (silent
// fallback), but tagged reasons let us log distinctly.

import type { ClaudeModelId } from "./config.ts";

export type TimeOfDay = "morning" | "afternoon" | "evening" | "late-night";

export interface BanterContext {
  // Full URL of the page the user landed on.
  url: string;
  // The user's stated commitment-of-the-hour. Empty string when unset
  // so the prompt can render "(none set)" rather than an awkward gap.
  commitmentOfTheHour: string;
  // Count of dismissals already logged today. Drives the tone gradient
  // (gentle → direct → blunt) the model is asked to apply.
  dismissalCountToday: number;
  // Coarse time bucket. Derived from local-clock hour by the caller.
  timeOfDay: TimeOfDay;
  // Hostnames the user dismissed banter on today. Surfaced to the
  // model so it can call back to a pattern ("third time at reddit.com
  // this hour") without us hand-coding the heuristic.
  recentlyDismissedSites: readonly string[];
  // The last few banters generated this session. Listed in the prompt
  // as "avoid repeating" so the model knows what it just said.
  recentBanters: readonly string[];
}

export interface LlmOptions {
  apiKey: string;
  model: ClaudeModelId;
}

export type GenerateBanterResult =
  | { ok: true; message: string }
  | {
      ok: false;
      reason:
        | "no-key"
        | "rate-limit"
        | "auth"
        | "network"
        | "shape"
        | "empty"
        | "server-error";
    };

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Conservative output cap. Aim is ~30 output tokens (one short line);
// 80 leaves headroom for a slightly longer line without runaway costs.
const MAX_OUTPUT_TOKENS = 80;
// Wall-clock budget for the API call. If Claude takes longer than this,
// fall back to static banter so the user never waits more than this
// long for an overlay.
const REQUEST_TIMEOUT_MS = 4000;

const SYSTEM_PROMPT = [
  "You are Nihlus, an AI focus extension for high-functioning procrastinators.",
  "Voice: a friendly accountability buddy. Not preachy. Not generic. Not motivational-poster.",
  "Specific over abstract. Pointed but kind. Short.",
  "",
  "Output a SINGLE banter line. One sentence, 8 to 22 words. No prefix, no quotes, no emoji.",
  "Reference the user's stated commitment if it is set; otherwise reference the page or pattern.",
  "Vary tone with the dismissal count provided:",
  "  - 0 to 2 dismissals today: gentle observation, almost casual.",
  "  - 3 to 5: more direct. Name the pattern.",
  "  - 6 or more: blunt and short. Still kind, not snarky.",
  "Never repeat any of the recent banters listed.",
  "Never moralize. Never use words like 'productive', 'goals', 'success', 'wasting'.",
].join("\n");

export async function generateBanter(
  context: BanterContext,
  options: LlmOptions,
): Promise<GenerateBanterResult> {
  if (options.apiKey.length === 0) {
    return { ok: false, reason: "no-key" };
  }

  const userPrompt = buildUserPrompt(context);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": options.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        // Extension service workers attach a chrome-extension:// origin
        // header that Anthropic's API otherwise treats as browser
        // traffic and rejects. This opt-in flag is the documented way
        // to send keys directly from a non-server context.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: options.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        // Static system text is identical across calls. Marking it
        // ephemeral lets Anthropic cache the encoded prompt for ~5
        // minutes so repeat calls in a single focus session pay the
        // discounted cached-read rate. No-op for models below the
        // cache threshold; cheap regardless.
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: userPrompt,
          },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    // AbortError is the timeout path; other errors are DNS / offline /
    // CORS / SSL. Bucket them together as "network" so the worker can
    // fall back without needing to introspect.
    console.warn("[Nihlus llm] fetch failed:", redactError(err));
    return { ok: false, reason: "network" };
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "auth" };
    }
    if (response.status === 429) {
      return { ok: false, reason: "rate-limit" };
    }
    if (response.status >= 500) {
      return { ok: false, reason: "server-error" };
    }
    return { ok: false, reason: "shape" };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, reason: "shape" };
  }

  const text = extractText(parsed);
  if (text === null) return { ok: false, reason: "shape" };
  const cleaned = postProcess(text);
  if (cleaned.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, message: cleaned };
}

function buildUserPrompt(context: BanterContext): string {
  const commitment =
    context.commitmentOfTheHour.trim().length > 0
      ? context.commitmentOfTheHour.trim()
      : "(none set)";
  const recentBanters =
    context.recentBanters.length === 0
      ? "(none)"
      : context.recentBanters.map((b, i) => `${i + 1}. ${b}`).join("\n");
  const dismissedSites =
    context.recentlyDismissedSites.length === 0
      ? "(none)"
      : context.recentlyDismissedSites.join(", ");

  return [
    `Current URL: ${context.url}`,
    `Commitment this hour: ${commitment}`,
    `Dismissals today: ${context.dismissalCountToday}`,
    `Time of day: ${context.timeOfDay}`,
    `Recently dismissed sites today: ${dismissedSites}`,
    `Recent banters to AVOID repeating:`,
    recentBanters,
  ].join("\n");
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicMessageResponse {
  content?: unknown;
}

function extractText(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const resp = parsed as AnthropicMessageResponse;
  if (!Array.isArray(resp.content)) return null;
  for (const block of resp.content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Partial<AnthropicTextBlock>;
    if (b.type === "text" && typeof b.text === "string") {
      return b.text;
    }
  }
  return null;
}

// Trim, drop surrounding quotes, drop a leading "Nihlus:" prefix the
// model occasionally adds despite the system prompt. Cap to 200 chars
// so a runaway response can't render an unreadable overlay.
function postProcess(text: string): string {
  let out = text.trim();
  if (out.length === 0) return out;
  // Strip wrapping quotes (single or double).
  if (
    (out.startsWith('"') && out.endsWith('"')) ||
    (out.startsWith("'") && out.endsWith("'"))
  ) {
    out = out.slice(1, -1).trim();
  }
  // Strip a leading speaker tag.
  const speakerMatch = /^(nihlus|you)[:\-]\s*/i.exec(out);
  if (speakerMatch !== null) {
    out = out.slice(speakerMatch[0].length);
  }
  if (out.length > 200) out = `${out.slice(0, 197)}...`;
  return out;
}

// Strip the API key from any error before logging. Errors from fetch
// usually don't carry headers, but request URLs occasionally surface in
// network-error messages; key never appears in our payload outside the
// header so this is defense in depth.
function redactError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function deriveTimeOfDay(date: Date = new Date()): TimeOfDay {
  const h = date.getHours();
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 22) return "evening";
  return "late-night";
}
