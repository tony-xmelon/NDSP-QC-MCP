# Device gateway

The normal single-owner process for Quad Cortex USB access. It composes `qc-core` with a device adapter, serializes commands, synchronizes authoritative state, and exposes private stdio IPC plus optional authenticated network transports.

The gateway is independently runnable and contains no desktop UI.
