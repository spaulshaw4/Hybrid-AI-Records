"""Assemble a Reaper .rpp with folder buses, colors, FX slots, and aux sends."""

from __future__ import annotations

import glob
import os
import re
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from engine.analyze_stem_anomalies import expected_bus_from_filename
from engine.export_reaper_envelope import (
    _append_ramped_points,
    _load_timeline_rows,
    _row_matches_bus,
    build_reaper_envelope_chunk,
)

BUSES = ["bass", "beats", "voice", "electric", "acoustic"]
SEND_BUSES = ["acoustic", "voice", "electric", "beats", "bass"]
PAN_LAYOUT = {
    "bass": 0.0,
    "beats": 0.0,
    "voice": 0.0,
    "acoustic": -0.65,
    "electric": 0.65,
}


# Reaper native 24-bit RGB peak colors: (B << 16) | (G << 8) | R | 0x1000000
TRACK_THEME = {
    "DRUMS": {"color": 16724787, "bus_key": "beats"},
    "BASS": {"color": 33489919, "bus_key": "bass"},
    "VOCALS": {"color": 16755200, "bus_key": "voice"},
    "MUSIC": {"color": 22281984, "bus_key": "acoustic"},
    "ELECTRIC": {"color": 29631999, "bus_key": "electric"},
}

RETURN_COLORS = {
    "beats": 16724787,
    "bass": 33489919,
    "voice": 16755200,
    "acoustic": 22281984,
    "electric": 29631999,
}


def extract_slice_idx(filepath: str) -> int:
    match = re.search(r"_s4_(\d+)_", os.path.basename(filepath))
    return int(match.group(1)) if match else -1


def _indent_block(text: str, prefix: str) -> str:
    return "\n".join(prefix + line if line else prefix.rstrip() for line in text.splitlines())


def _read_text(path: str) -> str | None:
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read().strip()
    return text or None


def _env_from_rows(rows: list[dict], tag: str, value_fn) -> str | None:
    if not rows:
        return None
    points: list[tuple[float, float]] = []
    for i, row in enumerate(rows):
        t_start = float(row["start_time_sec"])
        t_end = float(row["end_time_sec"])
        _append_ramped_points(points, i, t_start, t_end, float(value_fn(row)), 0.05)
    return build_reaper_envelope_chunk(tag, points).strip()


def _is_silent(row: dict) -> bool:
    return str(row.get("is_silent", "")).strip().lower() == "true"


def _gate_value(row: dict) -> float:
    return 0.0 if _is_silent(row) else 1.0


def _pan_value(row: dict) -> float:
    if _is_silent(row):
        return 0.0
    weighted = sum(
        float(row.get(f"prob_{bus}", 0.0) or 0.0) * PAN_LAYOUT.get(bus, 0.0)
        for bus in BUSES
    )
    return max(-1.0, min(1.0, weighted))


def _send_value(row: dict, dest_bus: str) -> float:
    if _is_silent(row):
        return 0.0
    return float(row.get(f"prob_{dest_bus}", 0.0) or 0.0)


def _empty_fxchain(indent: str = "    ") -> list[str]:
    return [
        f"{indent}<FXCHAIN",
        f"{indent}  WNDRECT 0 0 0 0",
        f"{indent}  SHOW 0",
        f"{indent}  LASTSEL 0",
        f"{indent}  DOCKED 0",
        f"{indent}>",
    ]


def _master_fx_block() -> list[str]:
    """Stock JS limiter + loudness meter slots on the project master."""
    return [
        "  <MASTERFXLIST",
        "    SHOW 0",
        "    <FXCHAIN",
        "      WNDRECT 0 0 0 0",
        "      SHOW 0",
        "      LASTSEL 1",
        "      DOCKED 0",
        "      BYPASS 0 0 0",
        '      <JS limiter ""',
        "        0.000000 -0.300000 0.000000",
        "      >",
        '      <JS "Analysis/loudness_meter" ""',
        "        0.000000 -23.000000 0.000000 0.000000",
        "      >",
        "    >",
        "  >",
    ]


def _track_header(
    name: str,
    color: int,
    isbus: str,
    *,
    indent: str = "    ",
) -> list[str]:
    return [
        "  <TRACK",
        f'{indent}NAME "{name}"',
        f"{indent}PEAKCOL {color}",
        f"{indent}VOLPAN 1 0 -1 -1 1",
        f"{indent}MUTESOLO 0 0 0",
        f"{indent}IPHASE 0",
        f"{indent}ISBUS {isbus}",
        f"{indent}MAINSEND 1 0",
        f"{indent}NCHAN 2",
    ]


def _item_block(wav_path: str) -> list[str]:
    slice_idx = extract_slice_idx(wav_path)
    if slice_idx < 0:
        return []
    start_pos = slice_idx * 4.0
    filename = os.path.basename(wav_path)
    posix = wav_path.replace("\\", "/")
    return [
        "    <ITEM",
        f"      POSITION {start_pos:.4f}",
        "      SNAPOFFS 0",
        "      LENGTH 4.0000",
        "      LOOP 0",
        "      ALLTAKES 0",
        "      FADEIN 1 0.005 0 1 0 0 0",
        "      FADEOUT 1 0.005 0 1 0 0 0",
        f'      NAME "{filename}"',
        "      <SOURCE WAVE",
        f'        FILE "{posix}"',
        "      >",
        "    >",
    ]


