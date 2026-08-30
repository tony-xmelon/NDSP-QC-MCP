import assert from "node:assert/strict";
import test from "node:test";
import { speechRecognitionErrorMessage } from "../apps/windows/src/voice.ts";

test("maps speech service failures to actionable messages", () => {
  assert.match(speechRecognitionErrorMessage("not-allowed"), /permission was denied/i);
  assert.match(speechRecognitionErrorMessage("network"), /could not be reached/i);
  assert.match(speechRecognitionErrorMessage("unexpected"), /unexpected/i);
});
