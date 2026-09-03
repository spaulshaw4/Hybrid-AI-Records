"""Invisible Win32 HWND + STA message pump for commercial VST3 hosts.

Pedalboard's JUCE scanner is headless. LANDR FX / Chromatic (and many other
licensed VST3s) dereference a window handle or need an apartment-threaded
message loop during `initialize()` / `createInstance()`. Creating a dummy
popup and pumping messages on the same thread as `load_plugin()` is the
in-process workaround; a crash is still isolated by the profiler subprocess.
"""
from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes
from types import TracebackType
from typing import Optional

HWND_MESSAGE = wintypes.HWND(-3)
CW_USEDEFAULT = 0x80000000
WS_POPUP = 0x80000000
WS_EX_NOACTIVATE = 0x08000000
WS_EX_TOOLWINDOW = 0x00000080
SW_HIDE = 0
PM_REMOVE = 0x0001
COINIT_APARTMENTTHREADED = 0x2
CS_DBLCLKS = 0x0008
WM_QUIT = 0x0012
ERROR_CLASS_ALREADY_EXISTS = 1410

WNDPROC = ctypes.WINFUNCTYPE(
    ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
)


class WNDCLASSW(ctypes.Structure):
    _fields_ = [
        ("style", wintypes.UINT),
        ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", wintypes.HINSTANCE),
        ("hIcon", wintypes.HICON),
        ("hCursor", wintypes.HCURSOR),
        ("hbrBackground", wintypes.HBRUSH),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
    ]


class MSG(ctypes.Structure):
    _fields_ = [
        ("hwnd", wintypes.HWND),
        ("message", wintypes.UINT),
        ("wParam", wintypes.WPARAM),
        ("lParam", wintypes.LPARAM),
        ("time", wintypes.DWORD),
        ("pt", wintypes.POINT),
    ]


class Win32VstHost:
    """Owns a hidden popup HWND and pumps its queue on the calling thread."""

    def __init__(self, class_name: str = "HybridAiForgeVstHost") -> None:
        if sys.platform != "win32":
            raise RuntimeError("Win32VstHost is only available on Windows")
        self._class_name = class_name
        self._hwnd: Optional[int] = None
        self._atom = 0
        self._user32 = ctypes.WinDLL("user32", use_last_error=True)
        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._ole32 = ctypes.WinDLL("ole32", use_last_error=True)
        self._bind_win32()
        self._com_inited = False
        self._registered_here = False
        # Keep the callback alive for the window's lifetime (ctypes otherwise GCs it).
        self._wndproc = WNDPROC(self._dispatch)

    def _bind_win32(self) -> None:
        self._ole32.CoInitializeEx.argtypes = [wintypes.LPVOID, wintypes.DWORD]
        self._ole32.CoInitializeEx.restype = ctypes.c_long
        self._ole32.CoUninitialize.argtypes = []
        self._ole32.CoUninitialize.restype = None
        self._kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
        self._kernel32.GetModuleHandleW.restype = wintypes.HMODULE
        self._user32.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASSW)]
        self._user32.RegisterClassW.restype = wintypes.ATOM
        self._user32.UnregisterClassW.argtypes = [wintypes.LPCWSTR, wintypes.HINSTANCE]
        self._user32.UnregisterClassW.restype = wintypes.BOOL
        self._user32.CreateWindowExW.argtypes = [
            wintypes.DWORD,
            wintypes.LPCWSTR,
            wintypes.LPCWSTR,
            wintypes.DWORD,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            wintypes.HWND,
            wintypes.HMENU,
            wintypes.HINSTANCE,
            wintypes.LPVOID,
        ]
        self._user32.CreateWindowExW.restype = wintypes.HWND
        self._user32.DestroyWindow.argtypes = [wintypes.HWND]
        self._user32.DestroyWindow.restype = wintypes.BOOL
        self._user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        self._user32.ShowWindow.restype = wintypes.BOOL
        self._user32.DefWindowProcW.argtypes = [
            wintypes.HWND,
            wintypes.UINT,
            wintypes.WPARAM,
            wintypes.LPARAM,
        ]
        self._user32.DefWindowProcW.restype = ctypes.c_ssize_t
        self._user32.PeekMessageW.argtypes = [
            ctypes.POINTER(MSG),
            wintypes.HWND,
            wintypes.UINT,
            wintypes.UINT,
            wintypes.UINT,
        ]
        self._user32.PeekMessageW.restype = wintypes.BOOL
        self._user32.TranslateMessage.argtypes = [ctypes.POINTER(MSG)]
        self._user32.TranslateMessage.restype = wintypes.BOOL
        self._user32.DispatchMessageW.argtypes = [ctypes.POINTER(MSG)]
        self._user32.DispatchMessageW.restype = ctypes.c_ssize_t

    def _dispatch(
        self,
        hwnd: wintypes.HWND,
        msg: wintypes.UINT,
        wparam: wintypes.WPARAM,
        lparam: wintypes.LPARAM,
    ) -> int:
        return int(self._user32.DefWindowProcW(hwnd, msg, wparam, lparam))

    def start(self) -> None:
        hr = int(self._ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED))
        # S_OK (0) or S_FALSE (1, already initialized) are both fine.
        if hr not in (0, 1):
            raise OSError(f"CoInitializeEx failed: HRESULT 0x{hr & 0xFFFFFFFF:08X}")
        self._com_inited = True

        hinstance = self._kernel32.GetModuleHandleW(None)
        wndclass = WNDCLASSW()
        wndclass.style = CS_DBLCLKS
        wndclass.lpfnWndProc = self._wndproc
        wndclass.hInstance = hinstance
        wndclass.lpszClassName = self._class_name
        self._atom = int(self._user32.RegisterClassW(ctypes.byref(wndclass)))
        if not self._atom:
            err = ctypes.get_last_error()
            # Already registered in this process (re-entrant worker).
            if err != 1410:  # ERROR_CLASS_ALREADY_EXISTS
                raise ctypes.WinError(err)

        hwnd = self._user32.CreateWindowExW(
            WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
            self._class_name,
            "Hybrid AI Forge VST host",
            WS_POPUP,
            -32000,
            -32000,
            64,
            64,
            None,
            None,
            hinstance,
            None,
        )
        if not hwnd:
            raise ctypes.WinError(ctypes.get_last_error())
        self._hwnd = int(hwnd)
        self._user32.ShowWindow(hwnd, SW_HIDE)
        self.pump(64)

    def pump(self, max_messages: int = 32) -> None:
        msg = MSG()
        for _ in range(max_messages):
            got = int(self._user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_REMOVE))
            if got == 0:
                break
            if msg.message == WM_QUIT:
                break
            self._user32.TranslateMessage(ctypes.byref(msg))
            self._user32.DispatchMessageW(ctypes.byref(msg))

    def stop(self) -> None:
        if self._hwnd:
            self._user32.DestroyWindow(wintypes.HWND(self._hwnd))
            self._hwnd = None
        if self._atom:
            self._user32.UnregisterClassW(self._class_name, self._kernel32.GetModuleHandleW(None))
            self._atom = 0
        if self._com_inited:
            self._ole32.CoUninitialize()
            self._com_inited = False

    def __enter__(self) -> "Win32VstHost":
        self.start()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.stop()


def maybe_win32_vst_host() -> Win32VstHost | None:
    if sys.platform != "win32":
        return None
    return Win32VstHost()
