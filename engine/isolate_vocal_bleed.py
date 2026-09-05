"""Find vocal spill into beats/bass stems from in-place activity CSVs."""

from __future__ import annotations

import csv
import glob
import os
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.analyze_stem_anomalies import expected_bus_from_filename, _truthy

TARGET_STEMS = frozenset({"beats", "bass"})


def isolate_vocal_bleed(
    root_staging_dir: str,
    voice_threshold: float = 0.20,
    output_csv: str = "vocal_bleed_report.csv",
) -> list[dict]:
    csv_paths = glob.glob(
        os.path.join(root_staging_dir, "*", "stem_activity_log.csv")
    )
    bleed_records: list[dict] = []

    for csv_path in sorted(csv_paths):
        track_name = os.path.basename(os.path.dirname(csv_path))
        with open(csv_path, newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))

        for row in rows:
            if _truthy(row.get("is_silent", False)):
                continue

            filename = row.get("file", "")
            expected_bus = expected_bus_from_filename(filename)
            if expected_bus not in TARGET_STEMS:
                continue

            prob_voice = float(row.get("prob_voice", 0.0) or 0.0)
            predicted_bus = str(row.get("predicted_bus", "")).upper()
            target_prob = float(row.get(f"prob_{expected_bus}", 0.0) or 0.0)

            if prob_voice < voice_threshold and predicted_bus != "VOICE":
                continue

            if predicted_bus == "VOICE":
                severity = "CRITICAL_OVERTAKE"
            elif prob_voice >= 0.40:
                severity = "HIGH_BLEED"
            else:
                severity = "BACKGROUND_BLEED"

            bleed_records.append(
                {
                    "track": track_name,
                    "time_range": row.get("time_range", ""),
                    "file": filename,
                    "target_stem": expected_bus.upper(),
                    "predicted_bus": predicted_bus,
                    "target_bus_prob": f"{target_prob * 100:.1f}%",
                    "vocal_bleed_prob": f"{prob_voice * 100:.1f}%",
                    "vocal_bleed_frac": prob_voice,
                    "bleed_ratio": round(prob_voice / (target_prob + 1e-6), 2),
                    "severity": severity,
                }
            )

    bleed_records.sort(key=lambda r: r["vocal_bleed_frac"], reverse=True)
    for row in bleed_records:
        row.pop("vocal_bleed_frac", None)

    if bleed_records:
        out_path = os.path.join(root_staging_dir, output_csv)
        fieldnames = [
            "track",
            "time_range",
            "file",
            "target_stem",
            "predicted_bus",
            "target_bus_prob",
            "vocal_bleed_prob",
            "bleed_ratio",
            "severity",
        ]
        with open(out_path, "w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(bleed_records)
        print(
            f"[VOCAL BLEED SCAN] Flagged {len(bleed_records)} suspect slices "
            "across rhythm stems."
        )
        print(f"[EXPORT] Saved vocal bleed report to: {out_path}\n")
    else:
        print(
            "[VOCAL BLEED SCAN] No vocal bleed detected above threshold "
            "across drum/bass stems."
        )

    return bleed_records


if __name__ == "__main__":
    staging_root = r"C:\staging_slices"
    records = isolate_vocal_bleed(staging_root, voice_threshold=0.20)
    if records:
        from collections import Counter

        counts = Counter(r["severity"] for r in records)
        print("Severity:")
        for name, n in counts.most_common():
            print(f"  {name}: {n}")
        print()
        print(
            f"{'Track':<42} | {'Time':<15} | {'Stem':<6} | "
            f"{'Voice':<7} | Severity"
        )
        print("-" * 95)
        for row in records[:10]:
            print(
                f"{row['track'][:42]:<42} | {row['time_range']:<15} | "
                f"{row['target_stem']:<6} | {row['vocal_bleed_prob']:<7} | "
                f"{row['severity']}"
            )
