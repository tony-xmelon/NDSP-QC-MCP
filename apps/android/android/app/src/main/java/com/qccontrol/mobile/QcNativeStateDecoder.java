package com.qccontrol.mobile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Narrow JNI facade over the shared Rust protocol/state engine. */
final class QcNativeStateDecoder implements AutoCloseable {
    static { System.loadLibrary("qc_android"); }

    static final int REPORT_SIZE = nativeReportSize();
    static final int OUT_REPORT_ID = nativeOutboundReportId();
    static final int IN_REPORT_ID = nativeInboundReportId();

    static final class EncodedMessage {
        final int messageType;
        final byte[] payload;

        EncodedMessage(int messageType, byte[] payload) {
            this.messageType = messageType;
            this.payload = payload;
        }
    }

    static final class DecodedFrame {
        final int messageType;
        final byte[] payload;

        DecodedFrame(int messageType, byte[] payload) {
            this.messageType = messageType;
            this.payload = payload;
        }
    }

    static final class PlannedGatewayWrite {
        final String detail;
        final String verificationJson;
        final boolean midi;
        final int controller;
        final int value;
        final List<EncodedMessage> messages;

        PlannedGatewayWrite(String detail, String verificationJson, boolean midi, int controller, int value, List<EncodedMessage> messages) {
            this.detail = detail;
            this.verificationJson = verificationJson;
            this.midi = midi;
            this.controller = controller;
            this.value = value;
            this.messages = messages;
        }
    }

    static final class PlannedGatewayStage {
        final long timeoutMs;
        final String verificationJson;
        final List<EncodedMessage> messages;

        PlannedGatewayStage(long timeoutMs, String verificationJson, List<EncodedMessage> messages) {
            this.timeoutMs = timeoutMs;
            this.verificationJson = verificationJson;
            this.messages = messages;
        }
    }

    static final class PlannedGatewayWorkflow {
        final String detail;
        final String savedName;
        final String setlistKey;
        final int position;
        final int instrument;
        final List<PlannedGatewayStage> stages;

        PlannedGatewayWorkflow(
            String detail, String savedName, String setlistKey, int position, int instrument,
            List<PlannedGatewayStage> stages
        ) {
            this.detail = detail;
            this.savedName = savedName;
            this.setlistKey = setlistKey;
            this.position = position;
            this.instrument = instrument;
            this.stages = stages;
        }
    }

    static final class PlannedGatewayRead {
        final int responseType;
        final long timeoutMs;
        final String projectionJson;
        final List<EncodedMessage> messages;

        PlannedGatewayRead(int responseType, long timeoutMs, String projectionJson, List<EncodedMessage> messages) {
            this.responseType = responseType;
            this.timeoutMs = timeoutMs;
            this.projectionJson = projectionJson;
            this.messages = messages;
        }
    }

    private static final class DecodedEnvelope {
        final List<EncodedMessage> messages;
        final int nextOffset;

        DecodedEnvelope(List<EncodedMessage> messages, int nextOffset) {
            this.messages = messages;
            this.nextOffset = nextOffset;
        }
    }

    private long handle = nativeCreate();

    List<JSObject> decode(int messageType, byte[] payload) throws Exception {
        return objects(nativeDecode(requireHandle(), messageType, payload));
    }

    List<JSObject> installModelRepo(byte[] payload) throws Exception {
        return objects(nativeInstallModelRepo(requireHandle(), payload));
    }

    JSObject blockDetails(int row, int column) throws Exception {
        return new JSObject(nativeBlockDetails(requireHandle(), row, column));
    }

    JSObject laneControlDetails(int row, String control) throws Exception {
        return new JSObject(nativeLaneControlDetails(requireHandle(), row, control));
    }

    JSObject snapshot() throws Exception { return new JSObject(nativeSnapshot(requireHandle())); }
    JSObject modelList() throws Exception { return new JSObject(nativeModelList(requireHandle())); }
    JSObject presetFolders() throws Exception { return new JSObject(nativePresetFolders(requireHandle())); }
    JSObject presetList(String setlistKey) throws Exception { return new JSObject(nativePresetList(requireHandle(), setlistKey)); }
    JSObject presetSlots() throws Exception { return new JSObject(nativePresetSlots(requireHandle())); }
    JSObject mergeExpectedState(JSObject params, JSObject expected) throws Exception {
        return new JSObject(nativeMergeExpectedState(params.toString(), expected.toString()));
    }

    int modelCount() { return nativeModelCount(requireHandle()); }

