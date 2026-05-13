import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  defaultSessionState,
  getSessionState,
  type SessionState,
} from "../lib/session-state.ts";
import "./interrupt.css";

// Full-tab interrupt page rendered when a level-3/4 countdown elapses
// on a distracting tab. The worker navigates the tab here via
// chrome.tabs.update; this page reads the user's commitmentOfTheDay so
// the message reads back what they said they were doing.

function Interrupt(): React.ReactElement {
  const [session, setSession] = useState<SessionState>(defaultSessionState);
  const [loaded, setLoaded] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const s = await getSessionState();
      if (cancelled) return;
      setSession(s);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleBackToWork = (): void => {
    // chrome.tabs.getCurrent returns the tab this page is running in.
    // Removing it closes the tab; the browser focuses the previous
    // active tab automatically, which is exactly the "leave the user
    // on whatever they were on before" behavior the spec asks for.
    void chrome.tabs.getCurrent().then((tab) => {
      if (tab?.id === undefined) return;
      void chrome.tabs.remove(tab.id);
    });
  };

  const commitmentText = session.commitmentOfTheDay.trim();
  const hasCommitment = commitmentText.length > 0;

  return (
    <div className="interrupt">
      <div className="interrupt__card">
        <div className="interrupt__header">NIHLUS</div>
        <h1 className="interrupt__title">Tab closed. The plan isn't done.</h1>
        {loaded ? (
          <div className="interrupt__commitment">
            {hasCommitment ? (
              <>
                <div className="interrupt__commitment-label">Today's commitment</div>
                <div className="interrupt__commitment-text">{commitmentText}</div>
              </>
            ) : (
              <div className="interrupt__commitment-empty">no commitment set</div>
            )}
          </div>
        ) : null}
        <p className="interrupt__subtext">Come back to it after.</p>
        <button
          type="button"
          className="interrupt__button"
          onClick={handleBackToWork}
          disabled={!loaded}
        >
          Back to work
        </button>
      </div>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("Interrupt root element not found");
}
createRoot(rootEl).render(
  <StrictMode>
    <Interrupt />
  </StrictMode>,
);
