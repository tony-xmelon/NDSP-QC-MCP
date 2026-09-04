import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { QC_BRAND, QC_NATIVE_THEME } from "@ndsp-qc/theme";
import "@ndsp-qc/theme/theme.css";
import "./styles.css";

document.querySelector('meta[name="theme-color"]')?.setAttribute("content", QC_NATIVE_THEME.browser.windowsThemeColor);
document.title = QC_BRAND.appName;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
