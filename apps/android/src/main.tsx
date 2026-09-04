import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StatusBar, Style } from "@capacitor/status-bar";
import { Capacitor } from "@capacitor/core";
import { App } from "./App";
import { QC_COLORS } from "@ndsp-qc/theme";
import "@ndsp-qc/theme/theme.css";
import "./styles.css";

if (Capacitor.isNativePlatform()) {
  void StatusBar.setStyle({ style: Style.Dark });
  void StatusBar.setBackgroundColor({ color: QC_COLORS.app.canvas });
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
