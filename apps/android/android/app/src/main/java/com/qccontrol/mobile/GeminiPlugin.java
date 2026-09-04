package com.qccontrol.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.FutureCallback;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.firebase.ai.FirebaseAI;
import com.google.firebase.ai.GenerativeModel;
import com.google.firebase.ai.java.GenerativeModelFutures;
import com.google.firebase.ai.type.Content;
import com.google.firebase.ai.type.GenerateContentResponse;
import com.google.firebase.ai.type.GenerativeBackend;
import com.google.firebase.ai.type.GenerationConfig;
import com.google.firebase.ai.type.UsageMetadata;
import androidx.core.content.ContextCompat;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executor;
import java.util.concurrent.ConcurrentHashMap;

@CapacitorPlugin(name = "Gemini")
public class GeminiPlugin extends Plugin {
    private static final String DEFAULT_MODEL = "gemini-3.7-flash";
    private static final Set<String> ALLOWED_MODELS = new HashSet<>(Arrays.asList(
        DEFAULT_MODEL,
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite"
    ));
    private final Map<String, GenerativeModelFutures> models = new ConcurrentHashMap<>();
    private GenerationConfig generationConfig;

    @Override
    public void load() {
        generationConfig = new GenerationConfig.Builder()
            .setTemperature(0.2f)
            .setMaxOutputTokens(320)
            .setResponseMimeType("application/json")
            .build();
    }

    private GenerativeModelFutures modelFor(String modelName) {
        return models.computeIfAbsent(modelName, name -> {
            GenerativeModel nativeModel = FirebaseAI.getInstance(GenerativeBackend.googleAI())
                .generativeModel(name, generationConfig);
            return GenerativeModelFutures.from(nativeModel);
        });
    }

    @com.getcapacitor.PluginMethod
    public void generate(PluginCall call) {
        String prompt = call.getString("prompt", "").trim();
        if (prompt.isEmpty()) {
            call.reject("A prompt is required.", "INVALID_PROMPT");
            return;
        }
        if (prompt.length() > 6000) {
            call.reject("The request is too large.", "PROMPT_TOO_LARGE");
            return;
        }
        String modelName = call.getString("model", DEFAULT_MODEL).trim();
        if (!ALLOWED_MODELS.contains(modelName)) {
            call.reject("That Gemini model is not enabled in QC Control.", "INVALID_MODEL");
            return;
        }
        Content content = new Content.Builder().addText(prompt).build();
        ListenableFuture<GenerateContentResponse> request = modelFor(modelName).generateContent(content);
        Executor executor = ContextCompat.getMainExecutor(getContext());
        Futures.addCallback(request, new FutureCallback<GenerateContentResponse>() {
            @Override
            public void onSuccess(GenerateContentResponse response) {
                String text = response.getText();
                if (text == null || text.isBlank()) {
                    call.reject("Gemini returned an empty response.", "EMPTY_RESPONSE");
                    return;
                }
                JSObject result = new JSObject();
                result.put("text", text);
                result.put("model", modelName);
                result.put("modelVersion", response.getModelVersion());
                UsageMetadata usage = response.getUsageMetadata();
                int outputTokens = usage == null || usage.getCandidatesTokenCount() == null
                    ? 0 : usage.getCandidatesTokenCount();
                result.put("inputTokens", usage == null ? 0 : usage.getPromptTokenCount());
                result.put("outputTokens", outputTokens);
                result.put("thinkingTokens", usage == null ? 0 : usage.getThoughtsTokenCount());
                result.put("totalTokens", usage == null ? 0 : usage.getTotalTokenCount());
                call.resolve(result);
            }

            @Override
            public void onFailure(Throwable error) {
                Exception exception = error instanceof Exception
                    ? (Exception) error
                    : new Exception(error);
                call.reject(error.getMessage() == null ? "Gemini request failed." : error.getMessage(), "GEMINI_ERROR", exception);
            }
        }, executor);
    }
}
