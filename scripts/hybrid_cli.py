# scripts/hybrid_cli.py (Extended with Verification & Batch Operations)
import os
import sys
import json
import argparse
import subprocess
import shutil
from supabase import create_client, Client


class HybridCLI:
    def __init__(self):
        self.supabase_url = os.environ.get("SUPABASE_URL")
        self.supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        self.supabase: Client = create_client(self.supabase_url, self.supabase_key)
        self.payload_dir = r"D:\MusicDatasets\job_payloads"
        self.renders_dir = r"D:\MusicDatasets\renders"

    def status(self, session_id):
        """Check session status in Supabase vault."""
        res = self.supabase.from_('user_vaults').select('*').eq('session_id', session_id).execute()

        if not res.data:
            print(f"[CLI] Session ID not found in Supabase vault: {session_id}")
            return

        print(json.dumps(res.data[0], indent=2))

    def list_queue(self):
        """List all pending job payloads in the queue directory."""
        if not os.path.exists(self.payload_dir):
            print(f"[CLI] Payload directory does not exist: {self.payload_dir}")
            return

        payloads = [f for f in os.listdir(self.payload_dir) if f.endswith('.json')]
        print(f"[CLI] Pending payloads in queue ({len(payloads)}):")
        for p in payloads:
            print(f"  - {p}")

    def verify_session(self, session_id):
        """Run transmission verification daemon for a session."""
        verification_script = r"D:\MusicDatasets\scripts\transmission_verification_daemon.py"
        print(f"[CLI] Running transmission verification daemon for session: {session_id}")
        subprocess.run(["python", verification_script, "--session", session_id])

    def purge_renders(self, session_id):
        """Purge local render cache for a specific session."""
        target_dir = os.path.join(self.renders_dir, session_id)

        if os.path.exists(target_dir):
            shutil.rmtree(target_dir)
            print(f"[CLI] Successfully purged local render cache for session: {session_id}")
        else:
            print(f"[CLI] No local render cache found for session: {session_id}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid 1.0 Alpha Backend Management CLI")
    subparsers = parser.add_subparsers(dest="command")

    # Status command
    status_parser = subparsers.add_parser("status", help="Check session status in Supabase")
    status_parser.add_argument("--session", required=True, help="Session ID")

    # Queue command
    subparsers.add_parser("queue", help="List pending job payloads")

    # Verify command
    verify_parser = subparsers.add_parser("verify", help="Verify remote vault session integrity")
    verify_parser.add_argument("--session", required=True, help="Session ID")

    # Purge command
    purge_parser = subparsers.add_parser("purge", help="Purge local render cache for a session")
    purge_parser.add_argument("--session", required=True, help="Session ID")

    args = parser.parse_args()
    cli = HybridCLI()

    if args.command == "status":
        cli.status(args.session)
    elif args.command == "queue":
        cli.list_queue()
    elif args.command == "verify":
        cli.verify_session(args.session)
    elif args.command == "purge":
        cli.purge_renders(args.session)
    else:
        parser.print_help()
