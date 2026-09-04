package com.qccontrol.mobile;

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
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

@CapacitorPlugin(name = "QcUsb")
public class QcUsbPlugin extends Plugin {
    private static final int HID_WRITE_TIMEOUT_MS = 250;
    private static final int MIDI_WRITE_TIMEOUT_MS = 250;
    private static final String USB_PERMISSION = "com.qccontrol.mobile.USB_PERMISSION";

    private UsbManager manager;
    private UsbDevice device;
    private UsbDeviceConnection connection;
    private UsbInterface hidInterface;
    private UsbEndpoint inputEndpoint;
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
            if (!isReady() || !stateDecoder.sessionShouldKeepalive(System.currentTimeMillis())) return;
            // Keepalives share the serialized writer, but only enter the queue
            // after five completely idle seconds. Normal interaction therefore
            // never waits for recurring maintenance traffic.
            commandIo.execute(() -> {
                if (!isReady() || !stateDecoder.sessionShouldKeepalive(System.currentTimeMillis())) return;
                try { writeMessage(stateDecoder.keepaliveCommand()); } catch (Exception ignored) {}
            });
        }, QcUsbProfile.KEEPALIVE_INTERVAL_MS, QcUsbProfile.KEEPALIVE_INTERVAL_MS, TimeUnit.MILLISECONDS);
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
        pendingOperations.timeout(pending, 35_000, keepalive,
            () -> new RelayException("READBACK_TIMEOUT", "The Quad Cortex did not finish synchronizing in time."));
        return result;
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

    private org.json.JSONObject relayStateEvents(org.json.JSONObject params) {
        long after = Math.max(0, params.optLong("afterSequence", 0));
        int limit = Math.max(1, Math.min(4096, params.optInt("limit", 256)));
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
                    "READBACK_TIMEOUT", "The native backup stream stalled after " + operation.chunks + " chunks; the partial document was discarded."));
                return;
            }
            if (operation.attempts >= QcUsbProfile.BACKUP_MAXIMUM_ATTEMPTS) {
                pendingBackup = null;
                if (pendingOperations.remove(pending)) pending.result.completeExceptionally(new RelayException(
                    "READBACK_TIMEOUT", "No native backup document started after " + operation.attempts + " requests and " + operation.ignoredPrefixChunks + " stale chunks."));
                return;
            }
            operation.attempts += 1;
            operation.lastActivityAt = now;
            commandIo.execute(() -> {
                try { writeMessage(stateDecoder.backupCommand()); }
                catch (Exception error) {
                    if (pendingBackup == pending) pendingBackup = null;
                    pendingOperations.remove(pending);
                    pending.result.completeExceptionally(error);
                }
            });
            scheduleBackupWatchdog(pending, QcUsbProfile.BACKUP_FIRST_CHUNK_TIMEOUT_MS);
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
            String dispatch = GeneratedGatewayMethods.dispatchKind(method);
            if ("SYSTEM".equals(dispatch)) {
                return CompletableFuture.completedFuture(new JSObject()
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
                case "PLANNED_WRITE": return relayPlannedGatewayWrite(method, params, 10000);
                case "PRESET_WRITE": return relayPlannedGatewayWrite(method, params, 15000);
                case "PERSISTENT_WRITE": return relayGatewayWorkflow(method, params);
                default: return failedRelay("METHOD_NOT_ALLOWED", "The requested device operation is not supported by Android.");
            }
        } catch (Exception error) { return failedRelay("INVALID_ARGUMENT", error.getMessage() == null ? "Invalid device arguments." : error.getMessage()); }
    }

    private CompletableFuture<org.json.JSONObject> relayPlannedGatewayWrite(
        String method, org.json.JSONObject params, long timeoutMs
    ) throws Exception {
        QcNativeStateDecoder.PlannedGatewayWrite plan = stateDecoder.gatewayPlan(method, JSObject.fromJSONObject(params));
        return executeRelayPlan(plan, timeoutMs, isIdempotentGatewayWrite(method));
    }

    private CompletableFuture<org.json.JSONObject> executeRelayPlan(
        QcNativeStateDecoder.PlannedGatewayWrite plan, long timeoutMs, boolean retryable
    ) {
        if (plan.midi) return relayMidi(plan.controller, plan.value).thenApply(result -> {
            try { return result.put("detail", plan.detail).put("verification", "authoritative_state_pending"); }
            catch (Exception error) { throw new java.util.concurrent.CompletionException(error); }
        });
        CompletableFuture<org.json.JSONObject> result = new CompletableFuture<>();
        long stateBeforeWrite = lastStateAt;
        long deadline = System.currentTimeMillis() + timeoutMs;
        PendingGatewayTransaction operation = new PendingGatewayTransaction(
            plan, stateBeforeWrite, deadline);
        QcPendingOperations.Entry<PendingGatewayTransaction> pending = null;
        try {
            org.json.JSONObject verification = new org.json.JSONObject(plan.verificationJson);
            if (!"none".equals(verification.optString("kind"))) {
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
                if ("none".equals(verification.optString("kind"))) {
                    result.complete(new org.json.JSONObject().put("accepted", true).put("detail", plan.detail)
                        .put("verification", "authoritative_state_pending"));
                } else {
                    resolvePendingGatewayTransactions(lastStateAt, System.currentTimeMillis());
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
        if (registered != null && retryable) {
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

    private static boolean isIdempotentGatewayWrite(String method) {
        switch (method) {
            case "device.selectScene":
            case "device.toggleBypass":
            case "device.setParameter":
            case "device.setLaneControlParameter":
            case "device.setLaneControlSceneMode":
            case "device.setParameterSceneMode":
            case "device.setParameterExpression":
            case "device.setExpressionBypass":
            case "device.setBlockFootswitch":
            case "device.setStompMomentary":
            case "device.setStompLabel":
            case "device.setMidiOut":
            case "device.setPresetLoadMidiOut":
            case "device.setChainInput":
            case "device.setChainOutput":
            case "device.setChainSplit":
            case "device.setTempo":
            case "device.setMasterVolume":
            case "device.selectModeSlot":
            case "device.showTuner":
            case "device.showGigView":
                return true;
            default:
                return false;
        }
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
        // Android reports the QC's normal SET_REPORT status-stage STALL as -1,
        // which is indistinguishable from a transfer the controller never
        // accepted. Correlated reads are idempotent, so retry one unanswered
        // request inside its original deadline. Mutations never use this path.
        keepalive.schedule(() -> {
            if (result.isDone()) return;
            commandIo.execute(() -> {
                if (result.isDone() || !isReady()) return;
                try {
                    for (QcNativeStateDecoder.EncodedMessage message : plan.messages) writeMessage(message);
                } catch (Exception ignored) {
                    // The original timeout remains the authoritative failure.
                }
            });
        }, Math.max(250, plan.timeoutMs / 2), TimeUnit.MILLISECONDS);
        pendingOperations.timeout(pending, plan.timeoutMs, keepalive,
            () -> new RelayException("READBACK_TIMEOUT", "The QC did not provide the requested reply in time."));
        return result;
    }

    private CompletableFuture<org.json.JSONObject> relaySetDeviceName(org.json.JSONObject params) throws Exception {
        String expectedName = params.optString("name", "");
        return relayPlannedGatewayWrite("device.setDeviceName", params, 2500)
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
                try { return relayPlannedGatewayWrite("device.tapScreen", params, 2500); }
                catch (Exception error) { return failedRelay("DEVICE_ERROR", error.getMessage()); }
            });
    }

    private CompletableFuture<org.json.JSONObject> relayPreviewParameter(String method, org.json.JSONObject params) throws Exception {
        double value = params.optDouble("value", Double.NaN);
        return relayPlannedGatewayWrite(method, params, 2500)
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
            workflow.detail, stage.verificationJson, false, 0, 0, stage.messages);
        return executeRelayPlan(write, stage.timeoutMs, false)
            .thenCompose(ignored -> executeRelayWorkflow(workflow, stageIndex + 1));
    }

    private interface RelayJsonRead { org.json.JSONObject get() throws Exception; }

    private CompletableFuture<org.json.JSONObject> relayPresetLibraryRead(
        String method, org.json.JSONObject params
    ) throws Exception {
        RelayJsonRead read = () -> {
            if ("device.listPresetFolders".equals(method)) return stateDecoder.presetFolders();
            if ("device.listPresetSlots".equals(method)) return stateDecoder.presetSlots();
            String requestedSetlist = firstText(params, "setlistKey", "setlist_key");
            String setlistKey = requestedSetlist == null ? currentSetlist : requestedSetlist;
            if (setlistKey == null) throw new IllegalStateException("No active preset setlist has been synchronized.");
            return stateDecoder.presetList(setlistKey);
        };
        boolean refresh = params.optBoolean("refresh", false);
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
        pendingOperations.timeout(pending, 25_000, keepalive, () -> {
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
                byte[] packet = {(byte) 0x0b, (byte) 0xb0, (byte) controller, (byte) value};
                int written = connection.bulkTransfer(midiOutputEndpoint, packet, packet.length, MIDI_WRITE_TIMEOUT_MS);
                lastMidiCommandAt = System.currentTimeMillis();
                if (written != packet.length) throw new RelayException("MIDI_WRITE_FAILED", "The complete MIDI packet was not written.");
                result.complete(new org.json.JSONObject().put("accepted", true));
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
        result.put("reportBytes", includeReportId ? 129 : 128);
        result.put("midiAvailable", midiOutputEndpoint != null);
        result.put("midiInterfaceId", midiInterface == null ? -1 : midiInterface.getId());
        result.put("midiOutputEndpointAddress", midiOutputEndpoint == null ? -1 : midiOutputEndpoint.getAddress());
        result.put("lastMidiQueueDelayMs", lastMidiQueueDelayMs);
        result.put("maxMidiQueueDelayMs", maxMidiQueueDelayMs);
        result.put("lastStateAt", lastStateAt);
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
                    try { call.resolve(JSObject.fromJSONObject(result)); }
                    catch (Exception conversionError) {
                        call.reject("The gateway result was not valid JSON.", "DEVICE_ERROR", conversionError);
                    }
                }
                else if (error instanceof RelayException)
                    call.reject(error.getMessage(), ((RelayException) error).code, (Exception) error);
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
        if (selectedMidi != null && opened.claimInterface(selectedMidi, true)) {
            midiInterface = selectedMidi;
            midiOutputEndpoint = selectedMidiOutput;
        }
        device = candidate;
        connection = opened;
        hidInterface = selected;
        inputEndpoint = selectedInput;
        selectedInterfaceId = selected.getId();
        selectedInputEndpointAddress = selectedInput.getAddress();
        selectedInputMaxPacketSize = selectedInput.getMaxPacketSize();
        messagesReceived = 0;
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
            // Android vendors differ in how their raw USB stack represents a
            // numbered HID SET_REPORT. Try the standards-shaped 129-byte form
            // first, then the 128-byte body-only form, and retain the one that
            // receives the device's correlated reset reply.
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
            int written = connection.controlTransfer(0x21, 0x09, (2 << 8) | QcNativeStateDecoder.OUT_REPORT_ID, hidInterface.getId(), report, report.length, HID_WRITE_TIMEOUT_MS);
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
            while (reading && generation == connectionGeneration.get() && connection != null) {
                byte[] buffer = new byte[QcNativeStateDecoder.REPORT_SIZE];
                readAttempts++;
                int count = connection.bulkTransfer(inputEndpoint, buffer, buffer.length, 250);
                if (count <= 0) {
                    if (count < 0) negativeReads++;
                    continue;
                }
                byte[] report = normalizeInputReport(buffer, count);
                DecodedMessage decoded = decodeMessage(report);
                if (decoded != null) {
                    messagesReceived++;
                    lastMessageType = decoded.messageType;
                    if (decoded.messageType == 4) {
                        android.util.Log.i("QcUsbPlugin", "Received preset catalog frame");
                        lastPresetLibraryAt = System.currentTimeMillis();
                        schedulePresetLibrarySettlement();
                    }
                    if (decoded.messageType == 52 && resetReply != null) resetReply.countDown();
                    dispatchGatewayResponse(decoded.messageType, decoded.payload);
                    publishStateBatch(decoded.states, decoded.tempoClock);
                }
            }
        });
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
            if (type == 51) {
                scheduleModelCatalogDecode(payload, connectionGeneration.get());
                return new DecodedMessage(type, payload, new ArrayList<>(), null);
            }
            return new DecodedMessage(type, payload, stateDecoder.decode(type, payload),
                type == 33 ? stateDecoder.tempoClock(payload) : null);
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
        final long afterObservedAt;
        final long deadline;

        PendingGatewayTransaction(
            QcNativeStateDecoder.PlannedGatewayWrite plan, long afterObservedAt,
            long deadline
        ) {
            this.plan = plan;
            this.afterObservedAt = afterObservedAt;
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

    private void resolvePendingGatewayTransactions(long observedAt, long now) {
        for (QcPendingOperations.Entry<PendingGatewayTransaction> entry : pendingOperations.entries(PendingGatewayTransaction.class)) {
            PendingGatewayTransaction pending = entry.operation;
            if (entry.result.isDone()) {
                pendingOperations.remove(entry);
                continue;
            }
            int state = stateDecoder.gatewayTransactionState(
                pending.plan, pending.afterObservedAt, pending.deadline, observedAt, now);
            if (state == 0) continue;
            if (!pendingOperations.remove(entry)) continue;
            if (state == 1) {
                try {
                    entry.result.complete(new org.json.JSONObject()
                        .put("accepted", true).put("verified", true)
                        .put("observedAt", observedAt).put("detail", pending.plan.detail));
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
        if (messageType == 40) {
            QcPendingOperations.Entry<PendingBackup> pending = pendingBackup;
            if (pending != null) {
                try {
                    JSObject update = stateDecoder.consumeBackupChunk(payload, pending.operation.name);
                    int chunks = update.getInteger("chunks", pending.operation.chunks);
                    int ignored = update.getInteger("ignoredPrefixChunks", pending.operation.ignoredPrefixChunks);
                    if (chunks > pending.operation.chunks || ignored > pending.operation.ignoredPrefixChunks) pending.operation.lastActivityAt = System.currentTimeMillis();
                    pending.operation.chunks = chunks;
                    pending.operation.ignoredPrefixChunks = ignored;
                    pending.operation.started = update.getBoolean("started", pending.operation.started);
                    if (update.getBoolean("complete", false) && pendingBackup == pending) {
                        pendingBackup = null;
                        if (pendingOperations.remove(pending)) {
                            org.json.JSONObject document = (org.json.JSONObject) update.get("backup");
                            metadataIo.execute(() -> {
                                try { pending.result.complete(saveBackupDocument(document, pending.operation.name)); }
                                catch (Exception error) { pending.result.completeExceptionally(error); }
                            });
                        }
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
                if (pendingOperations.remove(entry)) entry.result.complete(value);
            } catch (Exception ignored) {
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
        JSArray states = new JSArray();
        for (JSObject state : decodedStates) {
            String kind = state.getString("kind", "");
            if ("master".equals(kind) && state.has("masterVolume")) {
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
        resolvePendingReady();
        resolvePendingGatewayTransactions(observedAt, observedAt);
        JSObject frame = new JSObject();
        frame.put("observedAt", observedAt);
        frame.put("states", states);
        synchronized (stateEventLock) {
            long sequence = nextStateSequence++;
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
            while (stateEventLog.size() > 4096) stateEventLog.removeFirst();
        }
        notifyListeners("qcStateBatch", frame, true);
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
        if (connection != null) {
            if (midiInterface != null) connection.releaseInterface(midiInterface);
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
