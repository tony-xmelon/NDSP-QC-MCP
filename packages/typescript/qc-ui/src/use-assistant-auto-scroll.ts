import { useCallback, useEffect, useRef } from "react";

/** Follow new assistant messages until the user intentionally scrolls away. */
export function useAssistantAutoScroll(enabled: boolean, dependency: unknown, bottomThreshold = 48) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const userScrolling = useRef(false);
  const programmaticScroll = useRef(false);
  const userScrollTimer = useRef<number | undefined>(undefined);

  const onUserScroll = useCallback(() => {
    programmaticScroll.current = false;
    userScrolling.current = true;
    if (userScrollTimer.current !== undefined) window.clearTimeout(userScrollTimer.current);
    userScrollTimer.current = window.setTimeout(() => { userScrolling.current = false; }, 900);
  }, []);

  const onScroll = useCallback(() => {
    const element = containerRef.current;
    if (!element || programmaticScroll.current) return;
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight <= bottomThreshold;
  }, [bottomThreshold]);

  useEffect(() => {
    const element = containerRef.current;
    if (!enabled || !element || !stickToBottom.current || userScrolling.current) return;
    programmaticScroll.current = true;
    const frame = window.requestAnimationFrame(() => {
      element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
      stickToBottom.current = true;
      programmaticScroll.current = false;
    });
    return () => {
      window.cancelAnimationFrame(frame);
      programmaticScroll.current = false;
    };
  }, [dependency, enabled]);

  useEffect(() => () => {
    if (userScrollTimer.current !== undefined) window.clearTimeout(userScrollTimer.current);
  }, []);

  return { containerRef, onScroll, onUserScroll };
}
