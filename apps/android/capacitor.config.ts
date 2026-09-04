import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.qccontrol.mobile",
  appName: "QC Control",
  webDir: "dist",
  backgroundColor: "#08090b",
  android: {
    allowMixedContent: false,
    backgroundColor: "#08090b"
  },
  plugins: {
    StatusBar: {
      style: "DARK",
      backgroundColor: "#08090b"
    }
  }
};

export default config;