    void sessionOpened(long nowMs) { nativeSessionOpened(requireHandle(), nowMs); }
    int nextHandshakeAttempt(long nowMs) { return nativeNextHandshakeAttempt(requireHandle(), nowMs); }
    void sessionHandshakeComplete(long nowMs) { nativeSessionHandshakeComplete(requireHandle(), nowMs); }
    void sessionStateObserved(long nowMs, boolean presetSynchronized) {
        nativeSessionStateObserved(requireHandle(), nowMs, presetSynchronized ? 1 : 0);
    }
    boolean sessionShouldKeepalive(long nowMs) {
        return nativeSessionShouldKeepalive(requireHandle(), nowMs) == 1;
    }
    void sessionOutbound(long nowMs) { nativeSessionOutbound(requireHandle(), nowMs); }
    void sessionDisconnected(long nowMs) { nativeSessionDisconnected(requireHandle(), nowMs); }

    EncodedMessage resetCommand(long requestId, String sessionId) throws Exception {
        return one("reset", new JSObject().put("requestId", requestId).put("sessionId", sessionId));
    }

    List<EncodedMessage> initializationCommands() throws Exception {
        return commands("initialize", new JSObject());
    }

    EncodedMessage readCommand(int messageType) throws Exception {
        return one("read", new JSObject().put("messageType", messageType));
    }

    EncodedMessage keepaliveCommand() throws Exception {
        return one("keepalive", new JSObject());
    }

    EncodedMessage backupCommand() throws Exception {
        return one("backup", new JSObject());
    }

    JSObject tempoClock(byte[] payload) throws Exception {
        String json = nativeTempoClock(payload);
        return "null".equals(json) ? null : new JSObject(json);
    }

    JSObject consumeBackupChunk(byte[] payload, String name) throws Exception {
        return new JSObject(nativeConsumeBackupChunk(requireHandle(), payload, name));
    }

    List<EncodedMessage> gatewayCommands(String method, JSObject args) throws Exception {
        return gatewayPlan(method, args).messages;
    }

    PlannedGatewayWrite gatewayPlan(String method, JSObject args) throws Exception {
        byte[] encoded = nativePlanGatewayWrite(requireHandle(), method, args.toString());
        if (encoded.length < 12) throw new IllegalStateException("Native QC gateway plan is truncated.");
        int detailLength = littleEndianInt(encoded, 0);
        if (detailLength < 0 || 4 + detailLength + 8 > encoded.length) {
            throw new IllegalStateException("Native QC gateway detail is truncated.");
        }
        String detail = new String(encoded, 4, detailLength, StandardCharsets.UTF_8);
        int verificationOffset = 4 + detailLength;
        int verificationLength = littleEndianInt(encoded, verificationOffset);
        int laneOffset = verificationOffset + 4 + verificationLength;
        int commandOffset = laneOffset + 3;
        if (verificationLength < 0 || commandOffset + 4 > encoded.length) {
            throw new IllegalStateException("Native QC gateway verification is truncated.");
        }
        String verificationJson = new String(encoded, verificationOffset + 4, verificationLength, StandardCharsets.UTF_8);
        int lane = Byte.toUnsignedInt(encoded[laneOffset]);
        if (lane > 1) throw new IllegalStateException("Native QC gateway execution lane is invalid.");
        return new PlannedGatewayWrite(
            detail, verificationJson, lane == 1, Byte.toUnsignedInt(encoded[laneOffset + 1]),
            Byte.toUnsignedInt(encoded[laneOffset + 2]), decodeCommandEnvelope(encoded, commandOffset));
    }

    int gatewayTransactionState(
        PlannedGatewayWrite plan, long afterObservedAtMs, long deadlineMs,
        long observedAtMs, long nowMs
    ) {
        return nativeGatewayTransactionState(
            requireHandle(), plan.verificationJson, afterObservedAtMs,
            deadlineMs, observedAtMs, nowMs);
    }

