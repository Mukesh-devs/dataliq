import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { markPlatform, showScrollbarsWhileScrolling } from "./lib/scrollbars";
import "./styles/index.css";

// Before the first paint: the scroll bars' look depends on the platform.
markPlatform();
showScrollbarsWhileScrolling();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
