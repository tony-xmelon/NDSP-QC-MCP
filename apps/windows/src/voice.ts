export interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

export interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

export interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
  message?: string;
}

export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export function createSpeechRecognition(): SpeechRecognitionLike | undefined {
  const Constructor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  return Constructor ? new Constructor() : undefined;
}

export function speechRecognitionAvailable(): boolean {
  return Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition);
}

export function speechRecognitionErrorMessage(error: string): string {
  const messages: Record<string, string> = {
    "audio-capture": "No working microphone was available.",
    "language-not-supported": "The selected Windows speech language is not supported.",
    "network": "The speech-recognition service could not be reached.",
    "no-speech": "No speech was detected. Try again and speak after the microphone turns red.",
    "not-allowed": "Microphone or speech-recognition permission was denied.",
    "service-not-allowed": "Speech recognition is disabled by Windows or Microsoft Edge policy."
  };
  return messages[error] ?? `Speech recognition stopped (${error}).`;
}
