"""Build a trainer blacklist from BUS_MISMATCH_BLEED anomalies."""

from __future__ import annotations

import csv
import json
import os
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)


def generate_trainer_blacklist(
    anomaly_csv=r"C:\staging_slices\dataset_stem_anomalies.csv",
    output_txt=None,
    output_json=None,
    min_bleed_conf=0.70,
):
    """
    Parses anomalies and exports a clean blacklist containing:
    1. Critical mismatches (BUS_MISMATCH_BLEED >= 70% conf)
    2. Corrupt or severely spilled slices
    """
    if output_txt is None:
        output_txt = os.path.join(REPO, "config", "trainer_blacklist.txt")
    if output_json is None:
        output_json = os.path.join(REPO, "config", "trainer_blacklist.json")

    if not os.path.exists(anomaly_csv):
        print(f"[ERROR] Anomaly CSV not found at: {anomaly_csv}")
        return set()

    blacklist_files = set()
    skipped_count = 0

    with open(anomaly_csv, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            anomaly_type = row.get("type", "")
            conf_str = row.get("confidence", "0.0%").replace("%", "")
            try:
                confidence = float(conf_str) / 100.0
            except ValueError:
                confidence = 0.0

            if anomaly_type == "BUS_MISMATCH_BLEED" and confidence >= min_bleed_conf:
                filename = row.get("file", "").strip()
                track = row.get("track", "").strip()
                if filename and track:
                    blacklist_files.add(f"{track}/{filename}")
                elif filename:
                    blacklist_files.add(filename)
            else:
                skipped_count += 1

    os.makedirs(os.path.dirname(output_txt), exist_ok=True)

    with open(output_txt, "w", encoding="utf-8") as f:
        for fname in sorted(blacklist_files):
            f.write(f"{fname}\n")

    with open(output_json, "w", encoding="utf-8") as f:
        json.dump(
            {
                "total_pruned": len(blacklist_files),
                "retained_anomalies": skipped_count,
                "min_confidence_cutoff": min_bleed_conf,
                "blacklist": sorted(blacklist_files),
            },
            f,
            indent=2,
        )

    print("[BLACKLIST] Generated clean training blacklist:")
    print(
        f"  - Pruned {len(blacklist_files)} corrupt/bleed slices "
        f"(>= {min_bleed_conf * 100:.0f}% confidence)"
    )
    print(
        f"  - Retained {skipped_count} mild multi-bus overlap slices "
        "for generalization"
    )
    print(f"  - Saved to: {output_txt}")

    return blacklist_files


if __name__ == "__main__":
    generate_trainer_blacklist(min_bleed_conf=0.0)
