"""Scan in-place stem_activity_log.csv files for bleed, leakage, and weak calls."""

from __future__ import annotations

import csv
import glob
import os
import re
import sys
from collections import Counter

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.engine_stem_classifier import LABELS

LOCKED_BUS_RE = re.compile(
    r"_(acoustic|voice|electric|beats|bass)_locked\.wav$",
    re.IGNORECASE,
)

PREFIX_TO_BUS = {
    "bass": "bass",
    "beats": "beats",
    "drums": "beats",
    "voice": "voice",
    "vocal": "voice",
    "vocals": "voice",
    "acoustic": "acoustic",
    "other": "acoustic",
    "electric": "electric",
}


def _truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"true", "1", "yes"}


def expected_bus_from_filename(file_name: str) -> str | None:
    """Prefer ``_*_locked.wav`` suffix; MUSDB prefixes map drums/vocals/other."""
    match = LOCKED_BUS_RE.search(file_name)
    if match:
        return match.group(1).lower()
    prefix = file_name.split("_")[0].lower()
    if prefix in {"mixture", "mix", "combo"}:
        return None
    return PREFIX_TO_BUS.get(prefix)


def analyze_track_anomalies(
    root_staging_dir: str,
    conf_threshold: float = 0.60,
    min_active_prob: float = 0.25,
) -> list[dict]:
    csv_paths = glob.glob(
        os.path.join(root_staging_dir, "*", "stem_activity_log.csv")
    )
    anomalies: list[dict] = []

    for csv_file in sorted(csv_paths):
        track_name = os.path.basename(os.path.dirname(csv_file))
        with open(csv_file, newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))

        for row in rows:
            if _truthy(row.get("is_silent", False)):
                continue

            file_name = row.get("file", "")
            expected_bus = expected_bus_from_filename(file_name)
            if expected_bus is None:
                continue

            predicted_bus = str(row.get("predicted_bus", "")).lower()
            if predicted_bus == "idle":
                continue
            confidence = float(row.get("confidence", 0.0) or 0.0)

            if predicted_bus != expected_bus and confidence >= conf_threshold:
                anomalies.append(
                    {
                        "track": track_name,
                        "time_range": row.get("time_range", ""),
                        "file": file_name,
                        "type": "BUS_MISMATCH_BLEED",
                        "expected": expected_bus.upper(),
                        "detected": predicted_bus.upper(),
                        "confidence": f"{confidence * 100:.1f}%",
                        "detail": (
                            f"Strong cross-talk/bleed detected from {predicted_bus.upper()}"
                        ),
                    }
                )

            prob_cols = [c for c in row if c.startswith("prob_")]
            high_prob_buses = [
                c.replace("prob_", "").upper()
                for c in prob_cols
                if float(row.get(c, 0.0) or 0.0) >= min_active_prob
            ]

            if len(high_prob_buses) >= 2:
                anomalies.append(
                    {
                        "track": track_name,
                        "time_range": row.get("time_range", ""),
                        "file": file_name,
                        "type": "COMPETING_BUS_LEAKAGE",
                        "expected": expected_bus.upper(),
                        "detected": predicted_bus.upper(),
                        "confidence": f"{confidence * 100:.1f}%",
                        "detail": (
                            "Split spectral energy across: "
                            + ", ".join(high_prob_buses)
                        ),
                    }
                )
            elif confidence < conf_threshold:
                anomalies.append(
                    {
                        "track": track_name,
                        "time_range": row.get("time_range", ""),
                        "file": file_name,
                        "type": "LOW_CONFIDENCE",
                        "expected": expected_bus.upper(),
                        "detected": predicted_bus.upper(),
                        "confidence": f"{confidence * 100:.1f}%",
                        "detail": "Weak spectral features or transitional boundary",
                    }
                )

    return anomalies


def write_anomaly_csv(anomalies: list[dict], output_path: str) -> None:
    fieldnames = [
        "track",
        "time_range",
        "file",
        "type",
        "expected",
        "detected",
        "confidence",
        "detail",
    ]
    with open(output_path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(anomalies)


if __name__ == "__main__":
    staging_root = r"C:\staging_slices"
    report = analyze_track_anomalies(staging_root)

    print(f"\n[ANOMALY SCAN] Total Anomalies Flagged: {len(report)}")
    if report:
        counts = Counter(row["type"] for row in report)
        print("\nBreakdown by Anomaly Type:")
        for name, n in counts.most_common():
            print(f"  {name}: {n}")

        mismatch = Counter(
            (row["expected"], row["detected"])
            for row in report
            if row["type"] == "BUS_MISMATCH_BLEED"
        )
        if mismatch:
            print("\nBleed expected -> detected (top 10):")
            for pair, n in mismatch.most_common(10):
                print(f"  {pair[0]} -> {pair[1]}: {n}")

        out_csv = os.path.join(staging_root, "dataset_stem_anomalies.csv")
        write_anomaly_csv(report, out_csv)
        print(f"\nSaved full anomaly report to: {out_csv}")

        print(f"\n{'Track':<42} | {'Time':<15} | {'Type':<22} | Exp -> Det | Conf")
        print("-" * 110)
        for row in report[:12]:
            print(
                f"{row['track'][:42]:<42} | {row['time_range']:<15} | "
                f"{row['type']:<22} | {row['expected']} -> {row['detected']:<8} | "
                f"{row['confidence']}"
            )
    else:
        print("No anomalies flagged.")
