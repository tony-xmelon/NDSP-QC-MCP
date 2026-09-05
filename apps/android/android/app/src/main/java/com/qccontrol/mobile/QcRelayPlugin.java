package com.qccontrol.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;
import java.net.URI;

@CapacitorPlugin(name = "QcRelay")
public final class QcRelayPlugin extends Plugin {
    private final OkHttpClient http = new OkHttpClient();
    private volatile String relayState = "stopped";
    private final BroadcastReceiver statusReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            relayState = intent.getStringExtra(QcRelayService.EXTRA_STATE);
            JSObject value = new JSObject(); value.put("state", relayState);
            notifyListeners("relayState", value, true);
        }
    };

    @Override public void load() {
        ContextCompat.registerReceiver(getContext(), statusReceiver,
            new IntentFilter(QcRelayService.ACTION_STATUS), ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @PluginMethod public void status(PluginCall call) {
        RelayCredentialStore store = new RelayCredentialStore(getContext());
        JSObject result = new JSObject();
        result.put("paired", store.paired()); result.put("state", relayState);
        result.put("accessMode", RelayAccessPolicy.mode(getContext()));
        String endpoint = store.endpoint(); if (endpoint != null) result.put("endpoint", endpoint);
        call.resolve(result);
    }

    @PluginMethod public void pair(PluginCall call) {
        String endpoint = normalizedEndpoint(call.getString("endpoint", ""));
        String pairingCode = call.getString("pairingCode", "").trim();
        String deviceName = call.getString("deviceName", android.os.Build.MODEL).trim();
        if (endpoint == null || deviceName.isEmpty()
            || pairingCode.length() < GeneratedRelayProfile.PAIRING_CODE_MINIMUM_LENGTH
            || pairingCode.length() > GeneratedRelayProfile.PAIRING_CODE_MAXIMUM_LENGTH) {
            call.reject("A secure HTTPS relay and valid pairing code are required.", "INVALID_PAIRING"); return;
        }
        try {
            JSONObject body = new JSONObject().put("pairingCode", pairingCode).put("deviceName", deviceName)
                .put("protocol", RelayProtocol.VERSION);
            Request request = new Request.Builder().url(endpoint + GeneratedRelayProfile.DEVICE_PAIR_PATH)
                .post(RequestBody.create(body.toString(), MediaType.get("application/json; charset=utf-8"))).build();
            http.newCall(request).enqueue(new Callback() {
                @Override public void onFailure(Call ignored, IOException error) {
                    android.util.Log.e("QcRelayPlugin", "Pairing request failed: "
                        + error.getClass().getName() + ": " + error.getMessage(), error);
                    call.reject("Could not reach the relay.", "PAIRING_NETWORK_ERROR", error);
                }
                @Override public void onResponse(Call ignored, Response response) {
                    try (response) {
                        if (!response.isSuccessful()) { call.reject("The pairing code was rejected.", "PAIRING_REJECTED"); return; }
                        JSONObject payload = new JSONObject(response.body().string());
                        String credential = payload.getString("deviceCredential");
                        if (credential.length() < GeneratedRelayProfile.MINIMUM_CREDENTIAL_LENGTH)
                            throw new IllegalStateException("Relay returned an invalid credential.");
                        new RelayCredentialStore(getContext()).save(endpoint, credential);
                        startService();
                        JSObject result = new JSObject(); result.put("paired", true); result.put("endpoint", endpoint);
                        call.resolve(result);
                    } catch (Exception error) { call.reject("Could not securely store the device credential.", "PAIRING_STORAGE_ERROR", error); }
                }
            });
        } catch (Exception error) { call.reject("Pairing request is invalid.", "INVALID_PAIRING", error); }
    }

    @PluginMethod public void start(PluginCall call) { if (!new RelayCredentialStore(getContext()).paired()) { call.reject("Pair this phone first.", "PAIRING_REQUIRED"); return; } startService(); call.resolve(); }
    @PluginMethod public void setAccessMode(PluginCall call) {
        try {
            String mode = call.getString("mode", RelayAccessPolicy.FULL);
            RelayAccessPolicy.setMode(getContext(), mode);
            JSObject result = new JSObject(); result.put("accessMode", mode); call.resolve(result);
        } catch (IllegalArgumentException error) { call.reject(error.getMessage(), "INVALID_ACCESS_MODE", error); }
    }
    @PluginMethod public void unpair(PluginCall call) {
        getContext().startService(new Intent(getContext(), QcRelayService.class).setAction(QcRelayService.ACTION_STOP));
        new RelayCredentialStore(getContext()).clear(); relayState = "stopped"; call.resolve();
    }

    private void startService() {
        ContextCompat.startForegroundService(getContext(), new Intent(getContext(), QcRelayService.class).setAction(QcRelayService.ACTION_START));
    }

    static String normalizedEndpoint(String raw) {
        String value = raw == null ? "" : raw.trim().replaceAll("/+$", "");
        try {
            URI uri = URI.create(value);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getHost().isEmpty()
                || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                || uri.getPath() != null && !uri.getPath().isEmpty() && !"/".equals(uri.getPath())) return null;
            return value;
        } catch (Exception ignored) { return null; }
    }

    @Override protected void handleOnDestroy() {
        try { getContext().unregisterReceiver(statusReceiver); } catch (Exception ignored) {}
        http.dispatcher().executorService().shutdown(); super.handleOnDestroy();
    }
}
