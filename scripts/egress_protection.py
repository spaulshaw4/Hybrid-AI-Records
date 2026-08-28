import os
import shutil


def purge_session_stems(session_id, work_dir):
    """
    Auto-purge temporary stem folders after master track is rendered and hex-locked.
    Protects Supabase network egress by preventing re-downloads of the same stems.
    """
    raw_stems_dir = os.path.join(work_dir, "raw_stems")

    if os.path.exists(raw_stems_dir):
        shutil.rmtree(raw_stems_dir)
        print(f"[EGRESS PROTECT] Purged temporary stems for session {session_id} to preserve bandwidth.")
    else:
        print(f"[EGRESS PROTECT] No stems directory found for session {session_id}. Skipping purge.")


def purge_all_render_temps(renders_dir):
    """
    Batch purge all raw_stems folders across all sessions in the renders directory.
    Use this for periodic cleanup to reclaim D: drive space.
    """
    purged_count = 0

    if not os.path.exists(renders_dir):
        print(f"[EGRESS PROTECT] Renders directory not found: {renders_dir}")
        return

    for session_id in os.listdir(renders_dir):
        session_path = os.path.join(renders_dir, session_id)
        if not os.path.isdir(session_path):
            continue

        raw_stems_dir = os.path.join(session_path, "raw_stems")
        if os.path.exists(raw_stems_dir):
            shutil.rmtree(raw_stems_dir)
            purged_count += 1
            print(f"  -> Purged: {session_id}/raw_stems")

    print(f"[EGRESS PROTECT COMPLETE] {purged_count} session stem folders purged.")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Hybrid 1.0 Egress Protection Utility")
    parser.add_argument("--session", help="Purge stems for a specific session ID")
    parser.add_argument("--dir", default=r"D:\MusicDatasets\renders", help="Working directory path")
    parser.add_argument("--all", action="store_true", help="Purge all session stem folders")
    args = parser.parse_args()

    if args.all:
        purge_all_render_temps(args.dir)
    elif args.session:
        work_dir = os.path.join(args.dir, args.session)
        purge_session_stems(args.session, work_dir)
    else:
        parser.print_help()
