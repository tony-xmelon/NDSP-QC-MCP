package com.qccontrol.mobile;

import org.json.JSONObject;

/** Versioned phone/relay protocol generated from the shared MCP action contract. */
final class RelayProtocol {
    static final String VERSION = GeneratedRelayProfile.PROTOCOL_VERSION;

    static JSONObject result(String id, JSONObject value) throws Exception {
        return new JSONObject().put("type", "result").put("id", id).put("ok", true).put("result", value);
    }

    static JSONObject error(String id, String code, String message, boolean retryable) throws Exception {
        return new JSONObject().put("type", "result").put("id", id).put("ok", false).put("error",
            new JSONObject().put("code", code).put("message", message).put("retryable", retryable));
    }

    static boolean isAllowed(String method) { return GeneratedRemoteActions.contains(method); }
    static boolean isReadOnly(String method) { return GeneratedRemoteActions.isReadOnly(method); }
    static boolean requiresConfirmation(String method) { return GeneratedRemoteActions.requiresConfirmation(method); }

    private RelayProtocol() {}
}
