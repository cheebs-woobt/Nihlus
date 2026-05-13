import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CLAUDE_MODEL_OPTIONS,
  defaultUserConfig,
  loadConfig,
  saveConfig,
  STAR_LEVEL_CEILING,
  subscribeConfig,
  type ClaudeModelId,
  type UserConfig,
} from "../lib/config.ts";
import {
  adjustStarLevel,
  renderStarStrip,
  setStarLevel,
  visibleStars,
} from "../lib/star.ts";
import {
  countByReasonToday,
  countDismissalsToday,
  defaultSessionState,
  DISMISS_REASONS,
  getSessionState,
  markCommitmentPromptSkippedToday,
  setCommitmentOfTheDay,
  subscribeSessionState,
  topDismissedSitesThisWeek,
  type DismissReason,
  type SessionState,
} from "../lib/session-state.ts";
import "./popup.css";

type SaveState = "idle" | "saving" | "saved";

function Popup(): React.ReactElement {
  const [config, setConfig] = useState<UserConfig>(defaultUserConfig);
  const [session, setSession] = useState<SessionState>(defaultSessionState);
  const [allowedText, setAllowedText] = useState<string>("");
  const [blockedText, setBlockedText] = useState<string>("");
  // Local-only buffer for the day commitment input so a half-typed
  // value doesn't write to storage on every keystroke. Persisted by
  // the inline Set button or by the main Save button.
  const [dayCommitmentDraft, setDayCommitmentDraft] = useState<string>("");
  const [loaded, setLoaded] = useState<boolean>(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [initialConfig, initialSession] = await Promise.all([
        loadConfig(),
        getSessionState(),
      ]);
      if (cancelled) return;
      setConfig(initialConfig);
      setSession(initialSession);
      setAllowedText(initialConfig.allowedSites.join("\n"));
      setBlockedText(initialConfig.blockedSites.join("\n"));
      setDayCommitmentDraft(initialSession.commitmentOfTheDay);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsubscribeConfig = subscribeConfig((next) => {
      setConfig(next);
      setAllowedText(next.allowedSites.join("\n"));
      setBlockedText(next.blockedSites.join("\n"));
    });
    const unsubscribeSession = subscribeSessionState((next) => {
      setSession(next);
      // Pull the new commitment into the draft buffer only if the user
      // hasn't started typing a different value. We detect this by
      // checking equality against the previous saved value; if the
      // draft was equal to the saved string, the user wasn't editing.
      setDayCommitmentDraft((cur) =>
        cur === session.commitmentOfTheDay ? next.commitmentOfTheDay : cur,
      );
    });
    return () => {
      unsubscribeConfig();
      unsubscribeSession();
    };
  }, [session.commitmentOfTheDay]);

  const markDirty = (): void => {
    if (saveState === "saved") setSaveState("idle");
  };

  const handleToggleFocus = (): void => {
    setConfig((prev) => ({ ...prev, focusModeActive: !prev.focusModeActive }));
    markDirty();
  };

  const handleToggleOverlaySound = (): void => {
    setConfig((prev) => ({ ...prev, overlaySoundEnabled: !prev.overlaySoundEnabled }));
    markDirty();
  };

  const handleResetStars = async (): Promise<void> => {
    const updated = await setStarLevel(config.starMinimum, "manual-reset");
    setConfig(updated);
  };

  const handleCommitmentComplete = async (): Promise<void> => {
    const updated = await adjustStarLevel(-2, "commitment-complete");
    setConfig(updated);
  };

  const handleStarMinChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const v = Math.max(0, Math.min(3, parseInt(e.target.value, 10)));
    setConfig((prev) => ({ ...prev, starMinimum: v }));
    markDirty();
  };

  const handleStarMaxChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const v = Math.max(1, Math.min(STAR_LEVEL_CEILING, parseInt(e.target.value, 10)));
    setConfig((prev) => ({ ...prev, starMaximum: v }));
    markDirty();
  };

  const handleStartingLevelChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const v = Math.max(0, Math.min(3, parseInt(e.target.value, 10)));
    const updated = await setStarLevel(v, "manual-set");
    setConfig(updated);
  };

  const handleCommitmentHourChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setConfig((prev) => ({ ...prev, commitmentOfTheHour: e.target.value }));
    markDirty();
  };

  const handleDayCommitmentChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setDayCommitmentDraft(e.target.value);
  };

  const handleSetDayCommitment = async (): Promise<void> => {
    const next = await setCommitmentOfTheDay(dayCommitmentDraft.trim());
    setSession(next);
  };

  const handleSkipPrompt = async (): Promise<void> => {
    const next = await markCommitmentPromptSkippedToday();
    setSession(next);
  };

  const handleAllowedChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setAllowedText(e.target.value);
    markDirty();
  };

  const handleBlockedChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setBlockedText(e.target.value);
    markDirty();
  };

  const handleAiToggle = (): void => {
    setConfig((prev) => ({ ...prev, aiBanterEnabled: !prev.aiBanterEnabled }));
    markDirty();
  };

  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const v = e.target.value as ClaudeModelId;
    setConfig((prev) => ({ ...prev, claudeModel: v }));
    markDirty();
  };

  const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setConfig((prev) => ({ ...prev, claudeApiKey: e.target.value }));
    markDirty();
  };

  const handleSave = async (): Promise<void> => {
    setSaveState("saving");
    const next: UserConfig = {
      ...config,
      allowedSites: parseSiteList(allowedText),
      blockedSites: parseSiteList(blockedText),
    };
    try {
      await saveConfig(next);
      setConfig(next);
      setAllowedText(next.allowedSites.join("\n"));
      setBlockedText(next.blockedSites.join("\n"));
      setSaveState("saved");
      window.setTimeout(() => {
        setSaveState((cur) => (cur === "saved" ? "idle" : cur));
      }, 1200);
    } catch (err) {
      console.warn("Nihlus popup save failed:", err);
      setSaveState("idle");
    }
  };

  // Banner appears when focus mode is on AND the user has not yet set
  // OR explicitly skipped today's commitment. After either action it
  // stays hidden for the rest of the day per session-state flags.
  const showCommitmentBanner =
    loaded &&
    config.focusModeActive &&
    session.commitmentOfTheDay.trim().length === 0 &&
    session.commitmentPromptSkippedDate !== todayIsoDateString();

  return (
    <div className="nihlus-popup">
      <header className="nihlus-popup__header">
        <h1 className="nihlus-popup__title">Nihlus v0.0.1</h1>
        <p className="nihlus-popup__subtitle">
          {loaded ? "Configure focus" : "Loading..."}
        </p>
      </header>

      <StarPanel
        config={config}
        loaded={loaded}
        onReset={() => {
          void handleResetStars();
        }}
        onCommitmentComplete={() => {
          void handleCommitmentComplete();
        }}
      />

      <section className="nihlus-popup__row">
        <label className="nihlus-popup__toggle">
          <input
            type="checkbox"
            checked={config.focusModeActive}
            onChange={handleToggleFocus}
            disabled={!loaded}
          />
          <span>Focus mode</span>
        </label>
      </section>

      <section className="nihlus-popup__row">
        <label className="nihlus-popup__toggle">
          <input
            type="checkbox"
            checked={config.overlaySoundEnabled}
            onChange={handleToggleOverlaySound}
            disabled={!loaded}
          />
          <span>Overlay sound</span>
        </label>
      </section>

      {showCommitmentBanner ? (
        <section className="nihlus-popup__banner">
          <div className="nihlus-popup__banner-row">
            <span className="nihlus-popup__banner-text">
              What are you working on today?
            </span>
            <button
              type="button"
              className="nihlus-popup__banner-close"
              aria-label="Dismiss this prompt for today"
              onClick={() => {
                void handleSkipPrompt();
              }}
            >
              x
            </button>
          </div>
        </section>
      ) : null}

      <section className="nihlus-popup__field">
        <label htmlFor="day-commit" className="nihlus-popup__label">
          Today's commitment{" "}
          <span className="nihlus-popup__hint">(broad frame for the day)</span>
        </label>
        <div className="nihlus-popup__row-inline">
          <input
            id="day-commit"
            type="text"
            value={dayCommitmentDraft}
            onChange={handleDayCommitmentChange}
            placeholder="e.g. ship the migration plan"
            disabled={!loaded}
          />
          <button
            type="button"
            className="nihlus-popup__inline-btn"
            onClick={() => {
              void handleSetDayCommitment();
            }}
            disabled={
              !loaded || dayCommitmentDraft.trim() === session.commitmentOfTheDay.trim()
            }
          >
            Set
          </button>
        </div>
      </section>

      <PatternSurface session={session} loaded={loaded} />

      <section className="nihlus-popup__field">
        <label htmlFor="commitment" className="nihlus-popup__label">
          Commitment of the hour <span className="nihlus-popup__hint">(optional)</span>
        </label>
        <input
          id="commitment"
          type="text"
          value={config.commitmentOfTheHour}
          onChange={handleCommitmentHourChange}
          placeholder="e.g. finish section 3 of the doc"
          disabled={!loaded}
        />
      </section>

      <section className="nihlus-popup__field">
        <label htmlFor="allowed" className="nihlus-popup__label">
          Allowed sites <span className="nihlus-popup__hint">(one per line)</span>
        </label>
        <textarea
          id="allowed"
          rows={4}
          value={allowedText}
          onChange={handleAllowedChange}
          placeholder={"github.com\ndocs.google.com"}
          disabled={!loaded}
        />
      </section>

      <section className="nihlus-popup__field">
        <label htmlFor="blocked" className="nihlus-popup__label">
          Blocked sites <span className="nihlus-popup__hint">(one per line)</span>
        </label>
        <textarea
          id="blocked"
          rows={4}
          value={blockedText}
          onChange={handleBlockedChange}
          placeholder={"youtube.com\nreddit.com"}
          disabled={!loaded}
        />
      </section>

      <hr className="nihlus-popup__divider" />

      <section className="nihlus-popup__row">
        <label className="nihlus-popup__toggle">
          <input
            type="checkbox"
            checked={config.aiBanterEnabled}
            onChange={handleAiToggle}
            disabled={!loaded}
          />
          <span>AI banter (Claude)</span>
        </label>
      </section>

      <section className="nihlus-popup__field">
        <label htmlFor="model" className="nihlus-popup__label">
          Model
        </label>
        <select
          id="model"
          value={config.claudeModel}
          onChange={handleModelChange}
          disabled={!loaded}
        >
          {CLAUDE_MODEL_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </section>

      <section className="nihlus-popup__field">
        <label htmlFor="apikey" className="nihlus-popup__label">
          Anthropic API key{" "}
          <span className="nihlus-popup__hint">
            {config.aiBanterEnabled && config.claudeApiKey.length === 0
              ? "(required for AI banter)"
              : "(stored locally only)"}
          </span>
        </label>
        <input
          id="apikey"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={config.claudeApiKey}
          onChange={handleApiKeyChange}
          placeholder="sk-ant-..."
          disabled={!loaded}
        />
      </section>

      <hr className="nihlus-popup__divider" />

      <details className="nihlus-popup__advanced">
        <summary>Advanced star settings</summary>
        <section className="nihlus-popup__field">
          <label htmlFor="starting-level" className="nihlus-popup__label">
            Starting level{" "}
            <span className="nihlus-popup__hint">
              (force current: {visibleStars(config.starLevel)} of {STAR_LEVEL_CEILING})
            </span>
          </label>
          <input
            id="starting-level"
            type="range"
            min={0}
            max={3}
            step={1}
            value={visibleStars(config.starLevel)}
            onChange={(e) => {
              void handleStartingLevelChange(e);
            }}
            disabled={!loaded}
          />
        </section>
        <section className="nihlus-popup__field">
          <label htmlFor="star-min" className="nihlus-popup__label">
            Minimum level{" "}
            <span className="nihlus-popup__hint">
              (floor: {config.starMinimum})
            </span>
          </label>
          <input
            id="star-min"
            type="range"
            min={0}
            max={3}
            step={1}
            value={config.starMinimum}
            onChange={handleStarMinChange}
            disabled={!loaded}
          />
        </section>
        <section className="nihlus-popup__field">
          <label htmlFor="star-max" className="nihlus-popup__label">
            Maximum level{" "}
            <span className="nihlus-popup__hint">
              (ceiling: {config.starMaximum})
            </span>
          </label>
          <input
            id="star-max"
            type="range"
            min={1}
            max={STAR_LEVEL_CEILING}
            step={1}
            value={config.starMaximum}
            onChange={handleStarMaxChange}
            disabled={!loaded}
          />
          {config.starMaximum >= 5 ? (
            <p className="nihlus-popup__warning">
              Level 5+ will close tabs and block sites temporarily.
            </p>
          ) : null}
        </section>
      </details>

      <footer className="nihlus-popup__footer">
        <button
          type="button"
          className="nihlus-popup__save"
          onClick={() => {
            void handleSave();
          }}
          disabled={!loaded || saveState === "saving"}
        >
          {saveButtonLabel(saveState)}
        </button>
      </footer>
    </div>
  );
}

