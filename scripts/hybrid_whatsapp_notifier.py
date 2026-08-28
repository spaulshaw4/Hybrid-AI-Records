# scripts/hybrid_whatsapp_notifier.py
import os
import json
import argparse
import requests


class HybridWhatsAppNotifier:
    def __init__(self):
        self.api_url = os.environ.get("WHATSAPP_API_URL")
        self.access_token = os.environ.get("WHATSAPP_ACCESS_TOKEN")
        self.phone_number_id = os.environ.get("WHATSAPP_PHONE_NUMBER_ID")
        self.recipient_number = os.environ.get("WHATSAPP_RECIPIENT_NUMBER")

    def send_alert(self, session_id, status, details=""):
        if not all([self.api_url, self.access_token, self.phone_number_id, self.recipient_number]):
            print("[WhatsApp Warning] Missing WhatsApp API credentials in environment variables. Skipping notification.")
            return False

        url = f"{self.api_url}/{self.phone_number_id}/messages"

        emoji = "🟢" if status.lower() == "completed" else "🔴" if status.lower() == "failed" else "🟡"
        message = (
            f"{emoji} *Hybrid 1.0 Alpha Alert*\n"
            f"• *Session:* `{session_id}`\n"
            f"• *Status:* `{status.upper()}`\n"
            f"• *Details:* {details or 'Pipeline stage update processed.'}"
        )

        headers = {
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type": "application/json"
        }

        payload = {
            "messaging_product": "whatsapp",
            "to": self.recipient_number,
            "type": "text",
            "text": {
                "body": message
            }
        }

        try:
            response = requests.post(url, headers=headers, json=payload)
            if response.status_code == 200:
                print(f"[WhatsApp] Alert successfully dispatched for session: {session_id}")
                return True
            else:
                print(f"[WhatsApp Error] Failed to send message: {response.text}")
                return False
        except Exception as e:
            print(f"[WhatsApp Exception] {e}")
            return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid 1.0 WhatsApp Notification Dispatcher")
    parser.add_argument("--session", required=True, help="Session ID")
    parser.add_argument("--status", required=True, help="Execution status (completed, failed, processing)")
    parser.add_argument("--details", default="", help="Additional log details")
    args = parser.parse_args()

    notifier = HybridWhatsAppNotifier()
    notifier.send_alert(args.session, args.status, args.details)
