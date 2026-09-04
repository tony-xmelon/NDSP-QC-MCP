import type { CapacitorConfig } from "@capacitor/cli";
import { QC_BRAND, QC_NATIVE_THEME } from "@ndsp-qc/theme";

const config: CapacitorConfig = {
  appId: QC_BRAND.androidPackage,
  appName: QC_BRAND.appName,
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
