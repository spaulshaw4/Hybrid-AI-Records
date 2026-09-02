"""LANDR zip intake ledger on the corpus SQLite file (``pack_manifest``).

Scans ``incoming_zips`` only by default. Copy LANDR zips there — do not point
this at ``D:\\MusicDatasets`` root (``fma_full.zip`` and other dataset archives
are multi-GB). ``--also-scan-root`` may register top-level zips as PENDING but
never extracts them; extract still requires the zip inside ``incoming_zips``.

Statuses: PENDING, UNZIPPED, SLICED, READY_TO_GO, FAILED.
Does not extract into ``corpus_4s`` or ``uploaded_slices``.
Windows unzip via ``zipfile`` (no password cracking). Skips ``__MACOSX``,
``.DS_Store``, AppleDouble ``._*``, and macOS ``Icon\\r``. One junk member
must not fail the pack.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import sqlite3
import sys
import time
import zipfile
from typing import Any

DEFAULT_WORKSTATION = r"D:\MusicDatasets"
DEFAULT_INCOMING = os.path.join(DEFAULT_WORKSTATION, "incoming_zips")
DEFAULT_RAW_PACKS = os.path.join(DEFAULT_WORKSTATION, "raw_packs")
DEFAULT_DB = os.path.join(DEFAULT_WORKSTATION, "db", "corpus_index.sqlite")

STATUSES = ("PENDING", "UNZIPPED", "SLICED", "READY_TO_GO", "FAILED")
SKIP_UNZIP_DONE = frozenset({"UNZIPPED", "SLICED", "READY_TO_GO"})
FORBIDDEN_DIR_NAMES = frozenset({"corpus_4s", "uploaded_slices", "uploaded_slice"})
SKIP_MEMBER_NAMES = frozenset({".ds_store", "thumbs.db"})
AUDIO_EXTS = frozenset({".wav", ".flac", ".aif", ".aiff"})
REFUSE_ZIP_PREFIXES = ("fma_full",)

PACK_MANIFEST_DDL = """
CREATE TABLE IF NOT EXISTS pack_manifest (
    pack_name TEXT PRIMARY KEY,
    zip_filename TEXT,
    status TEXT,
    raw_path TEXT,
    slice_count INTEGER DEFAULT 0,
    updated_at REAL
)
"""


def pack_name_from_zip(zip_filename: str) -> str:
    base = os.path.splitext(os.path.basename(zip_filename))[0]
    return re.sub(r"[\s\-]+", "_", base).strip("_") or "unnamed_pack"


def refused_zip_name(zip_filename: str) -> bool:
    name = os.path.basename(zip_filename).lower()
    return any(name.startswith(prefix) for prefix in REFUSE_ZIP_PREFIXES)


def is_drive_or_workstation_root(path: str, workstation: str = DEFAULT_WORKSTATION) -> bool:
    norm = os.path.normcase(os.path.normpath(os.path.abspath(path)))
    ws = os.path.normcase(os.path.normpath(os.path.abspath(workstation)))
    _drive, tail = os.path.splitdrive(norm)
    if tail in ("", os.sep):
        return True
    return norm == ws


def assert_safe_raw_packs(raw_packs: str, workstation: str = DEFAULT_WORKSTATION) -> None:
    if is_drive_or_workstation_root(raw_packs, workstation=workstation):
        raise ValueError(
            f"Refusing extract root {raw_packs}: that is a drive or workstation root. "
            "Use D:\\MusicDatasets\\raw_packs."
        )
    parts = {p.lower() for p in os.path.normpath(raw_packs).split(os.sep) if p}
    if parts & FORBIDDEN_DIR_NAMES:
        raise ValueError(
            f"Refusing to extract into corpus_4s or uploaded_slices ({raw_packs})."
        )


def connect_corpus_db(db_path: str) -> sqlite3.Connection:
    parent = os.path.dirname(os.path.abspath(db_path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute(PACK_MANIFEST_DDL)
    conn.commit()
    return conn


def list_packs(conn: sqlite3.Connection, status: str | None = None) -> list[dict[str, Any]]:
    if status:
        rows = conn.execute(
            "SELECT pack_name, zip_filename, status, raw_path, slice_count, updated_at "
            "FROM pack_manifest WHERE status = ? ORDER BY pack_name",
            (status,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT pack_name, zip_filename, status, raw_path, slice_count, updated_at "
            "FROM pack_manifest ORDER BY pack_name"
        ).fetchall()
    return [
        {
            "pack_name": row[0],
            "zip_filename": row[1],
            "status": row[2],
            "raw_path": row[3],
            "slice_count": int(row[4] or 0),
            "updated_at": row[5],
        }
        for row in rows
    ]


def get_pack(conn: sqlite3.Connection, pack_name: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT pack_name, zip_filename, status, raw_path, slice_count, updated_at "
        "FROM pack_manifest WHERE pack_name = ?",
        (pack_name,),
    ).fetchone()
    if not row:
        return None
    return {
        "pack_name": row[0],
        "zip_filename": row[1],
        "status": row[2],
        "raw_path": row[3],
        "slice_count": int(row[4] or 0),
        "updated_at": row[5],
    }


def upsert_pack(
    conn: sqlite3.Connection,
    pack_name: str,
    zip_filename: str,
    status: str,
    raw_path: str,
    slice_count: int | None = None,
) -> None:
    now = time.time()
    existing = get_pack(conn, pack_name)
    if existing is None:
        conn.execute(
            "INSERT INTO pack_manifest "
            "(pack_name, zip_filename, status, raw_path, slice_count, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (pack_name, zip_filename, status, raw_path, int(slice_count or 0), now),
        )
    else:
        if slice_count is None:
            conn.execute(
                "UPDATE pack_manifest SET zip_filename = ?, status = ?, raw_path = ?, "
                "updated_at = ? WHERE pack_name = ?",
                (zip_filename, status, raw_path, now, pack_name),
            )
        else:
            conn.execute(
                "UPDATE pack_manifest SET zip_filename = ?, status = ?, raw_path = ?, "
                "slice_count = ?, updated_at = ? WHERE pack_name = ?",
                (zip_filename, status, raw_path, int(slice_count), now, pack_name),
            )
    conn.commit()


def scan_zip_files(incoming: str) -> list[str]:
    if not os.path.isdir(incoming):
        return []
    found = [
        os.path.join(incoming, name)
        for name in os.listdir(incoming)
        if name.lower().endswith(".zip") and os.path.isfile(os.path.join(incoming, name))
    ]
    found.sort(key=lambda p: os.path.basename(p).lower())
    return found


def count_audio_files(root: str, limit: int | None = None) -> int:
    if not os.path.isdir(root):
        return 0
    n = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d.lower() not in FORBIDDEN_DIR_NAMES]
        for name in filenames:
            if os.path.splitext(name)[1].lower() in AUDIO_EXTS:
                n += 1
                if limit is not None and n >= limit:
                    return n
    return n


def _is_junk_leaf(leaf: str) -> bool:
    """True for macOS/Windows metadata names that must not be written to disk."""
    lowered = leaf.lower()
    if lowered in SKIP_MEMBER_NAMES:
        return True
    if leaf.startswith("._"):
        return True
    core = leaf.replace("\r", "").replace("\n", "")
    if core.lower() == "icon" and core != leaf:
        return True
    return False


def _member_parts(name: str) -> list[str] | None:
    unix = name.replace("\\", "/").lstrip("/")
    parts = [p for p in unix.split("/") if p and p != "."]
    if not parts or ".." in parts:
        return None
    if parts[0] == "__MACOSX" or "__MACOSX" in parts:
        return None
    if any(_is_junk_leaf(p) for p in parts):
        return None
    return parts


def safe_member_dest(dest_root: str, name: str) -> str | None:
    parts = _member_parts(name)
    if parts is None:
        return None
    dest = os.path.abspath(os.path.join(dest_root, *parts))
    root = os.path.abspath(dest_root)
    if dest != root and not dest.startswith(root + os.sep):
        return None
    return dest


def extract_zip_to(zip_path: str, dest_dir: str) -> int:
    """Extract ``zip_path`` into ``dest_dir``. Returns extracted file count.

    Skips ``__MACOSX``, ``.DS_Store``, AppleDouble ``._*``, and ``Icon\\r``.
    Per-member OS errors are skipped so one junk name cannot abort the pack.
    Does not try passwords.
    """
    os.makedirs(dest_dir, exist_ok=True)
    extracted = 0
    with zipfile.ZipFile(zip_path, "r") as zf:
        for info in zf.infolist():
            dest = safe_member_dest(dest_dir, info.filename)
            if dest is None:
                continue
            if info.is_dir() or info.filename.replace("\\", "/").endswith("/"):
                try:
                    os.makedirs(dest, exist_ok=True)
                except OSError as exc:
                    print(
                        f"[WARN] skip dir {info.filename!r} in "
                        f"{os.path.basename(zip_path)}: {exc}"
                    )
                continue
            try:
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with zf.open(info, "r") as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)
            except RuntimeError as exc:
                raise RuntimeError(
                    f"Encrypted or unreadable member {info.filename!r} in "
                    f"{os.path.basename(zip_path)}: {exc}"
                ) from exc
            except OSError as exc:
                print(
                    f"[WARN] skip member {info.filename!r} in "
                    f"{os.path.basename(zip_path)}: {exc}"
                )
                continue
            extracted += 1
    return extracted


def print_ledger_status(conn: sqlite3.Connection) -> None:
    rows = list_packs(conn)
    print(f"PACK LEDGER  ({len(rows)} row(s))")
    if not rows:
        print("  (empty -- no packs registered)")
        return
    for row in rows:
        print(
            f"  {row['pack_name']}  status={row['status']}  zip={row['zip_filename']}  "
            f"slice_count={row['slice_count']}  raw={row['raw_path']}"
        )


def advance_to_sliced(conn: sqlite3.Connection, pack_name: str, slice_count: int = 0) -> bool:
    row = get_pack(conn, pack_name)
    if row is None:
        print(f"[WARN] pack {pack_name} not in pack_manifest; skip SLICED")
        return False
    if row["status"] != "UNZIPPED":
        print(
            f"[WARN] {pack_name} status is {row['status']}, not UNZIPPED; skip SLICED"
        )
        return False
    upsert_pack(
        conn,
        pack_name,
        row["zip_filename"] or "",
        "SLICED",
        row["raw_path"] or "",
        slice_count=int(slice_count),
    )
    print(f"[SLICED] {pack_name} slice_count={int(slice_count)}")
    return True


def advance_unzipped_all(conn: sqlite3.Connection, slice_count: int = 0) -> int:
    names = [row["pack_name"] for row in list_packs(conn, status="UNZIPPED")]
    ok = 0
    for name in names:
        if advance_to_sliced(conn, name, slice_count=slice_count):
            ok += 1
    return ok


def advance_to_ready(conn: sqlite3.Connection, pack_name: str | None = None) -> int:
    now = time.time()
    if pack_name:
        row = get_pack(conn, pack_name)
        if row is None:
            print(f"[WARN] pack {pack_name} not in pack_manifest; skip READY_TO_GO")
            return 0
        if row["status"] != "SLICED":
            print(
                f"[WARN] {pack_name} status is {row['status']}, not SLICED; "
                "READY_TO_GO is only set after a successful index of SLICED packs"
            )
            return 0
        conn.execute(
            "UPDATE pack_manifest SET status = ?, updated_at = ? WHERE pack_name = ?",
            ("READY_TO_GO", now, pack_name),
        )
        conn.commit()
        print(f"[READY_TO_GO] {pack_name}")
        return 1
    cur = conn.execute(
        "UPDATE pack_manifest SET status = ?, updated_at = ? WHERE status = ?",
        ("READY_TO_GO", now, "SLICED"),
    )
    conn.commit()
    n = int(cur.rowcount or 0)
    if n:
        print(f"[READY_TO_GO] {n} SLICED pack(s)")
    else:
        print("no SLICED packs to mark READY_TO_GO")
    return n


def mark_failed(conn: sqlite3.Connection, pack_name: str, zip_filename: str, raw_path: str) -> None:
    upsert_pack(conn, pack_name, zip_filename, "FAILED", raw_path)


def process_incoming_zips(
    incoming: str,
    raw_packs: str,
    db_path: str,
    dry_run: bool = False,
    also_scan_root: bool = False,
    dataset_root: str = DEFAULT_WORKSTATION,
) -> dict[str, Any]:
    os.makedirs(incoming, exist_ok=True)
    os.makedirs(raw_packs, exist_ok=True)
    assert_safe_raw_packs(raw_packs, workstation=dataset_root)

    summary: dict[str, Any] = {
        "incoming_empty": False,
        "zips": [],
        "registered": [],
        "extracted": [],
        "skipped": [],
        "failed": [],
        "root_listed": [],
    }

    incoming_zips = scan_zip_files(incoming)
    summary["zips"] = [os.path.basename(p) for p in incoming_zips]

    conn = connect_corpus_db(db_path)
    try:
        if not incoming_zips:
            summary["incoming_empty"] = True
            print(
                "incoming_zips empty -- copy LANDR zip files into "
                f"{incoming} (do not unzip fma_full.zip or other top-level "
                "dataset archives; default scan is incoming_zips only)."
            )
        for zip_path in incoming_zips:
            zip_filename = os.path.basename(zip_path)
            name = pack_name_from_zip(zip_filename)
            dest = os.path.join(os.path.abspath(raw_packs), name)
            if refused_zip_name(zip_filename):
                print(
                    f"[SKIP] refusing {zip_filename} (dataset archive, not a LANDR pack)"
                )
                summary["skipped"].append(zip_filename)
                continue
            existing = get_pack(conn, name)
            if existing and existing["status"] in SKIP_UNZIP_DONE:
                print(
                    f"[SKIP] {zip_filename} already {existing['status']} "
                    f"({existing['raw_path']})"
                )
                summary["skipped"].append(zip_filename)
                continue
            if existing is None or existing["status"] in {"PENDING", "FAILED"}:
                upsert_pack(conn, name, zip_filename, "PENDING", dest)
                if name not in summary["registered"]:
                    summary["registered"].append(name)
                print(f"[PENDING] {zip_filename} -> {dest}")
            if dry_run:
                print(f"[DRY-RUN] would extract {zip_filename} -> {dest}")
                continue
            try:
                count = extract_zip_to(zip_path, dest)
            except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
                mark_failed(conn, name, zip_filename, dest)
                summary["failed"].append(zip_filename)
                print(f"[FAILED] {zip_filename}: {exc}")
                continue
            if count < 1:
                mark_failed(conn, name, zip_filename, dest)
                summary["failed"].append(zip_filename)
                print(f"[FAILED] {zip_filename}: no extractable files")
                continue
            upsert_pack(conn, name, zip_filename, "UNZIPPED", dest)
            summary["extracted"].append(zip_filename)
            print(f"[UNZIPPED] {zip_filename} files={count} dest={dest}")

        if also_scan_root:
            root_zips = scan_zip_files(dataset_root)
            incoming_names = {os.path.basename(p).lower() for p in incoming_zips}
            for zip_path in root_zips:
                zip_filename = os.path.basename(zip_path)
                if zip_filename.lower() in incoming_names:
                    continue
                if refused_zip_name(zip_filename):
                    print(
                        f"[SKIP] refusing top-level {zip_filename} "
                        "(dataset archive; copy LANDR zips into incoming_zips)"
                    )
                    summary["skipped"].append(zip_filename)
                    continue
                name = pack_name_from_zip(zip_filename)
                dest = os.path.join(os.path.abspath(raw_packs), name)
                existing = get_pack(conn, name)
                if existing and existing["status"] in SKIP_UNZIP_DONE:
                    summary["skipped"].append(zip_filename)
                    continue
                if existing is None:
                    upsert_pack(conn, name, zip_filename, "PENDING", dest)
                    summary["registered"].append(name)
                summary["root_listed"].append(zip_filename)
                print(
                    f"[PENDING] top-level {zip_filename} registered only -- "
                    "copy it into incoming_zips to extract. "
                    "Default ingest does not unzip D:\\MusicDatasets\\*.zip."
                )

        print_ledger_status(conn)
    finally:
        conn.close()
    return summary


def _print_paths(conn: sqlite3.Connection, status: str) -> int:
    rows = list_packs(conn, status=status)
    for row in rows:
        path = row["raw_path"] or ""
        print(path)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Unzip LANDR packs from incoming_zips into raw_packs and log pack_manifest. "
            "Default scan is incoming_zips only — copy LANDR zips there. "
            "Does not extract fma_full.zip or scan D:\\MusicDatasets root unless "
            "--also-scan-root (register PENDING only; still no root extract)."
        )
    )
    parser.add_argument("--incoming", default=DEFAULT_INCOMING)
    parser.add_argument("--raw-packs", default=DEFAULT_RAW_PACKS)
    parser.add_argument("--db", default=DEFAULT_DB, help="Corpus SQLite (slice_index + pack_manifest)")
    parser.add_argument(
        "--dataset-root",
        default=DEFAULT_WORKSTATION,
        help="Used only with --also-scan-root (never extracted from)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Register PENDING and list zips; do not extract",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="Print pack_manifest only (no unzip)",
    )
    parser.add_argument(
        "--status",
        action="store_true",
        help="Alias of --list",
    )
    parser.add_argument(
        "--also-scan-root",
        action="store_true",
        help=(
            "Also register D:\\MusicDatasets\\*.zip as PENDING (skips fma_full.zip). "
            "Does not extract those zips. Default ingest must not pass this."
        ),
    )
    parser.add_argument("--print-paths", choices=list(STATUSES), default=None)
    parser.add_argument("--advance-sliced", metavar="PACK_NAME")
    parser.add_argument("--advance-sliced-all", action="store_true")
    parser.add_argument("--slice-count", type=int, default=0)
    parser.add_argument("--advance-ready", nargs="?", const="*", metavar="PACK_NAME")
    parser.add_argument("--set-failed", metavar="PACK_NAME")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    conn = connect_corpus_db(args.db)
    try:
        if args.list or args.status:
            print_ledger_status(conn)
            return 0
        if args.print_paths:
            return _print_paths(conn, args.print_paths)
        if args.advance_sliced:
            ok = advance_to_sliced(conn, args.advance_sliced, slice_count=args.slice_count)
            return 0 if ok else 1
        if args.advance_sliced_all:
            advance_unzipped_all(conn, slice_count=args.slice_count)
            return 0
        if args.advance_ready is not None:
            pack = None if args.advance_ready == "*" else args.advance_ready
            advance_to_ready(conn, pack_name=pack)
            return 0
        if args.set_failed:
            row = get_pack(conn, args.set_failed)
            mark_failed(
                conn,
                args.set_failed,
                (row or {}).get("zip_filename") or "",
                (row or {}).get("raw_path") or "",
            )
            print(f"[FAILED] {args.set_failed}")
            return 0
    finally:
        conn.close()

    process_incoming_zips(
        args.incoming,
        args.raw_packs,
        args.db,
        dry_run=args.dry_run,
        also_scan_root=args.also_scan_root,
        dataset_root=args.dataset_root,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
