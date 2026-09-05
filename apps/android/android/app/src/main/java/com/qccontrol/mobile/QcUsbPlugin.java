package com.qccontrol.mobile;

import android.annotation.TargetApi;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.hardware.usb.UsbRequest;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.UUID;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

@CapacitorPlugin(name = "QcUsb")
public class QcUsbPlugin extends Plugin {
    private static long monotonicMillis() { return System.nanoTime() / 1_000_000L; }
    private static final int HID_WRITE_TIMEOUT_MS = 250;
    private static final int MIDI_WRITE_TIMEOUT_MS = 250;
    private static final int MAINTENANCE_POLL_MS = 1000;
    private static final int HID_INPUT_REQUEST_DEPTH = 32;
    private static final String USB_PERMISSION = "com.qccontrol.mobile.USB_PERMISSION";

    private UsbManager manager;
    private UsbDevice device;
    private UsbDeviceConnection connection;
    private UsbInterface hidInterface;
    private UsbEndpoint inputEndpoint;
    private volatile UsbRequest[] activeInputRequests;
    private UsbDeviceConnection midiConnection;
    private UsbInterface midiInterface;
    private UsbEndpoint midiOutputEndpoint;
    private PluginCall pendingConnect;
    // HID reads, HID writes, and performance MIDI each have an independent
    // lane. A footswitch must never queue behind preset synchronization or a
    // multi-report parameter write.
    private final ExecutorService readerIo = Executors.newSingleThreadExecutor();
    private final ExecutorService commandIo = Executors.newSingleThreadExecutor();
    private final ExecutorService midiIo = Executors.newSingleThreadExecutor();
    private final ExecutorService metadataIo = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService keepalive = Executors.newSingleThreadScheduledExecutor();
    private volatile boolean reading;
    private volatile CountDownLatch resetReply;
    private volatile String currentSetlist;
    private volatile int currentPosition = -1;
    private volatile boolean currentSetlistFactory;
    private volatile long messagesReceived;
    private volatile long rawReportsReceived;
    private volatile long messagesSent;
    private volatile long decodeErrors;
    private volatile long expectedWriteStalls;
    private volatile int lastMessageType = -1;
    private volatile long connectedAt;
    private volatile String lastError;
    private final AtomicLong requestIds = new AtomicLong(1);
    private volatile long readAttempts;
    private volatile long negativeReads;
    private volatile int selectedInterfaceId = -1;
    private volatile int selectedInputEndpointAddress = -1;
    private volatile int selectedInputMaxPacketSize;
    private volatile boolean includeReportId = true;
    private volatile boolean handshakeComplete;
    private volatile boolean presetSynchronized;
    private volatile boolean connecting;
    private volatile long lastMidiCommandAt;
    private volatile long lastMidiQueueDelayMs;
    private volatile long maxMidiQueueDelayMs;
    private volatile long lastStateAt;
    private volatile long lastHidWriteDurationMs;
    private volatile int lastHidWriteResult;
    private volatile boolean lastHidWriteIncludedReportId;
    private volatile String lastGatewayReadMismatch;
    private volatile boolean readerWaiting;
    private volatile long readerExitedAt;
    private volatile String lastReaderError;
    private volatile long lastPresetLibraryAt;
    private final AtomicBoolean presetLibrarySettlementScheduled = new AtomicBoolean();
    private final AtomicLong connectionGeneration = new AtomicLong();
    private final QcPendingOperations pendingOperations = new QcPendingOperations();
    private final QcNativeStateDecoder stateDecoder = new QcNativeStateDecoder();
    private static volatile QcUsbPlugin relaySession;
    private volatile String currentPresetName;
    private volatile int currentMasterVolume = -1;
    private final Object stateEventLock = new Object();
    private final Deque<JSObject> stateEventLog = new ArrayDeque<>();
    private long nextStateSequence = 1;
    private volatile JSObject latestTempoClock;
    private volatile QcPendingOperations.Entry<PendingBackup> pendingBackup;
    private volatile QcPendingOperations.Entry<PendingReady> pendingReady;

