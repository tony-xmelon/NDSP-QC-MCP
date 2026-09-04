export function MicrophoneIcon({ className }: { className?: string }) {
  return <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="8.25" y="2.5" width="7.5" height="13" rx="3.75" />
    <path d="M5.5 11.25v.75a6.5 6.5 0 0 0 13 0v-.75" />
    <path d="M12 18.5v3" />
    <path d="M8.75 21.5h6.5" />
  </svg>;
}
