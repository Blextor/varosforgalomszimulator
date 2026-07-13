"""Windows-safe UTF-8 console setup for the project's command-line tools."""

from __future__ import annotations

import sys


def configure_utf8_stdio() -> None:
    """Make terminal and redirected log output deterministic UTF-8."""

    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="backslashreplace")
