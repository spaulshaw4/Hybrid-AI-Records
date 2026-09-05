"""Rebuild every staging .rpp and validate Reaper chunk / media integrity."""

from __future__ import annotations

import os
import re
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.generate_reaper_project import create_reaper_project

EXCLUDED_FOLDERS = {"dsd100", "harmonic", "logs", "checkpoints", "temp", "corrupt_dsp"}
ENV_CHUNKS = {"VOLENV", "PANENV", "AUXVOLENV"}


def verify_rpp_integrity(rpp_file_path):
    """
    Deep-validate a generated Reaper project:
    1. Tag chunk balancing (< vs >).
    2. Header validity (<REAPER_PROJECT).
    3. Media source file resolution on disk.
    4. Envelope structure (VOLENV / PANENV present and closed).
    """
    if not os.path.exists(rpp_file_path):
        return False, {
            "tracks": 0,
            "items": 0,
            "lines": 0,
            "issues": ["File does not exist on disk."],
        }

    issues = []
    chunk_stack = []
    track_count = 0
    item_count = 0
    missing_media = []
    env_seen = set()

    with open(rpp_file_path, "r", encoding="utf-8", errors="ignore") as handle:
        lines = handle.readlines()

    if not lines or not lines[0].strip().startswith("<REAPER_PROJECT"):
        issues.append("Missing valid <REAPER_PROJECT root header.")

    for line_num, line in enumerate(lines, start=1):
        stripped = line.strip()

        if stripped.startswith("<"):
            tag_name = stripped[1:].split()[0]
            chunk_stack.append((tag_name, line_num))
            if tag_name == "TRACK":
                track_count += 1
            elif tag_name == "ITEM":
                item_count += 1
            elif tag_name in ENV_CHUNKS:
                env_seen.add(tag_name)

        elif stripped == ">":
            if not chunk_stack:
                issues.append(
                    f"Unexpected closing tag '>' at line {line_num} with no matching open chunk."
                )
            else:
                chunk_stack.pop()

        if stripped.startswith("FILE "):
            match = re.search(r'FILE\s+"([^"]+)"', stripped)
            if match:
                media_path = os.path.normpath(match.group(1).replace("/", os.sep))
                if not os.path.exists(media_path):
                    missing_media.append(os.path.basename(media_path))

    if chunk_stack:
        unclosed = ", ".join([f"<{tag} (line {num})" for tag, num in chunk_stack])
        issues.append(f"Unclosed chunk tags detected: {unclosed}")

    if missing_media:
        issues.append(
            f"{len(missing_media)} referenced media slices missing from disk "
            f"(e.g. {missing_media[0]})"
        )

    if track_count == 0:
        issues.append("No <TRACK> blocks found.")
    if item_count == 0:
        issues.append("No <ITEM> media slices found.")
    if "VOLENV" not in env_seen:
        issues.append("Missing <VOLENV> volume-gate envelope.")
    if "PANENV" not in env_seen:
        issues.append("Missing <PANENV> pan envelope.")
    if "AUXVOLENV" not in env_seen:
        issues.append("Missing <AUXVOLENV> aux-send envelopes.")
    body = "".join(lines)
    if "<MASTERFXLIST" not in body:
        issues.append("Missing <MASTERFXLIST> master FX slots.")
    if "AUXRECV " not in body:
        issues.append("Missing AUXRECV send routing.")
    if "ISBUS 1 1" not in body:
        issues.append("Missing parent folder buses (ISBUS 1 1).")

    return len(issues) == 0, {
        "tracks": track_count,
        "items": item_count,
        "lines": len(lines),
        "issues": issues,
    }


def run_batch_and_verify(staging_root=r"C:\staging_slices"):
    track_dirs = [
        os.path.join(staging_root, d)
        for d in os.listdir(staging_root)
        if os.path.isdir(os.path.join(staging_root, d)) and d.lower() not in EXCLUDED_FOLDERS
    ]

    print(f"\n[BATCH RPP RUNNER] Found {len(track_dirs)} track directories.")
    print(f"{'Track Directory':<40} | {'Tracks':<6} | {'Items':<6} | {'Integrity Status'}")
    print("-" * 75)

    passed_count = 0
    failed_count = 0

    for t_dir in sorted(track_dirs):
        track_name = os.path.basename(t_dir)
        rpp_path = os.path.join(t_dir, f"{track_name}.rpp")

        create_reaper_project(t_dir, output_rpp=rpp_path)
        is_valid, stats = verify_rpp_integrity(rpp_path)

        if is_valid:
            print(f"{track_name:<40} | {stats['tracks']:<6} | {stats['items']:<6} | PASS (0 errors)")
            passed_count += 1
        else:
            err_summary = "; ".join(stats["issues"])
            print(f"{track_name:<40} | {stats['tracks']:<6} | {stats['items']:<6} | FAIL: {err_summary}")
            failed_count += 1

    print("-" * 75)
    print(
        f"[VERIFICATION SUMMARY] Passed: {passed_count} | Failed: {failed_count} | "
        f"Total: {len(track_dirs)}"
    )
    return passed_count, failed_count


if __name__ == "__main__":
    run_batch_and_verify(r"C:\staging_slices")
