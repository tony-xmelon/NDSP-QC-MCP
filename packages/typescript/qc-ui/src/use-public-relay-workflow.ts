import { useCallback, useEffect, useState } from "react";
import type { AssistantAccessMode, PublicRelayPort, PublicRelayState, PublicRelayStatus } from "@ndsp-qc/core";

export interface PublicRelaySubscription {
  remove(): void | Promise<void>;
}

export interface PublicRelayWorkflowOptions {
  relay: PublicRelayPort;
  enabled: boolean;
  pollIntervalMs?: number;
  autoStart?: boolean;
  subscribe?: (listener: (state: PublicRelayState) => void) => Promise<PublicRelaySubscription>;
}

/** Shared pairing and lifecycle controller; native hosts only adapt calls and events. */
export function usePublicRelayWorkflow(options: PublicRelayWorkflowOptions) {
  const { relay, enabled, pollIntervalMs = 0, autoStart = false, subscribe } = options;
  const [status, setStatus] = useState<PublicRelayStatus>();
  const [pending, setPending] = useState(false);

  const run = useCallback(async (operation: () => Promise<PublicRelayStatus>) => {
    setPending(true);
    try {
      const next = await operation();
      setStatus(next);
      return next;
    } finally {
      setPending(false);
    }
  }, []);

  const refresh = useCallback(() => run(() => relay.status()), [relay, run]);
  const pair = useCallback((endpoint: string, pairingCode: string, deviceName?: string) =>
    run(() => relay.pair(endpoint, pairingCode, deviceName)), [relay, run]);
  const start = useCallback(() => run(async () => {
    await relay.start();
    return relay.status();
  }), [relay, run]);
  const unpair = useCallback(() => run(() => relay.unpair()), [relay, run]);
  const setAccessMode = useCallback((mode: AssistantAccessMode) =>
    run(() => relay.setAccessMode(mode)), [relay, run]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let subscription: PublicRelaySubscription | undefined;
    const observe = (next: PublicRelayStatus) => {
      if (active) setStatus(next);
      return next;
    };
    const load = async () => {
      const current = await relay.status();
      observe(current);
      if (autoStart && current.paired && current.state === "stopped") {
        await relay.start();
        observe(await relay.status());
      }
    };
    void load().catch(() => undefined);
    if (subscribe) {
      void subscribe((state) => {
        if (active) setStatus((current) => current ? { ...current, state } : current);
      }).then((value) => {
        if (active) subscription = value;
        else void value.remove();
      }).catch(() => undefined);
    }
    const timer = pollIntervalMs > 0
      ? window.setInterval(() => void relay.status().then(observe).catch(() => undefined), pollIntervalMs)
      : undefined;
    return () => {
      active = false;
      if (timer !== undefined) window.clearInterval(timer);
      if (subscription) void subscription.remove();
    };
  }, [autoStart, enabled, pollIntervalMs, relay, subscribe]);

  return { status, pending, refresh, pair, start, unpair, setAccessMode };
}
