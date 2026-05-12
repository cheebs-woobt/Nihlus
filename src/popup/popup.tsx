import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./popup.css";

function Popup(): React.ReactElement {
  return (
    <div className="nihlus-popup">
      <h1 className="nihlus-popup__title">Nihlus v0.0.1</h1>
      <p className="nihlus-popup__subtitle">Status: scaffold check</p>
    </div>
  );
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
