"""在获得账本授权后执行固定 Python 入口，父进程租约断开时终止自身。"""

import ctypes
import json
import os
import runpy
import signal
import sys
import threading
import time
from collections.abc import Callable
from ctypes import wintypes


def windows_termination() -> Callable[[], None]:
    """由当前进程创建 Job 并把自身加入，避免通过存盘 PID 查找进程。"""
    class BasicLimits(ctypes.Structure):
        _fields_ = [
            ("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
            ("flags", wintypes.DWORD), ("min_working_set", ctypes.c_size_t),
            ("max_working_set", ctypes.c_size_t), ("active_limit", wintypes.DWORD),
            ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
            ("scheduling", wintypes.DWORD),
        ]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("basic", BasicLimits), ("io", ctypes.c_uint64 * 6),
            ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
            ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t),
        ]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateJobObjectW(None, None)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    limits = ExtendedLimits()
    limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits))
            or not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess())):
        error = ctypes.get_last_error()
        kernel.CloseHandle(handle)
        raise ctypes.WinError(error)

    def terminate() -> None:
        kernel.TerminateJobObject(handle, 125)
        os._exit(125)

    return terminate


def posix_termination() -> Callable[[], None]:
    """仅终止当前进程所在的独立组。"""
    if os.getpid() != os.getpgrp():
        raise RuntimeError("Expected a detached AXIOM worker process group")

    def terminate() -> None:
        os.killpg(os.getpgrp(), signal.SIGKILL)

    return terminate


def lease_reader() -> tuple[Callable[[], bytes], Callable[[], None]]:
    """Windows 查看管道状态，不在同步管道句柄上挂起读取。"""
    if os.name != "nt":
        def read_posix() -> bytes:
            return os.read(0, 1)

        def wait_posix() -> None:
            read_posix()

        return read_posix, wait_posix

    import msvcrt

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.ReadFile.argtypes = [
        wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p,
    ]
    kernel.PeekNamedPipe.argtypes = [
        wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p,
        ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p,
    ]
    handle = msvcrt.get_osfhandle(0)

    def read() -> bytes:
        byte = ctypes.create_string_buffer(1)
        count = wintypes.DWORD()
        if not kernel.ReadFile(handle, byte, 1, ctypes.byref(count), None):
            return b""
        return byte.raw[:count.value]

    def wait() -> None:
        available = wintypes.DWORD()
        while kernel.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None):
            # 授权后的额外字节同样视为撤销。断开时 PeekNamedPipe 返回失败。
            if available.value:
                return
            time.sleep(0.05)

    return read, wait


def main() -> None:
    """先宣布身份，再阻塞等待一次性授权。"""
    nonce, target, *args = sys.argv[1:]
    terminate = windows_termination() if os.name == "nt" else posix_termination()
    read, wait = lease_reader()
    print(json.dumps({"nonce": nonce, "pid": os.getpid()}), flush=True)
    if read() != b"g":
        return

    def watch_lease() -> None:
        # 使用原始文件描述符，解释器退出时不会因缓冲 stdin 上的锁而阻塞。
        try:
            wait()
        finally:
            terminate()

    threading.Thread(target=watch_lease, daemon=True).start()
    sys.argv = [target, *args]
    sys.path.insert(0, os.path.dirname(target))
    runpy.run_path(target, run_name="__main__")


if __name__ == "__main__":
    main()
