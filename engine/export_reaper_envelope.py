"""Convert stem_activity_log.csv into a Reaper <VOLENV> chunk."""

from __future__ import annotations

import csv
import os
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)


def _row_matches_bus(row: dict, target_bus: str | None) -> bool:
    if not target_bus:
        return True
    token = f"_{target_bus.lower()}_locked.wav"
    return str(row.get("file", "")).lower().endswith(token)


def _load_timeline_rows(csv_path: str, filter_bus: str | None = "bass") -> list[dict]:
    with open(csv_path, "r", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    if filter_bus:
        filtered = [row for row in rows if _row_matches_bus(row, filter_bus)]
        if filtered:
            rows = filtered
        else:
            for bus in ("bass", "beats", "voice", "acoustic", "electric"):
                subset = [row for row in rows if _row_matches_bus(row, bus)]
                if subset:
                    rows = subset
                    break
    rows.sort(key=lambda r: (float(r["start_time_sec"]), r.get("file", "")))
    return rows


def _append_ramped_points(
    points: list[tuple[float, float]],
    i: int,
    t_start: float,
    t_end: float,
    value: float,
    ramp_sec: float,
) -> None:
    if i == 0:
        points.append((t_start, value))
    else:
        _prev_t, prev_val = points[-1]
        if abs(value - prev_val) > 1e-6:
            points.append((max(0.0, t_start - ramp_sec), prev_val))
            points.append((t_start, value))
    points.append((max(0.0, t_end - ramp_sec), value))


def build_reaper_envelope_chunk(tag: str, points: list[tuple[float, float]]) -> str:
    lines = [
        f"<{tag}",
        "ACT 1 -1",
        "VIS 1 1 1",
        "ARM 1",
        "DEFSHAPE 0 -1 -1",
    ]
    for t, val in points:
        lines.append(f"PT {t:.4f} {val:.6f} 0")
    lines.append(">")
    return "\n".join(lines) + "\n"


def generate_reaper_envelope(
    csv_path: str,
    target_bus: str | None = None,
    ramp_sec: float = 0.05,
    output_file: str | None = None,
    filter_to_bus: bool = True,
):
    """
    Converts stem activity logs into a Reaper Volume Track Envelope (<VOLENV> chunk).

    Mixed-track CSVs (bass+drums+vocals in one file) are filtered to the target
    bus so envelope times stay chronological and non-overlapping.
    """
    if not os.path.exists(csv_path):
        print(f"[ERROR] CSV not found: {csv_path}")
        return None

    if output_file is None:
        suffix = f"_{target_bus.lower()}" if target_bus else "_gate"
        output_file = os.path.splitext(csv_path)[0] + f"{suffix}_volume.env"

    with open(csv_path, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    if filter_to_bus and target_bus:
        rows = [row for row in rows if _row_matches_bus(row, target_bus)]
    elif filter_to_bus and target_bus is None:
        # Gate one timeline: prefer bass, else first locked-bus family present.
        for bus in ("bass", "beats", "voice", "acoustic", "electric"):
            subset = [row for row in rows if _row_matches_bus(row, bus)]
            if subset:
                rows = subset
                break

    rows.sort(key=lambda r: (float(r["start_time_sec"]), r.get("file", "")))

    points: list[tuple[float, float]] = []
    for i, row in enumerate(rows):
        t_start = float(row["start_time_sec"])
        t_end = float(row["end_time_sec"])
        is_silent = str(row.get("is_silent", "")).strip().lower() == "true"

        if is_silent:
            gain = 0.0
        elif target_bus:
            prob_col = f"prob_{target_bus.lower()}"
            gain = float(row.get(prob_col, 0.0) or 0.0)
        else:
            gain = 1.0

        if i == 0:
            points.append((t_start, gain))
        else:
            prev_t, prev_gain = points[-1]
            if abs(gain - prev_gain) > 1e-6:
                points.append((max(0.0, t_start - ramp_sec), prev_gain))
                points.append((t_start, gain))

        points.append((max(0.0, t_end - ramp_sec), gain))

    with open(output_file, "w", encoding="utf-8") as f:
        f.write(build_reaper_envelope_chunk("VOLENV", points))

    mode = f"Continuous {target_bus.upper()}" if target_bus else "RMS Silence Gate"
    print(f"[REAPER EXPORT] Envelope generated: {output_file}")
    print(f"  - Total automation points: {len(points)}")
    print(f"  - Mode: {mode}")
    return output_file


def generate_reaper_pan_envelope(
    csv_path: str,
    pan_layout: dict | None = None,
    ramp_sec: float = 0.05,
    output_file: str | None = None,
    filter_bus: str = "bass",
):
    """
    Generates a Reaper Pan Envelope (<PANENV>) from -1.0 (Left) to +1.0 (Right).

    Default: bass/beats/voice center, acoustic left, electric right.
    Mixed-track CSVs are filtered to ``filter_bus`` so times do not overlap.
    """
    if not os.path.exists(csv_path):
        print(f"[ERROR] CSV not found: {csv_path}")
        return None
    if pan_layout is None:
        pan_layout = {
            "bass": 0.0,
            "beats": 0.0,
            "voice": 0.0,
            "acoustic": -0.65,
            "electric": 0.65,
            "idle": 0.0,
        }
    if output_file is None:
        output_file = os.path.splitext(csv_path)[0] + "_pan.env"

    rows = _load_timeline_rows(csv_path, filter_bus=filter_bus)
    points: list[tuple[float, float]] = []
    for i, row in enumerate(rows):
        t_start = float(row["start_time_sec"])
        t_end = float(row["end_time_sec"])
        is_silent = str(row.get("is_silent", "")).strip().lower() == "true"
        if is_silent:
            pan_val = 0.0
        else:
            weighted_pan = 0.0
            for bus, pan_target in pan_layout.items():
                if bus == "idle":
                    continue
                weighted_pan += float(row.get(f"prob_{bus}", 0.0) or 0.0) * pan_target
            pan_val = max(-1.0, min(1.0, weighted_pan))
        _append_ramped_points(points, i, t_start, t_end, pan_val, ramp_sec)

    with open(output_file, "w", encoding="utf-8") as handle:
        handle.write(build_reaper_envelope_chunk("PANENV", points))
    print(f"[REAPER EXPORT] Pan envelope saved: {output_file} ({len(points)} points)")
    return output_file


def generate_multi_bus_send_envelopes(
    csv_path: str,
    buses: list[str] | None = None,
    ramp_sec: float = 0.05,
    output_dir: str | None = None,
    filter_bus: str = "bass",
):
    """Discrete Send Volume envelopes (<AUXVOLENV>) for five aux buses."""
    if not os.path.exists(csv_path):
        print(f"[ERROR] CSV not found: {csv_path}")
        return []
    if buses is None:
        buses = ["acoustic", "voice", "electric", "beats", "bass"]
    if output_dir is None:
        output_dir = os.path.dirname(csv_path)

    rows = _load_timeline_rows(csv_path, filter_bus=filter_bus)
    written = []
    for send_idx, bus_name in enumerate(buses):
        points: list[tuple[float, float]] = []
        prob_key = f"prob_{bus_name}"
        out_file = os.path.join(
            output_dir, f"send_{send_idx + 1}_{bus_name}_volume.env"
        )
        for i, row in enumerate(rows):
            t_start = float(row["start_time_sec"])
            t_end = float(row["end_time_sec"])
            is_silent = str(row.get("is_silent", "")).strip().lower() == "true"
            gain = 0.0 if is_silent else float(row.get(prob_key, 0.0) or 0.0)
            _append_ramped_points(points, i, t_start, t_end, gain, ramp_sec)
        with open(out_file, "w", encoding="utf-8") as handle:
            handle.write(build_reaper_envelope_chunk("AUXVOLENV", points))
        print(
            f"[REAPER EXPORT] Aux Send #{send_idx + 1} ({bus_name.upper()}) -> {out_file}"
        )
        written.append(out_file)
    return written


if __name__ == "__main__":
    csv_file = r"C:\staging_slices\001 - ANiMAL - Clinic A\stem_activity_log.csv"
    generate_reaper_envelope(csv_file, target_bus=None)
    generate_reaper_envelope(csv_file, target_bus="bass")
    generate_reaper_pan_envelope(csv_file)
    generate_multi_bus_send_envelopes(csv_file)
