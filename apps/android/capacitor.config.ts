import type { CapacitorConfig } from "@capacitor/cli";
import { QC_NATIVE_THEME } from "@ndsp-qc/theme";

const config: CapacitorConfig = {
  appId: "com.qccontrol.mobile",
  appName: "QC Control",
  webDir: "dist",
  backgroundColor: QC_NATIVE_THEME.android.background,
  android: {
    allowMixedContent: false,
    backgroundColor: QC_NATIVE_THEME.android.background
  },
  plugins: {
    StatusBar: {
      style: "DARK",
      backgroundColor: QC_NATIVE_THEME.android.background
    }
  }
};

export default config;
