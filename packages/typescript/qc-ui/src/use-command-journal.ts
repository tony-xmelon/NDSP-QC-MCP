import { useCallback, useState } from "react";

export type CommandJournal<T> = {
  undoEntry?: T;
  redoEntry?: T;
  record: (entry: T) => void;
  clear: () => void;
  markUndone: (entry: T) => void;
  markRedone: (entry: T) => void;
};

/** Shared one-step command journal for device UIs with verified undo/redo. */
export function useCommandJournal<T>(): CommandJournal<T> {
  const [undoEntry, setUndoEntry] = useState<T>();
  const [redoEntry, setRedoEntry] = useState<T>();
  const record = useCallback((entry: T) => {
    setUndoEntry(entry);
    setRedoEntry(undefined);
  }, []);
  const clear = useCallback(() => {
    setUndoEntry(undefined);
    setRedoEntry(undefined);
  }, []);
  const markUndone = useCallback((entry: T) => {
    setUndoEntry(undefined);
    setRedoEntry(entry);
  }, []);
  const markRedone = useCallback((entry: T) => {
    setRedoEntry(undefined);
    setUndoEntry(entry);
  }, []);
  return { undoEntry, redoEntry, record, clear, markUndone, markRedone };
}
