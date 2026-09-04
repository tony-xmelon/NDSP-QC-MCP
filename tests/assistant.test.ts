import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseAssistantIntent } from "../packages/typescript/qc-core/src/assistant.ts";
import { SHARED_QC_ASSISTANT_TOOLS } from "../packages/typescript/qc-core/src/assistant-tools.ts";
import { assistantAccessPermitsChatTool, booleanArgument, chatCredentialInputProps, chatCredentialStatus, chatErrorMessage, chatInstructions, chatProviderDefaults, isChatUnavailable, isLoopbackChatUrl, isReadOnlyChatTool, numericArgument, qcChatTools } from "../apps/windows/src/model-chat.ts";

test("parses immediate performance commands", () => {
  assert.deepEqual(parseAssistantIntent("Scene C"), { kind: "scene", index: 2 });
  assert.deepEqual(parseAssistantIntent("next preset"), { kind: "preset-step", delta: 1 });
  assert.deepEqual(parseAssistantIntent("bank down"), { kind: "bank", direction: -1 });
  assert.deepEqual(parseAssistantIntent("recall 6b"), { kind: "recall", location: "6B" });
  assert.deepEqual(parseAssistantIntent("open tuner"), { kind: "view", view: "tuner" });
  assert.deepEqual(parseAssistantIntent("set tempo to 121 BPM"), { kind: "tempo", bpm: 121 });
  assert.deepEqual(parseAssistantIntent("what preset is active?"), { kind: "inspect" });
});

test("does not mistake an ordinary question for a device inspection", () => {
  assert.deepEqual(parseAssistantIntent("What is a compressor?"), { kind: "help" });
  assert.deepEqual(parseAssistantIntent("Tell me how reverb works"), { kind: "help" });
});

test("parses offline edits while model tools provide direct application", () => {
  assert.deepEqual(parseAssistantIntent("bypass selected block"), { kind: "bypass", desired: "bypassed" });
  assert.deepEqual(parseAssistantIntent("set Noise Reduction to 51%"), {
    kind: "parameter",
    parameter: "noise reduction",
    value: "51%"
  });
});

test("publishes strict schemas for every allowed QC model tool", () => {
  assert.ok(qcChatTools.length >= SHARED_QC_ASSISTANT_TOOLS.length);
  assert.equal(new Set(qcChatTools.map((tool) => tool.name)).size, qcChatTools.length);
  for (const tool of SHARED_QC_ASSISTANT_TOOLS) assert.ok(qcChatTools.some((candidate) => candidate.name === tool.name), tool.name);
  for (const tool of qcChatTools) {
    const schema = tool.inputSchema as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    assert.equal(schema.additionalProperties, false, tool.name);
    assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)), tool.name);
  }
  for (const name of ["set_bypass", "set_parameter", "set_master_volume", "press_footswitch", "move_block", "add_block", "remove_block", "set_chain_split", "fetch_youtube_reference_audio", "save_current_unsaved_preset", "save_preset_as", "rename_current_preset", "create_device_backup", "reconnect_device", "reset_device_session", "disconnect_device"]) {
    assert.ok(qcChatTools.some((tool) => tool.name === name), name);
  }
});

test("keeps device data out of model policy instructions", () => {
  const instructions = chatInstructions();
  assert.match(instructions, /untrusted data/i);
  assert.doesNotMatch(instructions, /preset=/i);
});

test("validates model tool arguments before dispatch", () => {
  const call = { name: "set_bypass", arguments: { row: 2, desired_bypassed: true } };
  assert.equal(numericArgument(call, "row"), 2);
  assert.equal(booleanArgument(call, "desired_bypassed"), true);
  assert.throws(() => numericArgument(call, "column"), /invalid column/);
});

test("recognizes provider availability failures for explicit offline fallback", () => {
  assert.equal(isChatUnavailable(new Error("Provider unavailable: API key not configured")), true);
  assert.equal(chatErrorMessage({ code: "provider_unavailable", message: "No API key", retryable: false }), "[provider_unavailable] No API key");
  assert.equal(isChatUnavailable(new Error("Parameter value is invalid")), false);
});

