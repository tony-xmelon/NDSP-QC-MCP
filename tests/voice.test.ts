import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { speechRecognitionAvailable, speechRecognitionErrorMessage } from "../apps/windows/src/voice.ts";

test("detects whether the host runtime exposes speech recognition", () => {
  const previousWindow = globalThis.window;
  Object.assign(globalThis, { window: {} });
  assert.equal(speechRecognitionAvailable(), false);
  Object.assign(globalThis.window, { webkitSpeechRecognition: class {} });
  assert.equal(speechRecognitionAvailable(), true);
  Object.assign(globalThis, { window: previousWindow });
});

test("maps speech service failures to actionable messages", () => {
  assert.match(speechRecognitionErrorMessage("not-allowed"), /permission was denied/i);
  assert.match(speechRecognitionErrorMessage("network"), /could not be reached/i);
  assert.match(speechRecognitionErrorMessage("unexpected"), /unexpected/i);
});

test("Windows and Android use the same microphone glyph", () => {
  const iconSource = readFileSync(new URL("../packages/typescript/qc-ui/src/microphone-icon.tsx", import.meta.url), "utf8");
  const windowsSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8") + readFileSync(new URL("../apps/windows/src/chat-dock.tsx", import.meta.url), "utf8");
  const androidSource = readFileSync(new URL("../apps/android/src/App.tsx", import.meta.url), "utf8");
  assert.match(iconSource, /<rect x="8\.25" y="2\.5" width="7\.5" height="13" rx="3\.75"/);
  assert.match(iconSource, /<path d="M5\.5 11\.25v\.75a6\.5 6\.5 0 0 0 13 0v-\.75"/);
  assert.match(windowsSource, /<MicrophoneIcon \/>/);
  assert.match(androidSource, /<MicrophoneIcon \/>/);
  assert.doesNotMatch(windowsSource, /\{listening \? "■" : "●"\}/);
  assert.doesNotMatch(androidSource, /aria-label="Speak a command">●<\/button>/);
});
