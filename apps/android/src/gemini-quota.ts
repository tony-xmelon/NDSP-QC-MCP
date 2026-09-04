export type GeminiModelId = "gemini-3.7-flash" | "gemini-3.6-flash" | "gemini-3.5-flash" | "gemini-3.5-flash-lite" | "gemini-3.1-flash-lite";

export type TokenUsage = { input: number; output: number; thinking: number; total: number };
export type GeminiQuotaEntry = TokenUsage & { day: string; requests: number; recent: Array<{ at: number; input: number }> };
export type GeminiQuotaLedger = Partial<Record<GeminiModelId, GeminiQuotaEntry>>;

export const geminiQuotaLimits: Record<GeminiModelId, { requestsPerMinute: number; requestsPerDay: number; inputTokensPerMinute: number }> = {
  "gemini-3.7-flash": { requestsPerMinute: 5, requestsPerDay: 20, inputTokensPerMinute: 250_000 },
  "gemini-3.6-flash": { requestsPerMinute: 5, requestsPerDay: 20, inputTokensPerMinute: 250_000 },
  "gemini-3.5-flash": { requestsPerMinute: 5, requestsPerDay: 20, inputTokensPerMinute: 250_000 },
  "gemini-3.5-flash-lite": { requestsPerMinute: 15, requestsPerDay: 500, inputTokensPerMinute: 250_000 },
  "gemini-3.1-flash-lite": { requestsPerMinute: 15, requestsPerDay: 500, inputTokensPerMinute: 250_000 }
};

const emptyTokens: TokenUsage = { input: 0, output: 0, thinking: 0, total: 0 };

export function pacificQuotaDay(at = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(at));
}

export function currentQuotaEntry(entry: GeminiQuotaEntry | undefined, at = Date.now()): GeminiQuotaEntry {
  const day = pacificQuotaDay(at);
  if (!entry || entry.day !== day) return { ...emptyTokens, day, requests: 0, recent: [] };
  return { ...entry, recent: entry.recent.filter((request) => at - request.at < 60_000) };
}

export function recordGeminiUsage(entry: GeminiQuotaEntry | undefined, usage: TokenUsage, at = Date.now()): GeminiQuotaEntry {
  const current = currentQuotaEntry(entry, at);
  return {
    day: current.day,
    requests: current.requests + 1,
    recent: [...current.recent, { at, input: usage.input }],
    input: current.input + usage.input,
    output: current.output + usage.output,
    thinking: current.thinking + usage.thinking,
    total: current.total + usage.total
  };
}

export function quotaSummary(model: GeminiModelId, entry: GeminiQuotaEntry | undefined, at = Date.now()) {
  const usage = currentQuotaEntry(entry, at);
  const limits = geminiQuotaLimits[model];
  const minuteRequests = usage.recent.length;
  const minuteInput = usage.recent.reduce((sum, request) => sum + request.input, 0);
  return {
    usage,
    dayRemaining: Math.max(0, limits.requestsPerDay - usage.requests),
    minuteRemaining: Math.max(0, limits.requestsPerMinute - minuteRequests),
    minuteInputRemaining: Math.max(0, limits.inputTokensPerMinute - minuteInput),
    limits
  };
}