test("distinguishes local model endpoints from providers needing disclosure", () => {
  assert.equal(isLoopbackChatUrl("http://127.0.0.1:11434/v1"), true);
  assert.equal(isLoopbackChatUrl("http://localhost:1234/v1"), true);
  assert.equal(isLoopbackChatUrl("https://api.openai.com/v1"), false);
  assert.equal(isLoopbackChatUrl("not a url"), false);
});

test("classifies read-only tools separately from direct device controls", () => {
  assert.equal(isReadOnlyChatTool("get_current_preset"), true);
  assert.equal(isReadOnlyChatTool("list_presets"), true);
  assert.equal(isReadOnlyChatTool("list_preset_slots"), true);
  assert.equal(isReadOnlyChatTool("fetch_youtube_reference_audio"), true);
  assert.equal(isReadOnlyChatTool("set_tempo"), false);
  assert.equal(isReadOnlyChatTool("set_parameter"), false);
});

test("Windows assistant access defaults to full control and enforces all four tiers", () => {
  const source = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  assert.equal(assistantAccessPermitsChatTool("read-only", "get_current_preset"), true);
  assert.equal(assistantAccessPermitsChatTool("read-only", "set_tempo"), false);
  assert.equal(assistantAccessPermitsChatTool("performance", "set_tempo"), true);
  assert.equal(assistantAccessPermitsChatTool("performance", "select_scene"), false);
  assert.equal(assistantAccessPermitsChatTool("modify", "set_parameter"), true);
  assert.equal(assistantAccessPermitsChatTool("modify", "set_device_name"), false);
  assert.equal(assistantAccessPermitsChatTool("full", "set_device_name"), true);
  assert.equal(assistantAccessPermitsChatTool("modify", "create_device_backup"), false);
  assert.match(source, /assistantAccessPermitsChatTool\(assistantAccessMode, tool\.name\)/);
  assert.match(source, /<option value="full">Full control<\/option>/);
  assert.match(source, /<option value="modify">Modify<\/option>/);
  assert.match(source, /<option value="performance">Performance<\/option>/);
  assert.match(source, /<option value="read-only">Read-only<\/option>/);
});

test("credential UI metadata prevents browser password restoration", () => {
  assert.equal(chatCredentialInputProps.type, "password");
  assert.equal(chatCredentialInputProps.autoComplete, "new-password");
  assert.equal(chatCredentialInputProps.spellCheck, false);
  assert.equal(Object.hasOwn(chatCredentialInputProps, "value"), false);
});

test("credential status distinguishes secure storage, environment, and loopback", () => {
  const base = { provider: "openai-responses" as const, providerName: "OpenAI API", model: "test", baseUrl: "https://example.com/v1", timeoutMs: 30000, available: true, detail: "", apiKeyRequired: true, apiKeyConfigured: true, oauthAvailable: false, oauthConfigured: false };
  assert.equal(chatCredentialStatus({ ...base, apiKeySource: "credential-manager" }), "API key stored in Windows Credential Manager");
  assert.equal(chatCredentialStatus({ ...base, apiKeySource: "environment" }), "API key supplied by the desktop environment");
  assert.match(chatCredentialStatus({ ...base, apiKeyRequired: false, apiKeySource: "not-required" }), /No API key required/);
  assert.equal(chatCredentialStatus({ ...base, provider: "gemini-openai", oauthConfigured: true, oauthProject: "my-project" }), "Google connected · quota project my-project");
});

test("Gemini BYOK uses Google's fixed OpenAI-compatible endpoint", () => {
  assert.equal(chatProviderDefaults["gemini-openai"].baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.match(chatProviderDefaults["gemini-openai"].model, /^gemini-/);
});

test("provider registry keeps protocol onboarding modular", () => {
  assert.deepEqual(Object.keys(chatProviderDefaults), ["openai-responses", "antigravity-cli", "gemini-openai", "anthropic-messages", "local-responses"]);
  assert.equal(chatProviderDefaults["antigravity-cli"].baseUrl, "https://antigravity.google");
  assert.equal(chatProviderDefaults["anthropic-messages"].endpointEditable, false);
  assert.match(chatProviderDefaults["anthropic-messages"].setupUrl ?? "", /claude\.com/);
  assert.equal(chatProviderDefaults["local-responses"].setupUrl, undefined);
});
