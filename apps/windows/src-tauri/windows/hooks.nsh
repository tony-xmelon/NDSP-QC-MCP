; Remove the Python gateway left by QC Control releases before 0.1.67.
; The current installer contains only the native Rust device broker.
!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\qc-device-gateway.exe"
!macroend

