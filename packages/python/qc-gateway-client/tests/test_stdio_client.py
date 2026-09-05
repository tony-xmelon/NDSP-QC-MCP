from __future__ import annotations

import sys
import time

import pytest

from qc_gateway_client.client import GatewayError, StdioGatewayClient


def test_stdio_client_times_out_and_discards_a_wedged_child() -> None:
    script = (
        "import sys,time; "
        "size=int.from_bytes(sys.stdin.buffer.read(4),'big'); "
        "sys.stdin.buffer.read(size); time.sleep(30)"
    )
    client = StdioGatewayClient(
        [sys.executable, "-c", script], response_timeout=0.05
    )
    started = time.monotonic()

    with pytest.raises(GatewayError) as raised:
        client.request("system.status")

    assert raised.value.retryable is True
    assert "did not respond" in str(raised.value)
    assert time.monotonic() - started < 3
    assert client._process is None