    PlannedGatewayWorkflow gatewayWorkflow(String method, JSObject args) throws Exception {
        byte[] encoded = nativePlanGatewayWorkflow(requireHandle(), method, args.toString());
        if (encoded.length < 12) throw new IllegalStateException("Native QC gateway workflow is truncated.");
        int detailLength = littleEndianInt(encoded, 0);
        if (detailLength < 0 || 4 + detailLength + 8 > encoded.length)
            throw new IllegalStateException("Native QC gateway workflow detail is truncated.");
        String detail = new String(encoded, 4, detailLength, StandardCharsets.UTF_8);
        int offset = 4 + detailLength;
        int completionLength = littleEndianInt(encoded, offset);
        offset += 4;
        if (completionLength < 0 || offset + completionLength + 4 > encoded.length)
            throw new IllegalStateException("Native QC gateway workflow completion metadata is truncated.");
        JSObject completion = new JSObject(new String(encoded, offset, completionLength, StandardCharsets.UTF_8));
        offset += completionLength;
        int count = littleEndianInt(encoded, offset);
        offset += 4;
        if (count < 0) throw new IllegalStateException("Native QC gateway workflow stage count is invalid.");
        List<PlannedGatewayStage> stages = new ArrayList<>(count);
        for (int index = 0; index < count; index++) {
            if (offset + 12 > encoded.length) throw new IllegalStateException("Native QC gateway workflow stage is truncated.");
            long timeoutMs = littleEndianLong(encoded, offset);
            offset += 8;
            int verificationLength = littleEndianInt(encoded, offset);
            offset += 4;
            if (verificationLength < 0 || offset + verificationLength + 4 > encoded.length)
                throw new IllegalStateException("Native QC gateway workflow verification is truncated.");
            String verificationJson = new String(encoded, offset, verificationLength, StandardCharsets.UTF_8);
            offset += verificationLength;
            DecodedEnvelope messages = decodeCommandEnvelopeAt(encoded, offset);
            offset = messages.nextOffset;
            stages.add(new PlannedGatewayStage(timeoutMs, verificationJson, messages.messages));
        }
        if (offset != encoded.length) throw new IllegalStateException("Native QC gateway workflow has trailing data.");
        return new PlannedGatewayWorkflow(
            detail, completion.getString("savedName"), completion.getString("setlistKey"),
            completion.getInteger("position"), completion.getInteger("instrument"), stages);
    }

    void recordSavedPreset(PlannedGatewayWorkflow workflow) {
        nativeRecordSavedPreset(
            requireHandle(), workflow.setlistKey, workflow.position, workflow.savedName, workflow.instrument);
    }

    PlannedGatewayRead gatewayRead(String method, JSObject args, long requestId) throws Exception {
        byte[] encoded = nativePlanGatewayRead(method, args.toString(), requestId);
        if (encoded.length < 18) throw new IllegalStateException("Native QC gateway read plan is truncated.");
        int responseType = (encoded[0] & 0xff) | ((encoded[1] & 0xff) << 8);
        long timeoutMs = littleEndianLong(encoded, 2);
        int projectionLength = littleEndianInt(encoded, 10);
        int commandOffset = 14 + projectionLength;
        if (projectionLength < 0 || commandOffset + 4 > encoded.length)
            throw new IllegalStateException("Native QC gateway response projection is truncated.");
        String projectionJson = new String(encoded, 14, projectionLength, StandardCharsets.UTF_8);
        return new PlannedGatewayRead(responseType, timeoutMs, projectionJson,
            decodeCommandEnvelope(encoded, commandOffset));
    }

    JSObject decodeGatewayResponse(PlannedGatewayRead plan, byte[] payload) throws Exception {
        return new JSObject(nativeDecodeGatewayResponse(plan.projectionJson, payload));
    }

    List<byte[]> encodeFrame(EncodedMessage message) {
        byte[] encoded = nativeEncodeFrame(message.messageType, message.payload);
        if (encoded.length == 0 || encoded.length % REPORT_SIZE != 0) {
            throw new IllegalStateException("Native QC framing returned an invalid report sequence.");
        }
        List<byte[]> reports = new ArrayList<>(encoded.length / REPORT_SIZE);
        for (int offset = 0; offset < encoded.length; offset += REPORT_SIZE) {
            reports.add(Arrays.copyOfRange(encoded, offset, offset + REPORT_SIZE));
        }
        return reports;
    }

    DecodedFrame pushReport(byte[] report) {
        byte[] decoded = nativePushReport(requireHandle(), report);
        if (decoded.length == 0) return null;
        if (decoded.length < 2) throw new IllegalStateException("Native QC framing returned no message trailer.");
        int messageType = (decoded[0] & 0xff) | ((decoded[1] & 0xff) << 8);
        return new DecodedFrame(messageType, Arrays.copyOfRange(decoded, 2, decoded.length));
    }

    synchronized void reset() { nativeReset(requireHandle()); }

    @Override
    public synchronized void close() {
        if (handle == 0) return;
        nativeDestroy(handle);
        handle = 0;
    }

    private synchronized long requireHandle() {
        if (handle == 0) throw new IllegalStateException("Native QC decoder is closed.");
        return handle;
    }

    private EncodedMessage one(String command, JSObject args) throws Exception {
        List<EncodedMessage> messages = commands(command, args);
        if (messages.size() != 1) throw new IllegalStateException("Native QC command did not produce exactly one message.");
        return messages.get(0);
    }

    private List<EncodedMessage> commands(String command, JSObject args) throws Exception {
        return decodeCommandEnvelope(nativeEncodeCommand(requireHandle(), command, args.toString()));
    }

