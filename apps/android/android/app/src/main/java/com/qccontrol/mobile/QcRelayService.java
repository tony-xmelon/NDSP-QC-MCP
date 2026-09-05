package com.qccontrol.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.LinkedHashSet;
import java.util.Set;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONObject;

/** Foreground owner for the phone's outbound, authenticated relay connection. */
public final class QcRelayService extends Service {
    static final String ACTION_START = "com.qccontrol.mobile.relay.START";
    static final String ACTION_STOP = "com.qccontrol.mobile.relay.STOP";
    static final String ACTION_STATUS = "com.qccontrol.mobile.relay.STATUS";
    static final String EXTRA_STATE = "state";
    private static final String CHANNEL = "qc_relay";
    private static final int NOTIFICATION_ID = 7311;
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
    private final AtomicInteger generation = new AtomicInteger();
    private OkHttpClient http;
    private WebSocket socket;
    private ScheduledFuture<?> retry;
    private ScheduledFuture<?> readiness;
    private int failures;
    private volatile String state = "stopped";
    private final Set<String> completedRequestIds = new LinkedHashSet<>();

    @Override public void onCreate() {
        super.onCreate();
        http = new OkHttpClient.Builder()
            .pingInterval(GeneratedRelayProfile.PING_INTERVAL_MS, TimeUnit.MILLISECONDS).build();
        createChannel();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopRelay();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!new RelayCredentialStore(this).paired()) { updateState("pairing_required"); stopSelf(); return START_NOT_STICKY; }
        startForeground(NOTIFICATION_ID, notification("Connecting securely…"));
        if ("connecting".equals(state) || "connected".equals(state) || "reconnecting".equals(state)) return START_STICKY;
        connect(generation.incrementAndGet());
        return START_STICKY;
    }

    private synchronized void connect(int attemptGeneration) {
        RelayCredentialStore store = new RelayCredentialStore(this);
        String endpoint = store.endpoint();
        String credential;
        try { credential = store.credential(); }
        catch (Exception error) { store.clear(); updateState("pairing_required"); stopSelf(); return; }
        if (endpoint == null || credential == null) { updateState("pairing_required"); stopSelf(); return; }
        if (!endpoint.startsWith("https://")) { updateState("invalid_endpoint"); stopSelf(); return; }
        String wsEndpoint = endpoint.replaceFirst("^https://", "wss://").replaceAll("/$", "")
            + GeneratedRelayProfile.DEVICE_CONNECT_PATH;
        Request request = new Request.Builder().url(wsEndpoint)
            .header("Authorization", "Bearer " + credential)
            .header("Sec-WebSocket-Protocol", RelayProtocol.VERSION)
            .build();
        updateState("connecting");
        socket = http.newWebSocket(request, new Listener(attemptGeneration));
    }

    private final class Listener extends WebSocketListener {
        private final int expectedGeneration;
        Listener(int expectedGeneration) { this.expectedGeneration = expectedGeneration; }

        @Override public void onOpen(WebSocket webSocket, Response response) {
            if (expectedGeneration != generation.get()) { webSocket.close(1000, "superseded"); return; }
            failures = 0;
            updateState("connected");
            startReadinessUpdates(webSocket);
        }

        @Override public void onMessage(WebSocket webSocket, String text) {
            if (text.length() > GeneratedRelayProfile.MAX_REQUEST_FRAME_BYTES) { webSocket.close(1009, "message too large"); return; }
            final JSONObject request;
            final String id;
            try {
                request = new JSONObject(text);
                id = request.getString("id");
                if (!"invoke".equals(request.getString("type"))) throw new IllegalArgumentException("Unsupported message type.");
            } catch (Exception error) {
                try { webSocket.send(RelayProtocol.error("", "INVALID_REQUEST", "Invalid relay request.", false).toString()); }
                catch (Exception ignored) {}
                return;
            }
            String method = request.optString("method", "");
            synchronized (completedRequestIds) {
                if (completedRequestIds.contains(id)) {
                    try { webSocket.send(RelayProtocol.error(id, "REPLAYED_REQUEST", "This request identifier was already processed.", false).toString()); }
                    catch (Exception ignored) {}
                    return;
                }
                completedRequestIds.add(id);
                if (completedRequestIds.size() > GeneratedRelayProfile.COMPLETED_REQUEST_CACHE_SIZE)
                    completedRequestIds.remove(completedRequestIds.iterator().next());
            }
            if (!RelayProtocol.isAllowed(method)) {
                String code = RelayProtocol.requiresConfirmation(method) ? "CONFIRMATION_REQUIRED" : "METHOD_NOT_ALLOWED";
                String message = RelayProtocol.requiresConfirmation(method)
                    ? "This operation is not supported by the Android bridge until local confirmation and authoritative verification are available."
                    : "The requested method is not in the Android relay allowlist.";
                try { webSocket.send(RelayProtocol.error(id, code, message, false).toString()); }
                catch (Exception ignored) {}
                return;
            }
            if (!RelayAccessPolicy.permits(QcRelayService.this, method)) {
                try { webSocket.send(RelayProtocol.error(id, "ACCESS_MODE_RESTRICTED", "The requested operation is outside this phone's remote access mode.", false).toString()); }
                catch (Exception ignored) {}
                return;
            }
            QcUsbPlugin.invokeFromRelay(method, request.optJSONObject("params"), request.optJSONObject("expectedState"))
                .whenComplete((result, error) -> {
                    try {
                        JSONObject reply = error == null
                            ? RelayProtocol.result(id, result)
                            : RelayProtocol.error(id, error instanceof QcUsbPlugin.RelayException
                                ? ((QcUsbPlugin.RelayException) error).code : "DEVICE_ERROR",
                                error.getMessage() == null ? "The device operation failed." : error.getMessage(), false);
                        // WebSocket frames are ordered. Publish the post-operation
                        // USB state before the result so reset/reconnect callers
                        // cannot race the next one-second readiness heartbeat.
                        sendReadiness(webSocket);
                        sendResult(webSocket, id, reply);
                    } catch (Exception ignored) {}
                });
        }

        @Override public void onClosed(WebSocket webSocket, int code, String reason) {
            stopReadinessUpdates(webSocket);
            if (code == 4001 || code == 4003) {
                new RelayCredentialStore(QcRelayService.this).clear();
                generation.incrementAndGet(); updateState("pairing_required"); stopSelf(); return;
            }
            reconnect(expectedGeneration);
        }
        @Override public void onFailure(WebSocket webSocket, Throwable error, Response response) {
            stopReadinessUpdates(webSocket);
            if (response != null && (response.code() == 401 || response.code() == 403)) {
                new RelayCredentialStore(QcRelayService.this).clear();
                generation.incrementAndGet(); updateState("pairing_required"); stopSelf(); return;
            }
            reconnect(expectedGeneration);
        }
    }

    private synchronized void startReadinessUpdates(WebSocket webSocket) {
        if (readiness != null) readiness.cancel(false);
        sendReadiness(webSocket);
        readiness = scheduler.scheduleWithFixedDelay(
            () -> sendReadiness(webSocket), GeneratedRelayProfile.READINESS_INTERVAL_MS,
            GeneratedRelayProfile.READINESS_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    private synchronized void stopReadinessUpdates(WebSocket webSocket) {
        if (webSocket != socket || readiness == null) return;
        readiness.cancel(false);
        readiness = null;
    }

    private void sendReadiness(WebSocket webSocket) {
        if (webSocket != socket || !"connected".equals(state)) return;
        try {
            webSocket.send(new JSONObject().put("type", "ready").put("protocol", RelayProtocol.VERSION)
                .put("usbConnected", QcUsbPlugin.relaySessionAvailable()).toString());
        } catch (Exception ignored) {}
    }

    private void sendResult(WebSocket webSocket, String id, JSONObject reply) throws Exception {
        String text = reply.toString();
        if (text.length() > GeneratedRelayProfile.MAX_RESULT_FRAME_BYTES) {
            text = RelayProtocol.error(id, "RESULT_TOO_LARGE",
                "The device result exceeds the relay frame limit.", false).toString();
        }
        webSocket.send(text);
    }

    private synchronized void reconnect(int failedGeneration) {
        if (failedGeneration != generation.get()) return;
        updateState("reconnecting");
        failures = Math.min(failures + 1, GeneratedRelayProfile.MAXIMUM_FAILURE_COUNT);
        long base = Math.min(GeneratedRelayProfile.MAXIMUM_BACKOFF_SECONDS,
            1L << Math.min(failures, GeneratedRelayProfile.MAXIMUM_BACKOFF_EXPONENT));
        long jitterMs = (long) (Math.random() * GeneratedRelayProfile.BACKOFF_JITTER_MS);
        retry = scheduler.schedule(() -> connect(generation.get()), base * 1000 + jitterMs, TimeUnit.MILLISECONDS);
    }

    private synchronized void stopRelay() {
        generation.incrementAndGet();
        if (retry != null) retry.cancel(false);
        if (readiness != null) readiness.cancel(false);
        readiness = null;
        if (socket != null) socket.close(1000, "stopped");
        socket = null;
        updateState("stopped");
        stopForeground(STOP_FOREGROUND_REMOVE);
    }

    private void updateState(String next) {
        state = next;
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTIFICATION_ID,
            notification("connected".equals(next) ? "Ready for remote QC control" : next.replace('_', ' ')));
        sendBroadcast(new Intent(ACTION_STATUS).setPackage(getPackageName()).putExtra(EXTRA_STATE, next));
    }

    private Notification notification(String detail) {
        return new NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(getString(R.string.relay_notification_title)).setContentText(detail).setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE).setPriority(NotificationCompat.PRIORITY_LOW).build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "QC remote connection", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Keeps the secure Quad Cortex relay connected while USB is attached.");
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(channel);
    }

    @Override public void onDestroy() { stopRelay(); scheduler.shutdownNow(); http.dispatcher().executorService().shutdown(); super.onDestroy(); }
    @Nullable @Override public IBinder onBind(Intent intent) { return null; }
}
