// Wire protocol between the MV3 service worker and content scripts.
// Each direction has its own message type and runtime guard. Guards
// validate shape so a stray message from a future surface (options
// page, popup → content) can't crash the consumer with an unchecked
// access.

export interface ShowBanterMessage {
  type: "nihlus/show-banter";
  message: string;
  // Index into the banter pool. The content script echoes this back in
  // the dismissal message so the worker can correlate (e.g. for future
  // "user dismissed banter N times in a row" heuristics).
  banterId: number;
}

export interface BanterDismissedMessage {
  type: "nihlus/banter-dismissed";
  banterId: number;
}

export type FromBackgroundMessage = ShowBanterMessage;
export type FromContentMessage = BanterDismissedMessage;

export function isShowBanterMessage(m: unknown): m is ShowBanterMessage {
  if (typeof m !== "object" || m === null) return false;
  const o = m as Record<string, unknown>;
  return (
    o["type"] === "nihlus/show-banter" &&
    typeof o["message"] === "string" &&
    typeof o["banterId"] === "number"
  );
}

export function isBanterDismissedMessage(m: unknown): m is BanterDismissedMessage {
  if (typeof m !== "object" || m === null) return false;
  const o = m as Record<string, unknown>;
  return o["type"] === "nihlus/banter-dismissed" && typeof o["banterId"] === "number";
}
