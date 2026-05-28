import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../index.css";
import { AppErrorBoundary } from "../../components/AppErrorBoundary";
import DesktopApp from "./DesktopApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <DesktopApp />
    </AppErrorBoundary>
  </StrictMode>,
);