def create_reaper_project(
    track_dir: str,
    output_rpp: str | None = None,
    sample_rate: int = 44100,
    bpm: float = 120.0,
):
    """
    Assembles a ready-to-open Reaper project for a staging track folder.
    Folder buses, track colors, master FX slots, and AUXVOLENV sends included.
    """
    track_name = os.path.basename(os.path.normpath(track_dir))
    if output_rpp is None:
        safe = re.sub(r'[<>:"/\\|?*]', "_", track_name)
        output_rpp = os.path.join(track_dir, f"{safe}.rpp")

    env_dir = os.path.join(track_dir, "reaper_envelopes")
    csv_path = os.path.join(track_dir, "stem_activity_log.csv")
    wav_files = glob.glob(os.path.join(track_dir, "*.wav"))

    stem_groups: dict[str, list[str]] = {b: [] for b in BUSES}
    for path in wav_files:
        bus = expected_bus_from_filename(os.path.basename(path))
        if bus in stem_groups:
            stem_groups[bus].append(path)
    for bus in BUSES:
        stem_groups[bus].sort(key=lambda p: (extract_slice_idx(p), os.path.basename(p)))

    all_rows: list[dict] = []
    if os.path.isfile(csv_path):
        all_rows = _load_timeline_rows(csv_path, filter_bus=None)
    bus_rows = {
        bus: [row for row in all_rows if _row_matches_bus(row, bus)] for bus in BUSES
    }

    fallback_vol = _read_text(os.path.join(env_dir, "volume_gate.env"))
    fallback_pan = _read_text(os.path.join(env_dir, "pan_auto.env"))
    fallback_sends = {
        bus: _read_text(os.path.join(env_dir, f"send_{idx}_{bus}_volume.env"))
        for idx, bus in enumerate(SEND_BUSES, start=1)
    }

    planned: list[dict] = []
    for folder_name, cfg in TRACK_THEME.items():
        bus = cfg["bus_key"]
        files = stem_groups.get(bus) or []
        if not files:
            continue
        planned.append(
            {
                "kind": "folder",
                "name": f"--- {folder_name} (BUS) ---",
                "color": cfg["color"],
                "isbus": "1 1",
            }
        )
        planned.append(
            {
                "kind": "stem",
                "name": f"{bus.upper()} RAW STEM",
                "bus": bus,
                "color": cfg["color"],
                "isbus": "2 -1",
                "files": files,
            }
        )

    stem_entries = [(i, t) for i, t in enumerate(planned) if t["kind"] == "stem"]
    if stem_entries:
        planned.append(
            {
                "kind": "folder",
                "name": "--- SEND RETURNS ---",
                "color": 8421504,
                "isbus": "1 1",
            }
        )
        for i, dest in enumerate(SEND_BUSES):
            last = i == len(SEND_BUSES) - 1
            planned.append(
                {
                    "kind": "return",
                    "name": f"AUX {dest.upper()}",
                    "bus": dest,
                    "color": RETURN_COLORS[dest],
                    "isbus": "2 1" if last else "0 0",
                }
            )

    rpp_lines = [
        '<REAPER_PROJECT 0.1 "7.0/x64" 1718000000',
        "  RPR_VERSION 7.0",
        f"  SAMPLERATE {sample_rate} 0 0",
        f"  TEMPO {bpm} 4 4",
        "  TIMEMODE 0 0 -1 30 0 0 0 0",
        "  MASTER_VOLUME 0 0 -1 -1 1",
        "  PANLAW 1.00000000000000 0",
    ]
    rpp_lines.extend(_master_fx_block())

    tracks_written = 0
    item_count = 0
    for spec in planned:
        tracks_written += 1
        rpp_lines.extend(
            _track_header(spec["name"], spec["color"], spec["isbus"])
        )

        if spec["kind"] == "stem":
            bus = spec["bus"]
            rows = bus_rows.get(bus) or []
            vol = _env_from_rows(rows, "VOLENV", _gate_value) or fallback_vol
            pan = _env_from_rows(rows, "PANENV", _pan_value) or fallback_pan
            if vol:
                rpp_lines.append(_indent_block(vol, "    "))
            if pan:
                rpp_lines.append(_indent_block(pan, "    "))
            for wav_path in spec["files"]:
                block = _item_block(wav_path)
                if block:
                    item_count += 1
                    rpp_lines.extend(block)

        elif spec["kind"] == "return":
            dest = spec["bus"]
            for src_idx, src in stem_entries:
                src_bus = src["bus"]
                if src_bus == dest:
                    continue
                src_rows = bus_rows.get(src_bus) or []
                aux = _env_from_rows(
                    src_rows, "AUXVOLENV", lambda row, d=dest: _send_value(row, d)
                ) or fallback_sends.get(dest)
                rpp_lines.append(
                    "    AUXRECV "
                    f"{src_idx} 0 1.00000000000000 0.00000000000000 "
                    "0 0 0 0 0 -1.00000000000000 0 -1 ''"
                )
                if aux:
                    rpp_lines.append(_indent_block(aux, "    "))

        rpp_lines.extend(_empty_fxchain())
        rpp_lines.append("  >")

    rpp_lines.append(">")

    with open(output_rpp, "w", encoding="utf-8") as handle:
        handle.write("\n".join(rpp_lines) + "\n")

    print(
        f"[RPP EXPORT] {output_rpp} ({tracks_written} tracks, {item_count} items)"
    )
    return output_rpp


def create_reaper_project_advanced(track_dir, output_rpp=None, sample_rate=44100, bpm=120.0):
    """Alias used by the folder-theme mix template."""
    return create_reaper_project(
        track_dir, output_rpp=output_rpp, sample_rate=sample_rate, bpm=bpm
    )


if __name__ == "__main__":
    out = create_reaper_project_advanced(r"C:\staging_slices\001 - ANiMAL - Clinic A")
    print(f"[REAPER RPP] Project created with Sub-Mix Folders: {out}")
