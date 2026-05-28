import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../index.css";
import { AppErrorBoundary } from "../../components/AppErrorBoundary";
import WebApp from "./WebApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <WebApp />
    </AppErrorBoundary>
  </StrictMode>,
);