    private final BroadcastReceiver permissionReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!USB_PERMISSION.equals(intent.getAction())) return;
            UsbDevice grantedDevice = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                ? intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice.class)
                : intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
            PluginCall call = pendingConnect;
            pendingConnect = null;
            if (call == null) return;
            if (!granted || grantedDevice == null) {
                call.reject("USB permission was denied.", "USB_PERMISSION_DENIED");
                return;
            }
            openAndHandshake(grantedDevice, call);
        }
    };

    private final BroadcastReceiver deviceReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            UsbDevice changed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                ? intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice.class)
                : intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            if (changed == null || !isQuadCortex(changed)) return;
            JSObject status = new JSObject();
            if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(intent.getAction())) {
                if (device != null && device.getDeviceId() == changed.getDeviceId()) closeConnection();
                status.put("state", "disconnected");
            } else {
                status.put("state", "available");
                status.put("name", changed.getProductName() == null ? getContext().getString(R.string.device_name) : changed.getProductName());
                scheduleAutomaticReconnect("Quad Cortex USB reattached");
            }
            notifyListeners("qcConnection", status, true);
        }
    };

    @Override
    public void load() {
        relaySession = this;
        manager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        IntentFilter filter = new IntentFilter(USB_PERMISSION);
        ContextCompat.registerReceiver(
            getContext(), permissionReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED
        );
        IntentFilter deviceFilter = new IntentFilter();
        deviceFilter.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        deviceFilter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        ContextCompat.registerReceiver(
            getContext(), deviceReceiver, deviceFilter, ContextCompat.RECEIVER_EXPORTED
        );
        keepalive.scheduleWithFixedDelay(() -> {
            boolean backupActive = pendingBackup != null;
            if (!isReady() || !backupActive && !pendingOperations.isEmpty()
                || !stateDecoder.sessionShouldKeepalive(System.currentTimeMillis())) return;
            // Keepalives share the serialized writer, but only enter the queue
            // after five completely idle seconds. Normal interaction therefore
            // never waits for recurring maintenance traffic.
            commandIo.execute(() -> {
                boolean currentBackupActive = pendingBackup != null;
                if (!isReady() || !currentBackupActive && !pendingOperations.isEmpty()
                    || !stateDecoder.sessionShouldKeepalive(System.currentTimeMillis())) return;
                // Android USB hosts can stop completing interrupt-IN requests
                // after a device-silent interval. Version type 10 is a minimal,
                // side-effect-free correlated read with a physical reply.
                try {
                    writeMessage(currentBackupActive
                        ? stateDecoder.keepaliveCommand()
                        : stateDecoder.readCommand(10));
                } catch (Exception ignored) {}
            });
        }, MAINTENANCE_POLL_MS, MAINTENANCE_POLL_MS, TimeUnit.MILLISECONDS);
    }

    static boolean relaySessionAvailable() {
        QcUsbPlugin session = relaySession;
        return session != null && session.isReady() && session.presetSynchronized;
    }

    static CompletableFuture<org.json.JSONObject> invokeFromRelay(String method, org.json.JSONObject params, org.json.JSONObject expected) {
        QcUsbPlugin session = relaySession;
        if (session == null) return failedRelay("NOT_CONNECTED", "QC Control is not running with a Quad Cortex session.");
        return session.relayInvoke(method, params == null ? new org.json.JSONObject() : params,
            expected == null ? new org.json.JSONObject() : expected);
    }

    static final class RelayException extends RuntimeException {
        final String code;
        RelayException(String code, String message) { super(message); this.code = code; }
        boolean retryable() {
            return "NOT_CONNECTED".equals(code) || "READBACK_TIMEOUT".equals(code)
                || "USB_CONNECT_FAILED".equals(code) || "DEVICE_TRANSPORT".equals(code);
        }
    }

    private static CompletableFuture<org.json.JSONObject> failedRelay(String code, String message) {
        CompletableFuture<org.json.JSONObject> value = new CompletableFuture<>();
        value.completeExceptionally(new RelayException(code, message));
        return value;
    }

    private static final class PendingBackup {
        final String name;
        final long createdAt = System.currentTimeMillis();
        volatile long lastActivityAt = createdAt;
        volatile boolean started;
        volatile int chunks;
        volatile int ignoredPrefixChunks;
        volatile int attempts = 1;
        volatile int rawReports;
        volatile int decodedMessages;
        volatile int lastRawReportBytes;
        volatile boolean recoveryStarted;
        volatile long recoveryAfterState;
        volatile org.json.JSONObject savedResult;

        PendingBackup(String name) {
            this.name = name;
        }
    }

    private static final class PendingReady {
        final String detail;

        PendingReady(String detail) {
            this.detail = detail;
        }
    }

    private CompletableFuture<org.json.JSONObject> relayDisconnect() {
        closeConnection();
        return CompletableFuture.completedFuture(connectionState("Quad Cortex session closed"));
    }

    private CompletableFuture<org.json.JSONObject> relayReconnect(String detail) {
        UsbDevice candidate = findQuadCortex();
        if (candidate == null) return failedRelay("DEVICE_NOT_FOUND", "No Quad Cortex was found over USB.");
        if (!manager.hasPermission(candidate)) return failedRelay("USB_PERMISSION_REQUIRED", "Quad Cortex USB permission is required.");
        synchronized (this) {
            if (connecting) return failedRelay("CONNECT_IN_PROGRESS", "The Quad Cortex USB connection is already starting.");
            connecting = true;
        }
        CompletableFuture<org.json.JSONObject> result = new CompletableFuture<>();
        QcPendingOperations.Entry<PendingReady> pending = pendingOperations.register(new PendingReady(detail), result);
        pendingReady = pending;
        commandIo.execute(() -> {
            try {
                openDeviceAndHandshake(candidate, pending);
                resolvePendingReady();
            } catch (Exception error) {
                lastError = error.getMessage();
                if (pendingReady == pending) pendingReady = null;
                pendingOperations.remove(pending);
                closeConnection();
                result.completeExceptionally(new RelayException("USB_CONNECT_FAILED", error.getMessage()));
            } finally {
                connecting = false;
            }
        });
        pendingOperations.timeout(pending, QcUsbProfile.READY_WAIT_TIMEOUT_MS, keepalive,
            () -> new RelayException("READBACK_TIMEOUT", "The Quad Cortex did not finish synchronizing in time."));
        return result;
    }

    private void scheduleAutomaticReconnect(String detail) {
        keepalive.schedule(() -> {
            UsbDevice candidate = findQuadCortex();
            if (candidate == null || isReady() || connecting || !manager.hasPermission(candidate)) return;
            relayReconnect(detail).whenComplete((ignored, error) -> {
                if (error != null) android.util.Log.w(
                    "QcUsbPlugin", "Automatic QC USB reconnect failed: " + error.getMessage());
            });
        }, 250, TimeUnit.MILLISECONDS);
    }

    private void resolvePendingReady() {
        QcPendingOperations.Entry<PendingReady> pending = pendingReady;
        if (pending == null || !isReady() || !presetSynchronized || currentSetlist == null) return;
        if (pendingReady == pending) {
            pendingReady = null;
            if (pendingOperations.remove(pending)) {
                pending.result.complete(connectionState(pending.operation.detail));
            }
        }
    }

    private org.json.JSONObject connectionState(String detail) {
        JSObject state = new JSObject();
        state.put("phase", !isReady() ? "disconnected" : presetSynchronized && currentSetlist != null ? "ready" : "syncing");
        state.put("detail", detail);
        state.put("lastSync", connectedAt == 0 ? org.json.JSONObject.NULL : connectedAt);
        state.put("demo", false);
        return state;
    }

    private org.json.JSONObject relayStateEvents(org.json.JSONObject params) throws Exception {
        long after = params.has("afterSequence") ? params.getLong("afterSequence") : 0;
        int limit = params.has("limit") ? params.getInt("limit") : QcDomain.STATE_EVENT_DEFAULT_LIMIT;
        if (after < 0) throw new IllegalArgumentException("afterSequence must be a non-negative integer.");
        if (limit < 1 || limit > QcDomain.STATE_EVENT_MAXIMUM_LIMIT)
            throw new IllegalArgumentException("limit must be an integer from 1 through " + QcDomain.STATE_EVENT_MAXIMUM_LIMIT + ".");
        org.json.JSONArray frames = new org.json.JSONArray();
        synchronized (stateEventLock) {
            for (JSObject frame : stateEventLog) {
                if (frame.optLong("sequence", 0) > after && frames.length() < limit) frames.put(frame);
            }
        }
        JSObject result = new JSObject();
        result.put("native", true);
        result.put("frames", frames);
        return result;
    }

    private org.json.JSONObject relayTempoClock() {
        JSObject clock = latestTempoClock;
        if (clock != null) return clock;
        JSObject unavailable = new JSObject();
        unavailable.put("available", false);
        return unavailable;
    }

    private CompletableFuture<org.json.JSONObject> relayCreateBackup(org.json.JSONObject params) throws Exception {
        String name = params.optString("name", "");
        if (name.trim().isEmpty()) return failedRelay("INVALID_ARGUMENT", "Backup name cannot be empty.");
        if (pendingBackup != null && !pendingBackup.result.isDone()) return failedRelay("BACKUP_IN_PROGRESS", "A device backup is already in progress.");
        CompletableFuture<org.json.JSONObject> result = new CompletableFuture<>();
        QcPendingOperations.Entry<PendingBackup> pending = pendingOperations.register(new PendingBackup(name), result);
        pendingBackup = pending;
        commandIo.execute(() -> {
            try {
                if (!isReady()) throw new RelayException("NOT_CONNECTED", "Quad Cortex USB disconnected before the backup.");
                android.util.Log.i("QcUsbPlugin", "Sending native backup request 1; includeReportId=" + includeReportId);
                writeMessage(stateDecoder.backupCommand());
            } catch (Exception error) {
                if (pendingBackup == pending) pendingBackup = null;
                pendingOperations.remove(pending);
                result.completeExceptionally(error);
            }
        });
        pendingOperations.timeout(pending, QcUsbProfile.BACKUP_TOTAL_TIMEOUT_MS, keepalive,
            () -> new RelayException("READBACK_TIMEOUT", "The Quad Cortex did not finish the native backup within " + (QcUsbProfile.BACKUP_TOTAL_TIMEOUT_MS / 1000) + " seconds."));
        scheduleBackupWatchdog(pending, QcUsbProfile.BACKUP_FIRST_CHUNK_TIMEOUT_MS);
        return result;
    }

    private void scheduleBackupWatchdog(QcPendingOperations.Entry<PendingBackup> pending, long delayMs) {
        keepalive.schedule(() -> {
            if (pendingBackup != pending || pending.result.isDone()) return;
            PendingBackup operation = pending.operation;
            if (operation.recoveryStarted) return;
            long now = System.currentTimeMillis();
            long stallLimit = operation.started ? QcUsbProfile.BACKUP_STREAM_STALL_TIMEOUT_MS : QcUsbProfile.BACKUP_FIRST_CHUNK_TIMEOUT_MS;
            long idle = now - operation.lastActivityAt;
            if (idle < stallLimit) {
                scheduleBackupWatchdog(pending, stallLimit - idle);
                return;
            }
            if (operation.started) {
                pendingBackup = null;
                if (pendingOperations.remove(pending)) pending.result.completeExceptionally(new RelayException(
                    "READBACK_TIMEOUT", "The native backup stream stalled after " + operation.chunks
                        + " chunks; the partial document was discarded. Android observed " + operation.rawReports
                        + " raw HID reports and " + operation.decodedMessages + " decoded messages during the operation."));
                return;
            }
            pendingBackup = null;
            if (pendingOperations.remove(pending)) pending.result.completeExceptionally(new RelayException(
                "READBACK_TIMEOUT", "No native backup document started after one request. Android observed "
                    + operation.rawReports + " raw HID reports, " + operation.decodedMessages
                    + " decoded messages, and a last raw report length of " + operation.lastRawReportBytes
                    + " bytes. Android never repeats a backup request because the device may have completed it without a visible USB reply."));
        }, Math.max(1, delayMs), TimeUnit.MILLISECONDS);
    }

    private org.json.JSONObject saveBackupDocument(org.json.JSONObject document, String requestedName) throws Exception {
        String safeName = requestedName.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (safeName.isEmpty()) safeName = "QC Device Backup";
        String fileName = safeName.endsWith(".json") ? safeName : safeName + ".json";
        byte[] bytes = document.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > QcUsbProfile.BACKUP_MAXIMUM_DOCUMENT_BYTES) throw new Exception("The native backup exceeds the 32 MiB safety limit.");

        String path;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
            values.put(MediaStore.Downloads.MIME_TYPE, "application/json");
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + getContext().getString(R.string.download_folder));
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            android.net.Uri uri = getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new Exception("Android could not create the backup file in Downloads.");
            try (OutputStream output = getContext().getContentResolver().openOutputStream(uri, "w")) {
                if (output == null) throw new Exception("Android could not open the backup file for writing.");
                output.write(bytes);
            } catch (Exception error) {
                getContext().getContentResolver().delete(uri, null, null);
                throw error;
            }
            ContentValues ready = new ContentValues();
            ready.put(MediaStore.Downloads.IS_PENDING, 0);
            getContext().getContentResolver().update(uri, ready, null, null);
            path = uri.toString();
        } else {
            File root = new File(getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), getContext().getString(R.string.download_folder));
            if (!root.isDirectory() && !root.mkdirs()) throw new Exception("Android could not create the backup directory.");
            File file = new File(root, fileName);
            try (OutputStream output = new FileOutputStream(file)) { output.write(bytes); }
            path = file.getAbsolutePath();
        }
        return new JSObject().put("cancelled", false).put("path", path).put("name", fileName);
    }

    private CompletableFuture<org.json.JSONObject> relayInvoke(String method, org.json.JSONObject params, org.json.JSONObject expected) {
        try {
            params = stateDecoder.mergeExpectedState(
                JSObject.fromJSONObject(params), JSObject.fromJSONObject(expected));
            GeneratedGatewayMethods.validateParams(method, params);
            String dispatch = GeneratedGatewayMethods.dispatchKind(method);
            if ("SYSTEM".equals(dispatch)) {
                return CompletableFuture.completedFuture(new JSObject()
                    .put("platform", "Rust Android USB gateway")
                    .put("gatewayAvailable", true)
                    .put("gatewayApiVersion", GeneratedGatewayMethods.API_VERSION)
                    .put("capabilities", GeneratedGatewayMethods.CAPABILITIES)
                    .put("message", "Shared Rust QC engine active")
                    .put("connected", isReady()).put("synchronized", presetSynchronized && currentSetlist != null)
                    .put("transport", "android-usb-relay"));
            }
            if ("RECONNECT".equals(dispatch)) return relayReconnect(
                "device.resetSession".equals(method) ? "Communication session reset" : "Quad Cortex handshake complete");
            if ("DISCONNECT".equals(dispatch)) return relayDisconnect();
            if (!isReady()) return failedRelay("NOT_CONNECTED", "Quad Cortex USB is not connected.");
            switch (dispatch) {
                case "SNAPSHOT": return CompletableFuture.completedFuture(relaySnapshot());
                case "STATE_EVENTS": return CompletableFuture.completedFuture(relayStateEvents(params));
                case "TEMPO_CLOCK": return CompletableFuture.completedFuture(relayTempoClock());
                case "CORRELATED_READ": return relayGatewayRead(method, params);
                case "MODELS": return CompletableFuture.completedFuture(stateDecoder.modelList());
                case "PRESET_LIBRARY": return relayPresetLibraryRead(method, params);
                case "MASTER_VOLUME":
                    if (currentMasterVolume < 0) return failedRelay("STATE_UNAVAILABLE", "The Quad Cortex has not reported master volume yet.");
                    return CompletableFuture.completedFuture(new org.json.JSONObject().put("value", currentMasterVolume).put("observedAt", lastStateAt));
                case "BLOCK_DETAILS": return CompletableFuture.completedFuture(
                    "device.laneControlDetails".equals(method)
                        ? stateDecoder.laneControlDetails(params.getInt("row"), params.getString("control"))
                        : stateDecoder.blockDetails(params.getInt("row"), params.getInt("column")));
                case "SET_DEVICE_NAME": return relaySetDeviceName(params);
                case "TAP_SCREEN": return relayTapScreen(params);
                case "BACKUP": return relayCreateBackup(params);
                case "PREVIEW_PARAMETER": return relayPreviewParameter(method, params);
                case "PLANNED_WRITE": return relayPlannedGatewayWriteWithReadback(
                    method, params, QcUsbProfile.COMMAND_CONFIRMATION_TIMEOUT_MS);
                case "PRESET_WRITE": return relayPlannedGatewayWrite(
                    method, params, QcUsbProfile.PRESET_SYNC_TIMEOUT_MS);
                case "PERSISTENT_WRITE": return relayGatewayWorkflow(method, params);
                default: return failedRelay("METHOD_NOT_ALLOWED", "The requested device operation is not supported by Android.");
            }
        } catch (Exception error) { return failedRelay("INVALID_ARGUMENT", error.getMessage() == null ? "Invalid device arguments." : error.getMessage()); }
    }

    private CompletableFuture<org.json.JSONObject> relayPlannedGatewayWrite(
        String method, org.json.JSONObject params, long timeoutMs
    ) throws Exception {
        QcNativeStateDecoder.PlannedGatewayWrite plan = stateDecoder.gatewayPlan(method, JSObject.fromJSONObject(params));
        return executeRelayPlan(plan, timeoutMs);
    }

    private CompletableFuture<org.json.JSONObject> relayPlannedGatewayWriteWithReadback(
        String method, org.json.JSONObject params, long timeoutMs
    ) throws Exception {
        String readMethod = stateDecoder.gatewayWriteReadbackMethod(method);
        CompletableFuture<org.json.JSONObject> write = relayPlannedGatewayWrite(method, params, timeoutMs);
        if (readMethod == null) return write;
        return write.thenCompose(ignored -> {
            try { return relayGatewayRead(readMethod, new org.json.JSONObject()); }
            catch (Exception error) {
                CompletableFuture<org.json.JSONObject> failed = new CompletableFuture<>();
                failed.completeExceptionally(error);
                return failed;
            }
        }).thenApply(readback -> {
            if (!stateDecoder.gatewayReadbackMatches(method, params, readback)) {
                throw new java.util.concurrent.CompletionException(new RelayException(
                    "READBACK_MISMATCH", "The QC returned settings that do not match the requested write."));
            }
            try { return new org.json.JSONObject()
                .put("accepted", true).put("verified", true)
                .put("verification", "authoritative_readback")
                .put("detail", "The QC confirmed the settings update.").put("readback", readback); }
            catch (Exception error) { throw new java.util.concurrent.CompletionException(error); }
        });
    }

    private CompletableFuture<org.json.JSONObject> executeRelayPlan(
        QcNativeStateDecoder.PlannedGatewayWrite plan, long timeoutMs
    ) {
        if (plan.midi) return relayMidi(plan.controller, plan.value).thenApply(result -> {
            try { return result.put("accepted", true).put("verified", false).put("detail", plan.detail)
                .put("verification", "accepted_unverified"); }
            catch (Exception error) { throw new java.util.concurrent.CompletionException(error); }
        });
        CompletableFuture<org.json.JSONObject> result = new CompletableFuture<>();
        long stateBeforeWrite;
        synchronized (stateEventLock) { stateBeforeWrite = nextStateSequence - 1; }
        long deadline = monotonicMillis() + timeoutMs;
        PendingGatewayTransaction operation = new PendingGatewayTransaction(
            plan, stateBeforeWrite, deadline);
        QcPendingOperations.Entry<PendingGatewayTransaction> pending = null;
        try {
            org.json.JSONObject verification = new org.json.JSONObject(plan.verificationJson);
            if (!plan.realtime && !"none".equals(verification.optString("kind"))) {
                pending = pendingOperations.register(operation, result);
            }
        } catch (Exception error) {
            result.completeExceptionally(error);
            return result;
        }
        QcPendingOperations.Entry<PendingGatewayTransaction> registered = pending;
        commandIo.execute(() -> {
            try {
                if (!isReady()) throw new RelayException("NOT_CONNECTED", "Quad Cortex USB disconnected before the write.");
                org.json.JSONObject verification = new org.json.JSONObject(plan.verificationJson);
                for (QcNativeStateDecoder.EncodedMessage message : plan.messages) writeMessage(message);
                if (plan.realtime || "none".equals(verification.optString("kind"))) {
                    result.complete(new org.json.JSONObject().put("accepted", true).put("verified", false)
                        .put("detail", plan.detail).put("verification", "accepted_unverified"));
                } else {
                    long currentSequence;
                    synchronized (stateEventLock) { currentSequence = nextStateSequence - 1; }
                    resolvePendingGatewayTransactions(currentSequence, monotonicMillis());
                    pendingOperations.timeout(registered, timeoutMs, keepalive,
                        () -> new RelayException("READBACK_TIMEOUT", "The QC did not confirm the requested state in time."));
                }
            } catch (Exception error) {
                if (registered != null) pendingOperations.remove(registered);
                result.completeExceptionally(error);
            }
        });
        if (registered != null) {
            for (long refreshDelay : new long[] {250, 1500, 4000, 7000}) {
                keepalive.schedule(() -> commandIo.execute(() -> {
                    if (result.isDone() || !isReady()) return;
                    try {
                        writeMessage(stateDecoder.currentPresetCommand(requestIds.getAndIncrement()));
                    } catch (Exception ignored) {
                        // Passive state updates and the original timeout remain active.
                    }
                }), refreshDelay, TimeUnit.MILLISECONDS);
            }
        }
        if (registered != null && plan.retryable) {
            keepalive.schedule(() -> {
                if (result.isDone()) return;
                commandIo.execute(() -> {
                    if (result.isDone() || !isReady()) return;
                    try {
                        for (QcNativeStateDecoder.EncodedMessage message : plan.messages) {
                            writeMessage(message, !includeReportId);
                        }
                        Thread.sleep(250);
                        writeMessage(stateDecoder.currentPresetCommand(requestIds.getAndIncrement()));
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                    } catch (Exception ignored) {
                        // The original verification timeout remains authoritative.
                    }
                });
            }, Math.max(250, timeoutMs / 3), TimeUnit.MILLISECONDS);
        }
        return result;
    }

    private CompletableFuture<org.json.JSONObject> relayGatewayWorkflow(
        String method, org.json.JSONObject params
    ) throws Exception {
        return executeRelayWorkflow(
            stateDecoder.gatewayWorkflow(method, JSObject.fromJSONObject(params)), 0);
    }

    private CompletableFuture<org.json.JSONObject> relayGatewayRead(
        String method, org.json.JSONObject params
    ) throws Exception {
        if ("device.captureScreen".equals(method) || "device.presetScreenshot".equals(method)
            || "device.captures".equals(method) || "device.irs".equals(method)) {
            org.json.JSONObject readParams = new org.json.JSONObject(params.toString());
            return relayReconnect("USB session refreshed for high-volume read").thenCompose(ignored -> {
                try {
                    return restoreUsbSessionAfterHighVolumeRead(
                        relayGatewayReadOnCurrentSession(method, readParams));
                }
                catch (Exception error) { return failedRelay("DEVICE_ERROR", error.getMessage()); }
            });
        }
        return relayGatewayReadOnCurrentSession(method, params);
    }

    private CompletableFuture<org.json.JSONObject> restoreUsbSessionAfterHighVolumeRead(
        CompletableFuture<org.json.JSONObject> read
    ) {
        return read.handle((value, readError) ->
            relayReconnect("USB session restored after high-volume read").handle((ignored, reconnectError) -> {
                if (readError != null) throw new CompletionException(readError);
                if (reconnectError != null) throw new CompletionException(reconnectError);
                return value;
            })
        ).thenCompose(result -> result);
    }

    private CompletableFuture<org.json.JSONObject> relayGatewayReadOnCurrentSession(
        String method, org.json.JSONObject params
    ) throws Exception {
        long requestId = requestIds.getAndIncrement();
        QcNativeStateDecoder.PlannedGatewayRead plan = stateDecoder.gatewayRead(
            method, JSObject.fromJSONObject(params), requestId);
        CompletableFuture<org.json.JSONObject> result = new CompletableFuture<>();
        QcPendingOperations.Entry<PendingGatewayRead> pending = pendingOperations.register(
            new PendingGatewayRead(plan), result);
        commandIo.execute(() -> {
            try {
                if (!isReady()) throw new RelayException("NOT_CONNECTED", "Quad Cortex USB disconnected before the read.");
                for (QcNativeStateDecoder.EncodedMessage message : plan.messages) writeMessage(message);
            } catch (Exception error) {
                pendingOperations.remove(pending);
                result.completeExceptionally(error);
            }
        });
        pendingOperations.timeout(pending, plan.timeoutMs, keepalive,
            () -> new RelayException("READBACK_TIMEOUT", "The QC did not provide the requested reply in time."));
        return result;
    }

    private CompletableFuture<org.json.JSONObject> relaySetDeviceName(org.json.JSONObject params) throws Exception {
        String expectedName = params.optString("name", "");
        return relayPlannedGatewayWrite(
            "device.setDeviceName", params, QcUsbProfile.COMMAND_CONFIRMATION_TIMEOUT_MS)
            .thenCompose(ignored -> {
                try { return relayGatewayRead("device.identity", new org.json.JSONObject()); }
                catch (Exception error) { return failedRelay("DEVICE_ERROR", error.getMessage()); }
            })
            .thenCompose(identity -> expectedName.equals(identity.optString("customName", ""))
                ? CompletableFuture.completedFuture(identity)
                : failedRelay("READBACK_MISMATCH", "The Quad Cortex did not confirm the requested device name."));
    }

    private CompletableFuture<org.json.JSONObject> relayTapScreen(org.json.JSONObject params) throws Exception {
        return relayGatewayRead("device.captureScreen", new org.json.JSONObject())
            .thenCompose(ignored -> {
                try {
                    return relayPlannedGatewayWrite(
                        "device.tapScreen", params, QcUsbProfile.COMMAND_CONFIRMATION_TIMEOUT_MS);
                }
                catch (Exception error) { return failedRelay("DEVICE_ERROR", error.getMessage()); }
            });
    }

    private CompletableFuture<org.json.JSONObject> relayPreviewParameter(String method, org.json.JSONObject params) throws Exception {
        double value = params.optDouble("value", Double.NaN);
        return relayPlannedGatewayWrite(
            method, params, QcUsbProfile.COMMAND_CONFIRMATION_TIMEOUT_MS)
            .thenApply(result -> {
                try {
                    return result.put("acceptedValue", value);
                } catch (org.json.JSONException error) {
                    throw new IllegalStateException("Could not encode the parameter preview result.", error);
                }
            });
    }

    private CompletableFuture<org.json.JSONObject> executeRelayWorkflow(
        QcNativeStateDecoder.PlannedGatewayWorkflow workflow, int stageIndex
    ) {
        if (stageIndex >= workflow.stages.size()) {
            try {
                stateDecoder.recordSavedPreset(workflow);
                return CompletableFuture.completedFuture(new org.json.JSONObject()
                    .put("accepted", true).put("verified", true).put("detail", workflow.detail)
                    .put("observedAt", lastStateAt));
            } catch (Exception error) {
                return failedRelay("DEVICE_ERROR", error.getMessage());
            }
        }
        QcNativeStateDecoder.PlannedGatewayStage stage = workflow.stages.get(stageIndex);
        QcNativeStateDecoder.PlannedGatewayWrite write = new QcNativeStateDecoder.PlannedGatewayWrite(
            workflow.detail, stage.verificationJson, false, 0, 0, false, false, stage.messages);
        return executeRelayPlan(write, stage.timeoutMs)
            .thenCompose(ignored -> settleGatewayStage(stage.settleMs))
            .thenCompose(ignored -> executeRelayWorkflow(workflow, stageIndex + 1));
    }

    private CompletableFuture<Void> settleGatewayStage(long settleMs) {
        if (settleMs <= 0) return CompletableFuture.completedFuture(null);
        CompletableFuture<Void> settled = new CompletableFuture<>();
        keepalive.schedule(() -> settled.complete(null), settleMs, TimeUnit.MILLISECONDS);
        return settled;
    }

    private interface RelayJsonRead { org.json.JSONObject get() throws Exception; }

    private CompletableFuture<org.json.JSONObject> relayPresetLibraryRead(
        String method, org.json.JSONObject params
    ) throws Exception {
        boolean refresh = params.optBoolean("refresh", false);
        if (refresh && !params.optBoolean("_freshUsbSession", false)) {
            org.json.JSONObject readParams = new org.json.JSONObject(params.toString())
                .put("_freshUsbSession", true);
            return relayReconnect("USB session refreshed for preset catalog").thenCompose(ignored -> {
                try { return relayPresetLibraryRead(method, readParams); }
                catch (Exception error) { return failedRelay("DEVICE_ERROR", error.getMessage()); }
            });
        }
        RelayJsonRead read = () -> {
            if ("device.listPresetFolders".equals(method)) return stateDecoder.presetFolders();
            if ("device.listPresetSlots".equals(method)) return stateDecoder.presetSlots();
            String requestedSetlist = firstText(params, "setlistKey", "setlist_key");
            String setlistKey = requestedSetlist == null ? currentSetlist : requestedSetlist;
            if (setlistKey == null) throw new IllegalStateException("No active preset setlist has been synchronized.");
            return stateDecoder.presetList(setlistKey);
        };
        if (!refresh) {
            try {
                org.json.JSONObject cached = read.get();
                org.json.JSONArray folders = cached.optJSONArray("folders");
                if (!"device.listPresetFolders".equals(method) || folders != null && folders.length() > 0)
                    return CompletableFuture.completedFuture(cached);
            } catch (Exception ignored) {}
        }
        long before = lastPresetLibraryAt;
        CompletableFuture<org.json.JSONObject> result = new CompletableFuture<>();
        QcPendingOperations.Entry<PendingPresetLibraryRead> pending = pendingOperations.register(
            new PendingPresetLibraryRead(read, before), result);
        commandIo.execute(() -> {
            try {
                if (!isReady()) throw new RelayException("NOT_CONNECTED", "Quad Cortex USB disconnected before the catalog read.");
                writeMessage(stateDecoder.readCommand(4));
            } catch (Exception error) {
                pendingOperations.remove(pending);
                result.completeExceptionally(error);
            }
        });
        pendingOperations.timeout(pending, QcUsbProfile.PRESET_SYNC_TIMEOUT_MS, keepalive, () -> {
            android.util.Log.w("QcUsbPlugin", "Preset catalog timeout: sent=" + messagesSent
                + " received=" + messagesReceived + " lastType=" + lastMessageType
                + " decodeErrors=" + decodeErrors + " negativeReads=" + negativeReads
                + " includeReportId=" + includeReportId + " lastError=" + lastError);
            return new RelayException("READBACK_TIMEOUT", "The QC did not provide the requested preset catalog in time.");
        });
        return result;
    }

    private CompletableFuture<org.json.JSONObject> relayMidi(int controller, int value) {
        if (value < 0 || value > 127) return failedRelay("INVALID_ARGUMENT", "MIDI value is outside the supported range.");
        if (midiOutputEndpoint == null) return failedRelay("MIDI_NOT_AVAILABLE", "Quad Cortex USB-MIDI is unavailable.");
        CompletableFuture<org.json.JSONObject> result = new CompletableFuture<>();
        long queuedAt = System.currentTimeMillis();
        midiIo.execute(() -> {
            try {
                lastMidiQueueDelayMs = Math.max(0, System.currentTimeMillis() - queuedAt);
                maxMidiQueueDelayMs = Math.max(maxMidiQueueDelayMs, lastMidiQueueDelayMs);
                long remaining = QcUsbProfile.PERFORMANCE_MIDI_GAP_MS - (System.currentTimeMillis() - lastMidiCommandAt);
                if (remaining > 0) Thread.sleep(remaining);
                byte[] packet = {
                    (byte) QcUsbProfile.MIDI_USB_EVENT_PACKET_HEADER,
                    (byte) QcUsbProfile.MIDI_CONTROL_CHANGE_STATUS,
                    (byte) controller,
                    (byte) value
                };
                UsbDeviceConnection activeMidiConnection = midiConnection;
                if (activeMidiConnection == null) throw new RelayException("MIDI_NOT_AVAILABLE", "Quad Cortex USB-MIDI disconnected before the write.");
                int written = activeMidiConnection.bulkTransfer(midiOutputEndpoint, packet, packet.length, MIDI_WRITE_TIMEOUT_MS);
                lastMidiCommandAt = System.currentTimeMillis();
                if (written != packet.length) throw new RelayException("MIDI_WRITE_FAILED", "The complete MIDI packet was not written.");
                result.complete(new org.json.JSONObject()
                    .put("accepted", true).put("verified", false)
                    .put("verification", "accepted_unverified")
                    .put("detail", "Performance MIDI command accepted; live USB state will reconcile the result."));
            } catch (Exception error) { result.completeExceptionally(error); }
        });
        return result;
    }

    private org.json.JSONObject relaySnapshot() throws Exception {
        org.json.JSONObject snapshot = stateDecoder.snapshot();
        snapshot.put("connected", isReady()).put("synchronized", presetSynchronized)
            .put("position", snapshot.optInt("presetPosition", currentPosition))
            .put("observedAt", lastStateAt);
        if (currentMasterVolume < 0) snapshot.put("masterVolume", org.json.JSONObject.NULL);
        return snapshot;
    }

    private static String firstText(org.json.JSONObject value, String... keys) {
        for (String key : keys) { String text = value.optString(key, "").trim(); if (!text.isEmpty()) return text; }
        return null;
    }

    private static int firstInt(org.json.JSONObject primary, org.json.JSONObject fallback, String... keys) {
        for (String key : keys) { if (primary.has(key)) return primary.optInt(key, -1); if (fallback.has(key)) return fallback.optInt(key, -1); }
        return -1;
    }

    @PluginMethod
    public void scan(PluginCall call) {
        JSArray found = new JSArray();
        for (UsbDevice candidate : manager.getDeviceList().values()) {
            if (!isQuadCortex(candidate)) continue;
            JSObject entry = new JSObject();
            entry.put("deviceId", candidate.getDeviceId());
            entry.put("name", candidate.getProductName() == null ? getContext().getString(R.string.device_name) : candidate.getProductName());
            entry.put("manufacturer", candidate.getManufacturerName());
            entry.put("permission", manager.hasPermission(candidate));
            entry.put("interfaces", candidate.getInterfaceCount());
            found.put(entry);
        }
        JSObject result = new JSObject();
        result.put("devices", found);
        result.put("connected", connection != null && handshakeComplete);
        result.put("synchronized", connection != null && handshakeComplete && presetSynchronized && currentSetlist != null);
        call.resolve(result);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        UsbDevice candidate = findQuadCortex();
        if (candidate == null) {
            call.reject("No Quad Cortex was found over USB.", "DEVICE_NOT_FOUND");
            return;
        }
        if (isReady() && device != null && device.getDeviceId() == candidate.getDeviceId()) {
            resolveConnected(call, candidate);
            return;
        }
        if (connecting) {
            call.reject("The Quad Cortex USB connection is already starting.", "CONNECT_IN_PROGRESS");
            return;
        }
        if (manager.hasPermission(candidate)) {
            openAndHandshake(candidate, call);
            return;
        }
        pendingConnect = call;
        PendingIntent permissionIntent = PendingIntent.getBroadcast(
            getContext(), 0, new Intent(USB_PERMISSION).setPackage(getContext().getPackageName()),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        manager.requestPermission(candidate, permissionIntent);
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        closeConnection();
        call.resolve();
    }

    @PluginMethod
    public void diagnostics(PluginCall call) {
        JSObject result = new JSObject();
        result.put("connected", connection != null);
        result.put("device", device == null || device.getProductName() == null ? getContext().getString(R.string.device_name) : device.getProductName());
        result.put("messagesReceived", messagesReceived);
        result.put("rawReportsReceived", rawReportsReceived);
        result.put("messagesSent", messagesSent);
        result.put("decodeErrors", decodeErrors);
        result.put("expectedWriteStalls", expectedWriteStalls);
        result.put("lastMessageType", lastMessageType);
        result.put("connectedAt", connectedAt);
        result.put("setlistKnown", currentSetlist != null);
        result.put("presetPosition", currentPosition);
        result.put("modelCount", stateDecoder.modelCount());
        result.put("readAttempts", readAttempts);
        result.put("negativeReads", negativeReads);
        result.put("interfaceId", selectedInterfaceId);
        result.put("inputEndpointAddress", selectedInputEndpointAddress);
        result.put("inputMaxPacketSize", selectedInputMaxPacketSize);
        result.put("reportBytes", includeReportId
            ? QcNativeStateDecoder.REPORT_SIZE
            : QcNativeStateDecoder.REPORT_SIZE - 1);
        result.put("midiAvailable", midiOutputEndpoint != null);
        result.put("separateMidiConnection", midiConnection != null && midiConnection != connection);
        result.put("midiInterfaceId", midiInterface == null ? -1 : midiInterface.getId());
        result.put("midiOutputEndpointAddress", midiOutputEndpoint == null ? -1 : midiOutputEndpoint.getAddress());
        result.put("lastMidiQueueDelayMs", lastMidiQueueDelayMs);
        result.put("maxMidiQueueDelayMs", maxMidiQueueDelayMs);
        result.put("lastStateAt", lastStateAt);
        result.put("lastHidWriteDurationMs", lastHidWriteDurationMs);
        result.put("lastHidWriteResult", lastHidWriteResult);
        result.put("lastHidWriteIncludedReportId", lastHidWriteIncludedReportId);
        if (lastGatewayReadMismatch != null) result.put("lastGatewayReadMismatch", lastGatewayReadMismatch);
        UsbRequest[] inputRequests = activeInputRequests;
        result.put("readerRequestActive", inputRequests != null && inputRequests.length > 0);
        result.put("readerRequestCount", inputRequests == null ? 0 : inputRequests.length);
        result.put("readerWaiting", readerWaiting);
        result.put("readerExitedAt", readerExitedAt);
        if (lastReaderError != null) result.put("lastReaderError", lastReaderError);
        if (lastError != null) result.put("lastError", lastError);
        call.resolve(result);
    }

    @PluginMethod
    public void gatewayInvoke(PluginCall call) {
        String method = call.getString("method", "");
        if (!GeneratedGatewayMethods.contains(method)) {
            call.reject("The requested gateway method is not part of the generated contract.", "METHOD_NOT_ALLOWED");
            return;
        }
        JSObject params = call.getObject("params");
        JSObject expected = call.getObject("expectedState");
        relayInvoke(method, params == null ? new JSObject() : params,
            expected == null ? new JSObject() : expected).whenComplete((result, error) -> {
                if (error == null) {
                    try {
                        GeneratedGatewayMethods.validateResult(method, result);
                        call.resolve(JSObject.fromJSONObject(result));
                    }
                    catch (Exception conversionError) {
                        call.reject("The gateway result did not match the generated contract.", "MALFORMED_RESPONSE", conversionError);
                    }
                }
                else if (error instanceof RelayException) {
                    RelayException relayError = (RelayException) error;
                    call.reject(error.getMessage(), relayError.code, relayError,
                        new JSObject().put("retryable", relayError.retryable()));
                }
                else if (error instanceof Exception)
                    call.reject(error.getMessage() == null ? "The gateway operation failed." : error.getMessage(),
                        "DEVICE_ERROR", (Exception) error);
                else call.reject("The gateway operation failed.", "DEVICE_ERROR");
            });
    }

    private void openAndHandshake(UsbDevice candidate, PluginCall call) {
        synchronized (this) {
            if (isReady() && device != null && device.getDeviceId() == candidate.getDeviceId()) {
                resolveConnected(call, candidate);
                return;
            }
            if (connecting) {
                call.reject("The Quad Cortex USB connection is already starting.", "CONNECT_IN_PROGRESS");
                return;
            }
            connecting = true;
        }
        commandIo.execute(() -> {
            try {
                openDeviceAndHandshake(candidate, null);
                resolveConnected(call, candidate);
            } catch (Exception error) {
                lastError = error.getMessage();
                closeConnection();
                call.reject(error.getMessage(), "USB_CONNECT_FAILED", error);
            } finally {
                connecting = false;
            }
        });
    }

    private void openDeviceAndHandshake(
        UsbDevice candidate, QcPendingOperations.Entry<?> preservedOperation
    ) throws Exception {
        closeConnection(preservedOperation);
        UsbInterface selected = null;
        UsbEndpoint selectedInput = null;
        for (int index = 0; index < candidate.getInterfaceCount(); index++) {
            UsbInterface iface = candidate.getInterface(index);
            if (iface.getInterfaceClass() != UsbConstants.USB_CLASS_HID) continue;
            UsbEndpoint candidateInput = null;
            for (int endpointIndex = 0; endpointIndex < iface.getEndpointCount(); endpointIndex++) {
                UsbEndpoint endpoint = iface.getEndpoint(endpointIndex);
                if (endpoint.getDirection() == UsbConstants.USB_DIR_IN && endpoint.getType() == UsbConstants.USB_ENDPOINT_XFER_INT) candidateInput = endpoint;
            }
            if (iface.getId() == 5) {
                selected = iface;
                selectedInput = candidateInput;
                break;
            }
            if (selected == null) {
                selected = iface;
                selectedInput = candidateInput;
            }
        }
        if (selected == null) throw new IllegalStateException("The Quad Cortex HID interface was not found.");
        if (selectedInput == null) throw new IllegalStateException("The Quad Cortex HID input endpoint was not found.");
        UsbDeviceConnection opened = manager.openDevice(candidate);
        if (opened == null || !opened.claimInterface(selected, true)) {
            if (opened != null) opened.close();
            throw new IllegalStateException("Could not claim the Quad Cortex HID interface.");
        }
        UsbInterface selectedMidi = null;
        UsbEndpoint selectedMidiOutput = null;
        for (int index = 0; index < candidate.getInterfaceCount(); index++) {
            UsbInterface iface = candidate.getInterface(index);
            if (iface.getInterfaceClass() != UsbConstants.USB_CLASS_AUDIO || iface.getInterfaceSubclass() != 3) continue;
            for (int endpointIndex = 0; endpointIndex < iface.getEndpointCount(); endpointIndex++) {
                UsbEndpoint endpoint = iface.getEndpoint(endpointIndex);
                if (endpoint.getDirection() == UsbConstants.USB_DIR_OUT && endpoint.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK) {
                    selectedMidi = iface;
                    selectedMidiOutput = endpoint;
                    break;
                }
            }
            if (selectedMidiOutput != null) break;
        }
        if (selectedMidi != null) {
            UsbDeviceConnection openedMidi = manager.openDevice(candidate);
            if (openedMidi != null && openedMidi.claimInterface(selectedMidi, true)) {
                midiConnection = openedMidi;
                midiInterface = selectedMidi;
                midiOutputEndpoint = selectedMidiOutput;
            } else if (openedMidi != null) {
                openedMidi.close();
            }
        }
        device = candidate;
        connection = opened;
        hidInterface = selected;
        inputEndpoint = selectedInput;
        selectedInterfaceId = selected.getId();
        selectedInputEndpointAddress = selectedInput.getAddress();
        selectedInputMaxPacketSize = selectedInput.getMaxPacketSize();
        messagesReceived = 0;
        rawReportsReceived = 0;
        messagesSent = 0;
        decodeErrors = 0;
        expectedWriteStalls = 0;
        lastMessageType = -1;
        lastError = null;
        readAttempts = 0;
        negativeReads = 0;
        connectedAt = System.currentTimeMillis();
        lastMidiCommandAt = 0;
        lastMidiQueueDelayMs = 0;
        maxMidiQueueDelayMs = 0;
        lastStateAt = 0;
        readerWaiting = false;
        readerExitedAt = 0;
        lastReaderError = null;
        lastPresetLibraryAt = 0;
        stateDecoder.sessionOpened(connectedAt);
        startReader();
        performHandshake();
    }

    private void resolveConnected(PluginCall call, UsbDevice candidate) {
        JSObject result = new JSObject();
        result.put("connected", true);
        result.put("synchronized", presetSynchronized && currentSetlist != null);
        result.put("name", candidate.getProductName() == null ? getContext().getString(R.string.device_name) : candidate.getProductName());
        result.put("deviceId", candidate.getDeviceId());
        call.resolve(result);
    }

    private boolean isReady() {
        return connection != null && handshakeComplete;
    }

    private void performHandshake() {
        int attempts = 0;
        boolean answered = false;
        while (!answered) {
            int reportMode = stateDecoder.nextHandshakeAttempt(System.currentTimeMillis());
            if (reportMode == -2) break;
            if (reportMode == -1) continue;
            attempts++;
            // Prefer the same 129-byte logical HID report used by the proven
            // Windows path. Retain the 128-byte fallback for Android USB stacks
            // that expose SET_REPORT's data stage without the report-ID byte.
            includeReportId = reportMode == 1;
            String session = UUID.randomUUID().toString().replace("-", "");
            resetReply = new CountDownLatch(1);
            long requestId = requestIds.getAndIncrement();
            try {
                writeMessage(stateDecoder.resetCommand(requestId, session));
            } catch (Exception error) {
                throw new IllegalStateException("Could not encode the QC USB reset command.", error);
            }
            try {
                answered = resetReply.await(QcUsbProfile.HANDSHAKE_ATTEMPT_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("The Quad Cortex USB handshake was interrupted.", error);
            } finally {
                resetReply = null;
            }
        }
        if (!answered) throw new IllegalStateException("The Quad Cortex did not answer after " + attempts + " USB handshake attempts.");
        stateDecoder.sessionHandshakeComplete(System.currentTimeMillis());
        try {
            for (QcNativeStateDecoder.EncodedMessage message : stateDecoder.initializationCommands()) {
                writeMessage(message);
            }
        } catch (Exception error) {
            throw new IllegalStateException("Could not encode the QC USB initialization commands.", error);
        }
        handshakeComplete = true;
        // The QC's initial burst can finish before the first five-second
        // maintenance deadline. Prime one reply-producing read while that
        // interrupt stream is still active, then let the shared session clock
        // maintain the normal five-second cadence.
        keepalive.schedule(() -> commandIo.execute(() -> {
            if (!isReady() || !pendingOperations.isEmpty()) return;
            try { writeMessage(stateDecoder.readCommand(10)); } catch (Exception ignored) {}
        }), MAINTENANCE_POLL_MS, TimeUnit.MILLISECONDS);
    }

    private synchronized void writeMessage(QcNativeStateDecoder.EncodedMessage message) {
        writeMessage(message, includeReportId);
    }

    private synchronized void writeMessage(
        QcNativeStateDecoder.EncodedMessage message, boolean withReportId
    ) {
        for (byte[] framedReport : stateDecoder.encodeFrame(message)) {
            byte[] report = withReportId
                ? framedReport
                : Arrays.copyOfRange(framedReport, 1, framedReport.length);
            if (connection == null || hidInterface == null) throw new IllegalStateException("Quad Cortex USB disconnected during write.");
            long writeStartedAt = System.currentTimeMillis();
            int written = connection.controlTransfer(0x21, 0x09, (2 << 8) | QcNativeStateDecoder.OUT_REPORT_ID, hidInterface.getId(), report, report.length, HID_WRITE_TIMEOUT_MS);
            lastHidWriteDurationMs = System.currentTimeMillis() - writeStartedAt;
            lastHidWriteResult = written;
            lastHidWriteIncludedReportId = withReportId;
            // The QC accepts the complete 128-byte data stage, then deliberately
            // STALLs SET_REPORT's status stage. Android surfaces that as -1,
            // exactly as hidapi does on the hardware-verified desktop path.
            if (written < 0) expectedWriteStalls++;
            else if (written != report.length) {
                lastError = "USB HID write returned " + written + " of " + report.length + " bytes.";
                throw new IllegalStateException(lastError);
            }
        }
        messagesSent++;
        stateDecoder.sessionOutbound(System.currentTimeMillis());
    }

    private void startReader() {
        if (inputEndpoint == null) return;
        reading = true;
        long generation = connectionGeneration.incrementAndGet();
        readerIo.execute(() -> {
            UsbDeviceConnection activeConnection = connection;
            UsbEndpoint activeEndpoint = inputEndpoint;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                readInputReportsAsync(activeConnection, activeEndpoint, generation);
                return;
            }
            while (readerIsActive(activeConnection, generation)) {
                byte[] buffer = new byte[QcNativeStateDecoder.REPORT_SIZE];
                readAttempts++;
                int count = activeConnection.bulkTransfer(activeEndpoint, buffer, buffer.length, 250);
                if (count <= 0) {
                    if (count < 0) negativeReads++;
                    continue;
                }
                consumeInputReport(buffer, count);
            }
        });
    }

    private boolean readerIsActive(UsbDeviceConnection activeConnection, long generation) {
        return reading && generation == connectionGeneration.get() && connection == activeConnection;
    }

    @TargetApi(Build.VERSION_CODES.O)
    private void readInputReportsAsync(
        UsbDeviceConnection activeConnection, UsbEndpoint activeEndpoint, long generation
    ) {
        UsbRequest[] requests = new UsbRequest[HID_INPUT_REQUEST_DEPTH];
        try {
            for (int index = 0; index < requests.length; index++) {
                UsbRequest request = new UsbRequest();
                if (!request.initialize(activeConnection, activeEndpoint)) {
                    lastError = "Could not initialize QC HID input request " + (index + 1) + ".";
                    return;
                }
                ByteBuffer buffer = ByteBuffer.allocateDirect(QcNativeStateDecoder.REPORT_SIZE);
                request.setClientData(buffer);
                requests[index] = request;
            }
            activeInputRequests = requests;
            for (int index = 0; index < requests.length; index++) {
                ByteBuffer buffer = (ByteBuffer) requests[index].getClientData();
                if (!requests[index].queue(buffer)) {
                    lastError = "Could not queue QC HID input request " + (index + 1) + ".";
                    return;
                }
            }
            while (readerIsActive(activeConnection, generation)) {
                readerWaiting = true;
                UsbRequest completed = null;
                while (completed == null && readerIsActive(activeConnection, generation)) {
                    readAttempts++;
                    try { completed = activeConnection.requestWait(); }
                    finally { readerWaiting = false; }
                }
                if (!readerIsActive(activeConnection, generation)) return;
                ByteBuffer buffer = (ByteBuffer) completed.getClientData();
                if (buffer == null) {
                    lastError = "The QC HID input request ended without a matching completion.";
                    return;
                }
                int count = buffer.position();
                if (count > 0) {
                    buffer.flip();
                    byte[] bytes = new byte[count];
                    buffer.get(bytes);
                    consumeInputReport(bytes, count);
                }
                buffer.clear();
                if (!completed.queue(buffer)) {
                    lastError = "Could not requeue a QC HID input request.";
                    return;
                }
            }
        } catch (Exception error) {
            if (readerIsActive(activeConnection, generation)) {
                lastReaderError = error.getClass().getName() + ": " + error.getMessage();
                lastError = "QC HID reader stopped: " + lastReaderError;
                android.util.Log.e("QcUsbPlugin", lastError, error);
            }
        } finally {
            boolean recoverReader = readerIsActive(activeConnection, generation);
            readerWaiting = false;
            readerExitedAt = System.currentTimeMillis();
            if (activeInputRequests == requests) activeInputRequests = null;
            for (UsbRequest request : requests) if (request != null) {
                try { request.cancel(); } catch (Exception ignored) {}
                try { request.close(); } catch (Exception ignored) {}
            }
            if (recoverReader) {
                handshakeComplete = false;
                scheduleAutomaticReconnect("QC HID reader recovered after interruption");
            }
        }
    }

    private void consumeInputReport(byte[] buffer, int count) {
        rawReportsReceived += 1;
        QcPendingOperations.Entry<PendingBackup> activeBackup = pendingBackup;
        if (activeBackup != null) {
            activeBackup.operation.rawReports += 1;
            activeBackup.operation.lastRawReportBytes = count;
        }
        byte[] report = normalizeInputReport(buffer, count);
        DecodedMessage decoded = decodeMessage(report);
        if (decoded == null) return;
        if (activeBackup != null) activeBackup.operation.decodedMessages += 1;
        messagesReceived++;
        lastMessageType = decoded.messageType;
        if (decoded.messageType == 4) {
            android.util.Log.i("QcUsbPlugin", "Received preset catalog frame");
            lastPresetLibraryAt = System.currentTimeMillis();
            schedulePresetLibrarySettlement();
        }
        if (decoded.messageType == QcUsbProfile.MESSAGE_TYPE_DEVICE_VERSION && resetReply != null) resetReply.countDown();
        dispatchGatewayResponse(decoded.messageType, decoded.payload);
        publishStateBatch(decoded.states, decoded.tempoClock);
    }

    private static byte[] normalizeInputReport(byte[] buffer, int count) {
        // Android's raw interrupt endpoint reports the 128-byte HID body, while
        // some vendor stacks can return the 129-byte report-ID-prefixed form.
        // The body's first byte is its chunk length and may legitimately equal
        // the inbound report ID (notably a final one-byte chunk), so the byte
        // value alone cannot distinguish the two layouts.
        if (count == QcNativeStateDecoder.REPORT_SIZE
            && buffer[0] == QcNativeStateDecoder.IN_REPORT_ID) {
            byte[] result = new byte[count];
            System.arraycopy(buffer, 0, result, 0, count);
            return result;
        }
        byte[] result = new byte[count + 1];
        result[0] = 1;
        System.arraycopy(buffer, 0, result, 1, count);
        return result;
    }

    private DecodedMessage decodeMessage(byte[] report) {
        try {
            QcNativeStateDecoder.DecodedFrame frame = stateDecoder.pushReport(report);
            if (frame == null) return null;
            int type = frame.messageType;
            byte[] payload = frame.payload;
            // ModelRepo expands on its own lane and installs atomically in the
            // same shared Rust decoder used for all realtime state.
            if (type == QcUsbProfile.MESSAGE_TYPE_MODEL_REPO) {
                scheduleModelCatalogDecode(payload, connectionGeneration.get());
                return new DecodedMessage(type, payload, new ArrayList<>(), null);
            }
            return new DecodedMessage(type, payload, stateDecoder.decode(type, payload),
                type == QcUsbProfile.MESSAGE_TYPE_GLOBAL_TEMPO ? stateDecoder.tempoClock(payload) : null);
        } catch (Exception error) {
            decodeErrors++;
            lastError = error.getMessage();
            android.util.Log.w("QcUsbPlugin", "Could not decode QC HID frame: " + lastError);
            return null;
        }
    }

    private static final class DecodedMessage {
        final int messageType;
        final byte[] payload;
        final List<JSObject> states;
        final JSObject tempoClock;

        DecodedMessage(int messageType, byte[] payload, List<JSObject> states, JSObject tempoClock) {
            this.messageType = messageType;
            this.payload = payload;
            this.states = states;
            this.tempoClock = tempoClock;
        }
    }

    private static final class PendingGatewayRead {
        final QcNativeStateDecoder.PlannedGatewayRead plan;

        PendingGatewayRead(QcNativeStateDecoder.PlannedGatewayRead plan) {
            this.plan = plan;
        }
    }

    private static final class PendingGatewayTransaction {
        final QcNativeStateDecoder.PlannedGatewayWrite plan;
        final long afterSequence;
        final long deadline;

        PendingGatewayTransaction(
            QcNativeStateDecoder.PlannedGatewayWrite plan, long afterSequence,
            long deadline
        ) {
            this.plan = plan;
            this.afterSequence = afterSequence;
            this.deadline = deadline;
        }
    }

    private static final class PendingPresetLibraryRead {
        final RelayJsonRead read;
        final long afterObservedAt;

        PendingPresetLibraryRead(RelayJsonRead read, long afterObservedAt) {
            this.read = read;
            this.afterObservedAt = afterObservedAt;
        }
    }

    private void resolvePendingGatewayTransactions(long observationSequence, long now) {
        for (QcPendingOperations.Entry<PendingGatewayTransaction> entry : pendingOperations.entries(PendingGatewayTransaction.class)) {
            PendingGatewayTransaction pending = entry.operation;
            if (entry.result.isDone()) {
                pendingOperations.remove(entry);
                continue;
            }
            int state = stateDecoder.gatewayTransactionState(
                pending.plan, pending.afterSequence, pending.deadline, observationSequence, now);
            if (state == 0) continue;
            if (!pendingOperations.remove(entry)) continue;
            if (state == 1) {
                try {
                    entry.result.complete(new org.json.JSONObject()
                        .put("accepted", true).put("verified", true)
                        .put("verification", "authoritative_readback")
                        .put("stateSequence", observationSequence).put("detail", pending.plan.detail));
                } catch (Exception error) {
                    entry.result.completeExceptionally(error);
                }
            } else {
                entry.result.completeExceptionally(new RelayException(
                    "READBACK_TIMEOUT", "The QC did not confirm the requested state in time."));
            }
        }
    }

    private void resolvePendingPresetLibraryReads(long observedAt) {
        for (QcPendingOperations.Entry<PendingPresetLibraryRead> entry : pendingOperations.entries(PendingPresetLibraryRead.class)) {
            PendingPresetLibraryRead pending = entry.operation;
            if (entry.result.isDone() || observedAt <= pending.afterObservedAt) continue;
            try {
                org.json.JSONObject value = pending.read.get();
                if (pendingOperations.remove(entry)) {
                    entry.result.complete(value);
                }
            } catch (Exception ignored) {
                // The decoder may still be assembling a multi-message catalog.
                // A later type-4 event will retry this read without polling.
            }
        }
    }

    private void schedulePresetLibrarySettlement() {
        if (!presetLibrarySettlementScheduled.compareAndSet(false, true)) return;
        keepalive.schedule(this::settlePresetLibraryReads, 250, TimeUnit.MILLISECONDS);
    }

    private void settlePresetLibraryReads() {
        long observedAt = lastPresetLibraryAt;
        long quietFor = System.currentTimeMillis() - observedAt;
        if (quietFor < 250) {
            keepalive.schedule(this::settlePresetLibraryReads, 250 - quietFor, TimeUnit.MILLISECONDS);
            return;
        }
        presetLibrarySettlementScheduled.set(false);
        resolvePendingPresetLibraryReads(observedAt);
        // Do not lose a catalog frame that raced with clearing the scheduled flag.
        if (lastPresetLibraryAt > observedAt) schedulePresetLibrarySettlement();
    }

    private void dispatchGatewayResponse(int messageType, byte[] payload) {
        if (messageType == QcUsbProfile.MESSAGE_TYPE_BACKUP) {
            QcPendingOperations.Entry<PendingBackup> pending = pendingBackup;
            if (pending != null && !pending.operation.recoveryStarted) {
                try {
                    JSObject update = stateDecoder.consumeBackupChunk(payload, pending.operation.name);
                    int chunks = update.getInteger("chunks", pending.operation.chunks);
                    int ignored = update.getInteger("ignoredPrefixChunks", pending.operation.ignoredPrefixChunks);
                    if (chunks > pending.operation.chunks || ignored > pending.operation.ignoredPrefixChunks) pending.operation.lastActivityAt = System.currentTimeMillis();
                    pending.operation.chunks = chunks;
                    pending.operation.ignoredPrefixChunks = ignored;
                    pending.operation.started = update.getBoolean("started", pending.operation.started);
                    if (update.getBoolean("complete", false) && pendingBackup == pending) {
                        pending.operation.recoveryStarted = true;
                        pending.operation.recoveryAfterState = lastStateAt;
                        org.json.JSONObject document = (org.json.JSONObject) update.get("backup");
                        metadataIo.execute(() -> {
                            try {
                                pending.operation.savedResult = saveBackupDocument(document, pending.operation.name);
                                commandIo.execute(() -> {
                                    try { writeMessage(stateDecoder.readCommand(17)); }
                                    catch (Exception error) { failPendingBackupRecovery(pending, error); }
                                });
                            } catch (Exception error) {
                                failPendingBackupRecovery(pending, error);
                            }
                        });
                    }
                } catch (Exception error) {
                    if (pendingBackup == pending) pendingBackup = null;
                    pendingOperations.remove(pending);
                    pending.result.completeExceptionally(error);
                }
            }
        }
        for (QcPendingOperations.Entry<PendingGatewayRead> entry : pendingOperations.entries(PendingGatewayRead.class)) {
            PendingGatewayRead pending = entry.operation;
            if (pending.plan.responseType != messageType || entry.result.isDone()) continue;
            try {
                org.json.JSONObject value = stateDecoder.decodeGatewayResponse(pending.plan, payload);
                lastGatewayReadMismatch = null;
                if (pendingOperations.remove(entry)) entry.result.complete(value);
            } catch (Exception error) {
                lastGatewayReadMismatch = "type " + messageType + ": " + error.getMessage();
                // A response type may be shared by unrelated or differently
                // correlated device messages. Keep waiting for this plan's
                // shared Rust projection to accept the matching reply.
            }
        }
    }

    private void publishStateBatch(List<JSObject> decodedStates, JSObject tempoClock) {
        if (decodedStates.isEmpty() && tempoClock == null) return;
        long observedAt = System.currentTimeMillis();
        lastStateAt = observedAt;
        long sequence;
        synchronized (stateEventLock) { sequence = nextStateSequence++; }
        JSArray states = new JSArray();
        boolean masterObserved = false;
        for (JSObject state : decodedStates) {
            String kind = state.getString("kind", "");
            if ("master".equals(kind) && state.has("masterVolume")) {
                masterObserved = true;
                double volume = state.optDouble("masterVolume", -1);
                currentMasterVolume = volume < 0 ? -1 : (int) Math.round(volume <= 1 ? volume * 100 : volume);
            }
            else if ("position".equals(kind)) {
                currentSetlist = state.getString("setlistKey", currentSetlist);
                currentPosition = state.getInteger("position", currentPosition);
                currentSetlistFactory = state.getBoolean("isFactory", currentSetlistFactory);
            } else if ("preset".equals(kind)) {
                presetSynchronized = true;
                currentPresetName = state.getString("presetName", currentPresetName);
            }
            state.put("observedAt", observedAt);
            states.put(state);
        }
        stateDecoder.sessionStateObserved(observedAt, presetSynchronized);
        if (masterObserved) completePendingBackupRecovery(observedAt);
        resolvePendingReady();
        resolvePendingGatewayTransactions(sequence, monotonicMillis());
        JSObject frame = new JSObject();
        frame.put("observedAt", observedAt);
        frame.put("states", states);
        synchronized (stateEventLock) {
            frame.put("sequence", sequence);
            if (tempoClock != null) {
                frame.put("tempoClock", tempoClock);
                latestTempoClock = new JSObject()
                    .put("available", true)
                    .put("sequence", sequence)
                    .put("receivedAtUnixMs", observedAt)
                    .put("currentBeat", tempoClock.getInteger("currentBeat"))
                    .put("currentBar", tempoClock.getInteger("currentBar"))
                    .put("currentTick", tempoClock.getInteger("currentTick"));
            }
            stateEventLog.addLast(frame);
            while (stateEventLog.size() > QcDomain.STATE_EVENT_MAXIMUM_LIMIT) stateEventLog.removeFirst();
        }
        notifyListeners("qcStateBatch", frame, true);
    }

    private void completePendingBackupRecovery(long observedAt) {
        QcPendingOperations.Entry<PendingBackup> pending = pendingBackup;
        if (pending == null || !pending.operation.recoveryStarted
            || pending.operation.savedResult == null
            || observedAt <= pending.operation.recoveryAfterState
            || !isReady() || !presetSynchronized || currentSetlist == null) return;
        pendingBackup = null;
        if (pendingOperations.remove(pending)) pending.result.complete(pending.operation.savedResult);
    }

    private void failPendingBackupRecovery(
        QcPendingOperations.Entry<PendingBackup> pending, Exception error
    ) {
        if (pendingBackup == pending) pendingBackup = null;
        if (pendingOperations.remove(pending)) pending.result.completeExceptionally(error);
    }

    private void scheduleModelCatalogDecode(byte[] payload, long generation) {
        metadataIo.execute(() -> {
            try {
                if (generation != connectionGeneration.get() || connection == null) return;
                List<JSObject> states = stateDecoder.installModelRepo(payload);
                if (generation != connectionGeneration.get()) return;
                publishStateBatch(states, null);
            } catch (Exception error) {
                decodeErrors++;
                lastError = error.getMessage();
            }
        });
    }

    private UsbDevice findQuadCortex() {
        for (UsbDevice candidate : manager.getDeviceList().values()) if (isQuadCortex(candidate)) return candidate;
        return null;
    }

    private static boolean isQuadCortex(UsbDevice candidate) {
        return candidate.getVendorId() == QcUsbProfile.VENDOR_ID && candidate.getProductId() == QcUsbProfile.PRODUCT_ID;
    }

    private synchronized void closeConnection() {
        closeConnection(null);
    }

    private synchronized void closeConnection(QcPendingOperations.Entry<?> preservedOperation) {
        reading = false;
        handshakeComplete = false;
        presetSynchronized = false;
        connectionGeneration.incrementAndGet();
        UsbRequest[] inputRequests = activeInputRequests;
        if (inputRequests != null) {
            activeInputRequests = null;
            for (UsbRequest inputRequest : inputRequests) if (inputRequest != null) {
                try { inputRequest.cancel(); } catch (Exception ignored) {}
                try { inputRequest.close(); } catch (Exception ignored) {}
            }
        }
        if (midiConnection != null) {
            if (midiInterface != null) midiConnection.releaseInterface(midiInterface);
            midiConnection.close();
        }
        midiConnection = null;
        if (connection != null) {
            if (hidInterface != null) connection.releaseInterface(hidInterface);
            connection.close();
        }
        connection = null;
        device = null;
        hidInterface = null;
        inputEndpoint = null;
        midiInterface = null;
        midiOutputEndpoint = null;
        currentSetlist = null;
        currentPosition = -1;
        currentSetlistFactory = false;
        currentPresetName = null;
        currentMasterVolume = -1;
        pendingOperations.failAllExcept(preservedOperation, () -> new RelayException(
            "NOT_CONNECTED", "Quad Cortex USB disconnected during a pending operation."));
        pendingBackup = null;
        if (pendingReady != preservedOperation) pendingReady = null;
        synchronized (stateEventLock) {
            stateEventLog.clear();
            nextStateSequence = 1;
            latestTempoClock = null;
        }
        connectedAt = 0;
        lastPresetLibraryAt = 0;
        stateDecoder.sessionDisconnected(System.currentTimeMillis());
        stateDecoder.reset();
    }

    @Override
    protected void handleOnDestroy() {
        if (relaySession == this) relaySession = null;
        closeConnection();
        readerIo.shutdownNow();
        commandIo.shutdownNow();
        midiIo.shutdownNow();
        metadataIo.shutdownNow();
        keepalive.shutdownNow();
        try { getContext().unregisterReceiver(permissionReceiver); } catch (Exception ignored) {}
        try { getContext().unregisterReceiver(deviceReceiver); } catch (Exception ignored) {}
        super.handleOnDestroy();
    }
}