interface PatternSurfaceProps {
  session: SessionState;
  loaded: boolean;
}

// Read-only self-awareness panel. "Today" surfaces dismissal counts
// per reason (sorted desc, skipping zeros). "This week" surfaces the
// top 3 hostnames over the last 7 rolling days. No edits in Phase 5.
function PatternSurface({ session, loaded }: PatternSurfaceProps): React.ReactElement {
  if (!loaded) {
    return <section className="nihlus-popup__stats nihlus-popup__stats--placeholder" />;
  }

  const todayCount = countDismissalsToday(session);
  const todayByReason = countByReasonToday(session);
  const topSites = topDismissedSitesThisWeek(session, 3);

  const todayLine =
    todayCount === 0
      ? "no dismissals yet"
      : DISMISS_REASONS.map<{ reason: DismissReason; count: number }>((r) => ({
          reason: r,
          count: todayByReason[r],
        }))
          .filter((x) => x.count > 0)
          .sort((a, b) => b.count - a.count)
          .map((x) => `${x.reason} ${x.count}`)
          .join(", ");

  const weekLine =
    topSites.length === 0
      ? "no dismissals this week"
      : topSites.map((s) => `${s.hostname} (${s.count})`).join(", ");

  return (
    <section className="nihlus-popup__stats">
      <div className="nihlus-popup__stats-row">
        <span className="nihlus-popup__stats-label">Today</span>
        <span className="nihlus-popup__stats-value">{todayLine}</span>
      </div>
      <div className="nihlus-popup__stats-row">
        <span className="nihlus-popup__stats-label">This week</span>
        <span className="nihlus-popup__stats-value">{weekLine}</span>
      </div>
    </section>
  );
}

