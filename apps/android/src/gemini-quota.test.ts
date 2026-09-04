import assert from "node:assert/strict";
import test from "node:test";
import { currentQuotaEntry, quotaSummary, recordGeminiUsage } from "./gemini-quota.ts";

test("records daily usage and rolling-minute headroom", () => {
  const at = Date.parse("2026-09-03T12:00:00Z");
  const entry = recordGeminiUsage(undefined, { input: 1200, output: 300, thinking: 100, total: 1600 }, at);
  const summary = quotaSummary("gemini-3.7-flash", entry, at + 1_000);
  assert.equal(summary.dayRemaining, 19);
  assert.equal(summary.minuteRemaining, 4);
  assert.equal(summary.minuteInputRemaining, 248_800);
  assert.equal(summary.usage.total, 1600);
});

test("expires minute activity and resets counters on a new Pacific day", () => {
  const at = Date.parse("2026-09-03T12:00:00Z");
  const entry = recordGeminiUsage(undefined, { input: 100, output: 20, thinking: 0, total: 120 }, at);
  assert.equal(quotaSummary("gemini-3.5-flash-lite", entry, at + 60_001).minuteRemaining, 15);
  const reset = currentQuotaEntry(entry, Date.parse("2026-09-04T12:00:00Z"));
  assert.equal(reset.requests, 0);
  assert.equal(reset.total, 0);
});
