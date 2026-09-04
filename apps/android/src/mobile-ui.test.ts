import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the mobile control deck exposes all eleven QC footswitches on two rows", () => {
  const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const domain = JSON.parse(readFileSync(new URL("../../../contracts/qc-domain.v1.json", import.meta.url), "utf8"));

  assert.equal(domain.limits.scenes, 8);
  assert.match(appSource, /Array\.from\(\{ length: QC_SCENE_COUNT \}/, "A through H must come from the shared scene definition");
  assert.match(appSource, /className="navigation-controls"/);
  assert.doesNotMatch(appSource, />SCENE</);
  assert.match(appSource, /footswitchLeds\(snapshot\)/);
  assert.match(appSource, /beginFootswitch/);
  assert.match(appSource, /className=\{`tempo-control/);
  assert.match(styles, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(styles, /grid-template-rows: repeat\(2, minmax\(48px, 1fr\)\)/);
  assert.match(styles, /\.quick-controls \.navigation-controls \{ grid-column: 5; grid-row: 1;/);
  assert.match(styles, /\.quick-controls \.tempo-control \{ grid-column: 5; grid-row: 2; \}/);
  assert.match(styles, /var\(--switch-color\)/);
});

test("tapping a live Grid block opens the shared parameter editor and commits over USB", () => {
  const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const nativeSource = readFileSync(new URL("./native-services.ts", import.meta.url), "utf8");
  const coreSource = readFileSync(new URL("../../../packages/typescript/qc-core/src/state.ts", import.meta.url), "utf8");
  const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

  assert.match(appSource, /qcTransport\.blockDetails\(block\.row, block\.column, snapshotRef\.current\)/);
  assert.match(appSource, /parameterEditor=\{blockDetails \?/);
  assert.match(appSource, /qcTransport\.setParameter\(blockDetails\.row, blockDetails\.column, parameter\.index, value, snapshotRef\.current\)/);
  assert.match(nativeSource, /createAndroidQcTransport[\s\S]*createQcGatewayTransport/);
  assert.doesNotMatch(nativeSource, /QcUsbNative\.(?:blockDetails|setParameter)/);
  assert.match(appSource, /blockSelectionIntent\(selectedBlockId, blockId\)/);
  assert.match(appSource, /reconcileFrame\(states\)/);
  assert.match(coreSource, /dirty: state\.catalogRefresh \? snapshot\.dirty : false/);
  assert.match(styles, /\.preset-title\.is-dirty \{ font-style: italic; font-weight: 500; \}/);
});

test("Android exposes an allowlisted Gemini selector and a compact persisted quota estimate", () => {
  const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const servicesSource = readFileSync(new URL("./native-services.ts", import.meta.url), "utf8");
  const javaSource = readFileSync(new URL("../android/app/src/main/java/com/qccontrol/mobile/GeminiPlugin.java", import.meta.url), "utf8");
  const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const quotaSource = readFileSync(new URL("./gemini-quota.ts", import.meta.url), "utf8");

  for (const model of ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]) {
    assert.match(appSource, new RegExp(model));
    assert.match(javaSource, new RegExp(model));
  }
  assert.match(servicesSource, /inputTokens: number;[\s\S]*thinkingTokens: number;[\s\S]*totalTokens: number/);
  assert.match(javaSource, /response\.getUsageMetadata\(\)/);
  assert.match(javaSource, /ALLOWED_MODELS\.contains\(modelName\)/);
  assert.match(appSource, /aria-label="Gemini model"/);
  assert.match(appSource, /androidQuotaStorageKey/);
  assert.match(appSource, /dayRemaining.*requestsPerDay/);
  assert.match(appSource, /minuteRemaining.*requestsPerMinute/);
  assert.match(appSource, /Device estimate for the current Pacific quota day/);
  assert.match(quotaSource, /America\/Los_Angeles/);
  assert.match(quotaSource, /"gemini-3\.7-flash": \{ requestsPerMinute: 5, requestsPerDay: 20/);
  assert.match(quotaSource, /"gemini-3\.5-flash-lite": \{ requestsPerMinute: 15, requestsPerDay: 500/);
  assert.match(styles, /\.chat-model-bar/);
});

test("assistant and relay access defaults to full control and enforces four tiers", () => {
  const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const servicesSource = readFileSync(new URL("./native-services.ts", import.meta.url), "utf8");
  const relaySource = readFileSync(new URL("../android/app/src/main/java/com/qccontrol/mobile/QcRelayService.java", import.meta.url), "utf8");
  const policySource = readFileSync(new URL("../android/app/src/main/java/com/qccontrol/mobile/RelayAccessPolicy.java", import.meta.url), "utf8");

  assert.match(appSource, /value === "read-only" \|\| value === "performance" \|\| value === "modify" \? value : "full"/);
  assert.match(appSource, /aria-label="Assistant and remote device access"/);
  assert.match(appSource, /assistantAccessPermitsTool\(controlAccessMode/);
  assert.match(appSource, /<option value="performance">Performance<\/option>/);
  assert.match(appSource, /<option value="modify">Modify<\/option>/);
  assert.match(servicesSource, /setAccessMode\(options: \{ mode: ControlAccessMode \}\)/);
  assert.match(policySource, /getString\(MODE, FULL\)/);
  assert.match(policySource, /GeneratedRemoteActions\.isPerformance/);
  assert.match(policySource, /GeneratedRemoteActions\.isModify/);
  assert.match(relaySource, /RelayAccessPolicy\.permits/);
  assert.match(relaySource, /"ACCESS_MODE_RESTRICTED"/);
});
