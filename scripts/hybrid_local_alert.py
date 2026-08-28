# scripts/hybrid_local_alert.py
import os
import ctypes
import argparse


class HybridLocalNotifier:
    def __init__(self):
        pass

    def send_alert(self, session_id, status, details=""):
        """
        Triggers a native Windows GUI message box alert for local system events,
        bypassing external API requirements.
        """
        title = f"Hybrid 1.0 Alpha - Session {status.upper()}"
        icon_flag = 0x40 if status.lower() == "completed" else 0x10 if status.lower() == "failed" else 0x30

        message = (
            f"Session ID: {session_id}\n"
            f"Status: {status.upper()}\n\n"
            f"Details: {details or 'Pipeline stage update processed.'}"
        )

        try:
            # Call Windows MessageBoxW API directly via ctypes
            ctypes.windll.user32.MessageBoxW(0, message, title, icon_flag)
            print(f"[Local Alert] Windows GUI notification displayed for session: {session_id}")
            return True
        except Exception as e:
            print(f"[Local Alert Error] Failed to trigger Windows notification: {e}")
            return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid 1.0 Local Windows Notifier")
    parser.add_argument("--session", required=True, help="Session ID")
    parser.add_argument("--status", required=True, help="Execution status (completed, failed, processing)")
    parser.add_argument("--details", default="", help="Additional log details")
    args = parser.parse_args()

    notifier = HybridLocalNotifier()
    notifier.send_alert(args.session, args.status, args.details)
