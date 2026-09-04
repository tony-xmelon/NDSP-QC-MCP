# Quad Cortex schema provenance

The protobuf files in `proto/` are vendored from the MIT-licensed
[`stokes-audio/pyquadcortex`](https://github.com/stokes-audio/pyquadcortex)
repository at commit `a4f2d9be7da86053e0f03619c645d59180fe4e8c`.

They correspond to `pyquadcortex` 0.40.0 and remain covered by the upstream
license reproduced in `PYQUADCORTEX-LICENSE.txt`.

The native implementation treats this schema as the protocol authority. A
parity audit must be rerun whenever the pinned upstream commit or package
version changes.

