import {
  isShowBanterMessage,
  type BanterDismissedMessage,
} from "../lib/messages.ts";

// Page-injected banter overlay. Lives in a closed shadow DOM so the
// host page's CSS can't restyle it and the host's JS can't query it.
// Single instance per page: a new ShowBanterMessage replaces the
// existing overlay rather than stacking.

console.log("Nihlus content script active on:", window.location.href);

interface OverlayHandle {
  host: HTMLDivElement;
  banterId: number;
}

let current: OverlayHandle | null = null;

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isShowBanterMessage(message)) return;
  // Defensive: a duplicate show for the same banterId is a no-op so a
  // background re-send (e.g. SPA route flip) doesn't visually re-mount.
  if (current !== null && current.banterId === message.banterId) return;
  showOverlay(message.message, message.banterId);
});

function showOverlay(text: string, banterId: number): void {
  removeCurrent();

  const host = document.createElement("div");
  // Reset every property the host page might have set inheritably, so
  // the overlay starts from a known baseline. The shadow root below
  // isolates the rest of the styling.
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.right = "16px";
  host.style.bottom = "16px";
  host.style.width = "280px";
  // Maximum 32-bit signed int; outranks every reasonable host overlay
  // (including chat widgets that camp at 2_000_000_000).
  host.style.zIndex = "2147483647";
  host.setAttribute("data-nihlus-overlay", "true");

  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = OVERLAY_CSS;
  shadow.appendChild(style);

  const card = document.createElement("div");
  card.className = "nihlus-banter";

  const header = document.createElement("div");
  header.className = "nihlus-banter__header";
  header.textContent = "Nihlus";
  card.appendChild(header);

  const msg = document.createElement("p");
  msg.className = "nihlus-banter__message";
  msg.textContent = text;
  card.appendChild(msg);

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "nihlus-banter__dismiss";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => {
    void notifyDismiss(banterId);
    removeCurrent();
  });
  card.appendChild(dismiss);

  shadow.appendChild(card);

  // Append to documentElement instead of body: body may be absent on
  // some pages mid-load, or restyled with overflow:hidden + transforms
  // that re-anchor fixed-position children. documentElement is more
  // forgiving.
  (document.body ?? document.documentElement).appendChild(host);

  current = { host, banterId };
}

function removeCurrent(): void {
  if (current === null) return;
  current.host.remove();
  current = null;
}

async function notifyDismiss(banterId: number): Promise<void> {
  const message: BanterDismissedMessage = {
    type: "nihlus/banter-dismissed",
    banterId,
  };
  try {
    await chrome.runtime.sendMessage(message);
  } catch (err) {
    // Worker may be in the middle of being unloaded; the cooldown is
    // best-effort. Logged at debug so we don't pollute the console.
    console.debug("Nihlus dismiss notify failed:", err);
  }
}

const OVERLAY_CSS = `
:host {
  all: initial;
}
.nihlus-banter {
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #e6e6e6;
  background: #0e1116;
  border: 1px solid #2a313c;
  border-radius: 8px;
  padding: 12px 14px 14px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  box-sizing: border-box;
  width: 100%;
}
.nihlus-banter__header {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #6ea8ff;
  margin-bottom: 6px;
}
.nihlus-banter__message {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.4;
  color: #f3f4f6;
}
.nihlus-banter__dismiss {
  appearance: none;
  background: transparent;
  color: #9ca3af;
  border: 1px solid #2a313c;
  border-radius: 4px;
  padding: 5px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}
.nihlus-banter__dismiss:hover {
  color: #f3f4f6;
  border-color: #4a5263;
}
.nihlus-banter__dismiss:focus-visible {
  outline: 2px solid #6ea8ff;
  outline-offset: 2px;
}
`;
