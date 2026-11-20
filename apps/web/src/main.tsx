import "@fontsource-variable/atkinson-hyperlegible-next";
import "@fontsource-variable/atkinson-hyperlegible-mono";
import "./styles/tokens.css";
import "./styles/app.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.tsx";
import { servicesAt, ServicesProvider } from "./state/services.ts";

const root = document.getElementById("root");
if (!root) throw new Error("The page has no #root to draw in.");

// The page talks to the Vibe that served it, and to nothing else.
createRoot(root).render(
  <StrictMode>
    <ServicesProvider value={servicesAt(window.location.origin)}>
      <App />
    </ServicesProvider>
  </StrictMode>,
);