    private List<EncodedMessage> decodeCommandEnvelope(byte[] encoded) {
        return decodeCommandEnvelope(encoded, 0);
    }

    private List<EncodedMessage> decodeCommandEnvelope(byte[] encoded, int start) {
        DecodedEnvelope decoded = decodeCommandEnvelopeAt(encoded, start);
        if (decoded.nextOffset != encoded.length) throw new IllegalStateException("Native QC command envelope has trailing data.");
        return decoded.messages;
    }

    private static DecodedEnvelope decodeCommandEnvelopeAt(byte[] encoded, int start) {
        if (start < 0 || start + 4 > encoded.length) throw new IllegalStateException("Native QC command envelope is truncated.");
        int count = littleEndianInt(encoded, start);
        int offset = start + 4;
        List<EncodedMessage> messages = new ArrayList<>(count);
        for (int index = 0; index < count; index++) {
            if (offset + 6 > encoded.length) throw new IllegalStateException("Native QC command envelope is truncated.");
            int messageType = (encoded[offset] & 0xff) | ((encoded[offset + 1] & 0xff) << 8);
            int length = littleEndianInt(encoded, offset + 2);
            offset += 6;
            if (length < 0 || offset + length > encoded.length) throw new IllegalStateException("Native QC command payload is truncated.");
            messages.add(new EncodedMessage(messageType, Arrays.copyOfRange(encoded, offset, offset + length)));
            offset += length;
        }
        return new DecodedEnvelope(messages, offset);
    }

    private static int littleEndianInt(byte[] value, int offset) {
        return (value[offset] & 0xff) | ((value[offset + 1] & 0xff) << 8) |
            ((value[offset + 2] & 0xff) << 16) | ((value[offset + 3] & 0xff) << 24);
    }

    private static long littleEndianLong(byte[] value, int offset) {
        long result = 0;
        for (int index = 0; index < 8; index++) result |= (long) (value[offset + index] & 0xff) << (index * 8);
        return result;
    }

    private static List<JSObject> objects(String json) throws Exception {
        JSArray values = new JSArray(json);
        List<JSObject> result = new ArrayList<>();
        for (int index = 0; index < values.length(); index++) {
            result.add(JSObject.fromJSONObject((JSONObject) values.get(index)));
        }
        return result;
    }

    private static native long nativeCreate();
    private static native String nativeMergeExpectedState(String paramsJson, String expectedJson);
    private static native int nativeReportSize();
    private static native int nativeOutboundReportId();
    private static native int nativeInboundReportId();
    private static native byte[] nativeEncodeCommand(long handle, String command, String argsJson);
    private static native byte[] nativePlanGatewayWrite(long handle, String method, String argsJson);
    private static native byte[] nativePlanGatewayWorkflow(long handle, String method, String argsJson);
    private static native void nativeRecordSavedPreset(long handle, String setlistKey, int position, String name, int instrument);
    private static native byte[] nativePlanGatewayRead(String method, String argsJson, long requestId);
    private static native String nativeDecodeGatewayResponse(String projectionJson, byte[] payload);
    private static native String nativeTempoClock(byte[] payload);
    private static native String nativeConsumeBackupChunk(long handle, byte[] payload, String name);
    private static native int nativeGatewayTransactionState(
        long handle, String verificationJson, long afterObservedAtMs,
        long deadlineMs, long observedAtMs, long nowMs);
    private static native byte[] nativeEncodeFrame(int messageType, byte[] payload);
    private static native byte[] nativePushReport(long handle, byte[] report);
    private static native void nativeReset(long handle);
    private static native void nativeDestroy(long handle);
    private static native String nativeDecode(long handle, int messageType, byte[] payload);
    private static native String nativeInstallModelRepo(long handle, byte[] payload);
    private static native String nativeBlockDetails(long handle, int row, int column);
    private static native String nativeLaneControlDetails(long handle, int row, String control);
    private static native String nativeSnapshot(long handle);
    private static native int nativeModelCount(long handle);
    private static native String nativeModelList(long handle);
    private static native String nativePresetFolders(long handle);
    private static native String nativePresetList(long handle, String setlistKey);
    private static native String nativePresetSlots(long handle);
    private static native void nativeSessionOpened(long handle, long nowMs);
    private static native int nativeNextHandshakeAttempt(long handle, long nowMs);
    private static native void nativeSessionHandshakeComplete(long handle, long nowMs);
    private static native void nativeSessionStateObserved(long handle, long nowMs, int presetSynchronized);
    private static native int nativeSessionShouldKeepalive(long handle, long nowMs);
    private static native void nativeSessionOutbound(long handle, long nowMs);
    private static native void nativeSessionDisconnected(long handle, long nowMs);
}
