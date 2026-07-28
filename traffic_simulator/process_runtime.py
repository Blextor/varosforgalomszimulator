"""Process-level safeguards for the project's large Windows workloads."""

from __future__ import annotations

import json
import os
import sys


def apply_safe_process_runtime() -> None:
    """Reduce native allocator and CPU variability on the affected Windows host."""

    json.encoder.c_make_encoder = None
    if os.name != "nt":
        return
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        pointer_size = ctypes.c_size_t
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.GetProcessAffinityMask.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(pointer_size),
            ctypes.POINTER(pointer_size),
        ]
        kernel32.SetProcessAffinityMask.argtypes = [wintypes.HANDLE, pointer_size]
        process = kernel32.GetCurrentProcess()
        process_mask = pointer_size()
        system_mask = pointer_size()
        if not kernel32.GetProcessAffinityMask(
            process, ctypes.byref(process_mask), ctypes.byref(system_mask)
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        first_available_cpu = process_mask.value & -process_mask.value
        if not first_available_cpu or not kernel32.SetProcessAffinityMask(
            process, first_available_cpu
        ):
            raise ctypes.WinError(ctypes.get_last_error())
    except (ImportError, OSError, ValueError) as error:
        print(f"Warning: process affinity could not be limited ({error}).", file=sys.stderr)
