package com.qccontrol.mobile;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.Locale;

@CapacitorPlugin(
    name = "VoiceInput",
    permissions = @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
)
public class VoiceInputPlugin extends Plugin implements RecognitionListener {
    private SpeechRecognizer recognizer;
    private PluginCall activeCall;

    @PluginMethod
    public void available(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", SpeechRecognizer.isRecognitionAvailable(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphonePermission");
            return;
        }
        beginRecognition(call);
    }

    @PermissionCallback
    private void microphonePermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) beginRecognition(call);
        else call.reject("Microphone permission was denied.", "MICROPHONE_PERMISSION_DENIED");
    }

    private void beginRecognition(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                call.reject("Speech recognition is unavailable on this device.", "VOICE_UNAVAILABLE");
                return;
            }
            if (activeCall != null) activeCall.reject("Voice input was replaced by a new request.", "VOICE_REPLACED");
            activeCall = call;
            if (recognizer != null) recognizer.destroy();
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            recognizer.setRecognitionListener(this);
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag());
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
            recognizer.startListening(intent);
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (recognizer != null) recognizer.stopListening();
            call.resolve();
        });
    }

    @Override public void onReadyForSpeech(Bundle params) { notifyState("listening"); }
    @Override public void onBeginningOfSpeech() { notifyState("hearing"); }
    @Override public void onRmsChanged(float rmsdB) {}
    @Override public void onBufferReceived(byte[] buffer) {}
    @Override public void onEndOfSpeech() { notifyState("processing"); }

    @Override
    public void onError(int error) {
        PluginCall call = activeCall;
        activeCall = null;
        if (call != null) call.reject(errorMessage(error), "VOICE_ERROR_" + error);
        destroyRecognizer();
    }

    @Override
    public void onResults(Bundle results) {
        ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        PluginCall call = activeCall;
        activeCall = null;
        if (call != null) {
            if (matches == null || matches.isEmpty()) call.reject("No speech was recognized.", "NO_SPEECH");
            else {
                JSObject result = new JSObject();
                result.put("transcript", matches.get(0));
                call.resolve(result);
            }
        }
        destroyRecognizer();
    }

    @Override public void onPartialResults(Bundle partialResults) {
        ArrayList<String> matches = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (matches != null && !matches.isEmpty()) {
            JSObject result = new JSObject();
            result.put("transcript", matches.get(0));
            notifyListeners("partialResult", result);
        }
    }
    @Override public void onEvent(int eventType, Bundle params) {}

    private void notifyState(String state) {
        JSObject result = new JSObject();
        result.put("state", state);
        notifyListeners("voiceState", result);
    }

    private void destroyRecognizer() {
        getActivity().runOnUiThread(() -> {
            if (recognizer != null) recognizer.destroy();
            recognizer = null;
            notifyState("idle");
        });
    }

    private static String errorMessage(int error) {
        return switch (error) {
            case SpeechRecognizer.ERROR_AUDIO -> "The microphone could not be opened.";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission is required.";
            case SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Speech recognition needs a working network connection.";
            case SpeechRecognizer.ERROR_NO_MATCH -> "No speech was recognized.";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Speech recognition is already in use.";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech was heard.";
            default -> "Speech recognition failed (" + error + ").";
        };
    }

    @Override
    protected void handleOnDestroy() {
        if (recognizer != null) recognizer.destroy();
        recognizer = null;
        super.handleOnDestroy();
    }
}