function saveButtonLabel(state: SaveState): string {
  if (state === "saving") return "Saving...";
  if (state === "saved") return "Saved";
  return "Save";
}

interface StarPanelProps {
  config: UserConfig;
  loaded: boolean;
  onReset: () => void;
  onCommitmentComplete: () => void;
}

// Star wanted-level summary. Shows filled stars up to floor(starLevel)
// across STAR_LEVEL_CEILING slots, the integer label, a one-line
// explanation, and two actions: Reset (drop to floor) and Mark
// commitment done (-2). Both actions write through the worker-side
// adjustStarLevel so the same event log captures them.
function StarPanel({
  config,
  loaded,
  onReset,
  onCommitmentComplete,
}: StarPanelProps): React.ReactElement {
  const slots = renderStarStrip(config.starLevel);
  const visible = visibleStars(config.starLevel);
  return (
    <section className="nihlus-popup__star-panel">
      <div className="nihlus-popup__star-row">
        <div className="nihlus-popup__star-strip" aria-label={`Star level ${visible} of ${STAR_LEVEL_CEILING}`}>
          {slots.map((filled, i) => (
            <span
              key={i}
              className={
                filled
                  ? "nihlus-popup__star nihlus-popup__star--filled"
                  : "nihlus-popup__star nihlus-popup__star--empty"
              }
            >
              {filled ? "★" : "☆"}
            </span>
          ))}
        </div>
        <div className="nihlus-popup__star-label">
          Star level: {visible} of {STAR_LEVEL_CEILING}
        </div>
      </div>
      <p className="nihlus-popup__star-hint">
        Adjusts to your behavior. Higher = more firm.
      </p>
      <div className="nihlus-popup__star-actions">
        <button
          type="button"
          className="nihlus-popup__star-btn"
          onClick={onReset}
          disabled={!loaded}
        >
          Reset
        </button>
        <button
          type="button"
          className="nihlus-popup__star-btn"
          onClick={onCommitmentComplete}
          disabled={!loaded}
          title="Subtracts 2 from your star level"
        >
          Mark commitment done
        </button>
      </div>
    </section>
  );
}

function parseSiteList(blob: string): string[] {
  const out: string[] = [];
  for (const line of blob.split(/\r?\n/)) {
    const cleaned = line.trim().toLowerCase();
    if (cleaned.length === 0) continue;
    if (out.includes(cleaned)) continue;
    out.push(cleaned);
  }
  return out;
}

function todayIsoDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("Popup root element not found");
}

createRoot(rootEl).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
