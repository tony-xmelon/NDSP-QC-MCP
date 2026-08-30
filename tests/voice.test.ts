import assert from "node:assert/strict";
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
