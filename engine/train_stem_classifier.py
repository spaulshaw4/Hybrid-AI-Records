"""Train a CPU stem-role classifier (drums / bass / vocals / other).

Labels come from musdb18 / dsd100 ground-truth slice names under
``D:\\MusicDatasets\\corpus_4s`` (``drums_s4_*``, ``bass_s4_*``, ...). Features
come from the audio itself (``ml.audio_features``) — filenames are never an
input at inference. The train/val cut is by source track so two 4 s slices of
the same song cannot leak across the split.

Backend: scikit-learn ``HistGradientBoostingClassifier`` when sklearn imports;
otherwise a real numpy boosted-stump ensemble (``ml.boosted_trees``), not a
hard-coded 100% lookup.

Usage (Python 3.12, no venv)::

    python engine/train_stem_classifier.py --per-group 20 --workers 6
    python engine/train_stem_classifier.py --skip-train --ml-backfill --backfill-limit 200

``--ml-backfill`` is the only writer of ``stem_type_ml`` / ``stem_type_ml_confidence``.
It never updates ``stem_type``.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.abspath(os.path.join(_HERE, ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from ml.audio_features import N_FEATURES, extract_from_file, feature_names  # noqa: E402
from ml.dataset_manifest import CLASSES, CORPUS_ROOT, build_manifest, summarize  # noqa: E402
from ml.split import assert_no_leakage, group_split  # noqa: E402

DEFAULT_CACHE = os.path.join(_REPO, "ml", "cache", "stem_features.npz")
DEFAULT_MODEL = os.path.join(_REPO, "models", "stem_classifier.joblib")


def sklearn_available() -> tuple[bool, str]:
    """Return ``(ok, version_or_reason)``. Never raises."""
    try:
        import sklearn

        return True, str(sklearn.__version__)
    except Exception as exc:  # pragma: no cover - environment-dependent
        return False, f"{type(exc).__name__}: {exc}"


def _extract(path: str) -> tuple[str, np.ndarray | None]:
    return path, extract_from_file(path)


def select_subset(records, per_group: int, seed: int = 7):
    """Cap slices per (track, label) so long songs cannot dominate."""
    rng = np.random.default_rng(seed)
    buckets: dict[tuple[str, str], list] = defaultdict(list)
    for rec in records:
        buckets[(rec.track_id, rec.label)].append(rec)
    chosen = []
    for key in sorted(buckets):
        group = buckets[key]
        if len(group) <= per_group:
            chosen.extend(group)
        else:
            picks = rng.choice(len(group), size=per_group, replace=False)
            chosen.extend(group[i] for i in sorted(picks))
    chosen.sort(key=lambda r: r.path)
    return chosen


def build_feature_matrix(records, workers: int, cache_path: str):
    """Extract (or load cached) features. Returns ``(X, y, groups, paths)``."""
    wanted = [r.path for r in records]
    cached: dict[str, np.ndarray] = {}
    if os.path.isfile(cache_path):
        with np.load(cache_path, allow_pickle=False) as data:
            keys = list(data["paths"])
            mat = data["X"]
        cached = {str(k): mat[i] for i, k in enumerate(keys)}
        print(f"[cache] loaded {len(cached)} vectors from {cache_path}")

    missing = [p for p in wanted if p not in cached]
    if missing:
        print(f"[extract] {len(missing)} slices with {workers} worker(s)...")
        start = time.perf_counter()
        done = 0
        if workers > 1:
            with ProcessPoolExecutor(max_workers=workers) as pool:
                for path, vec in pool.map(_extract, missing, chunksize=16):
                    if vec is not None:
                        cached[path] = vec
                    done += 1
                    if done % 500 == 0:
                        rate = done / max(time.perf_counter() - start, 1e-9)
                        print(f"  {done}/{len(missing)}  {rate:.1f} files/s")
        else:
            for path in missing:
                _, vec = _extract(path)
                if vec is not None:
                    cached[path] = vec
        print(f"[extract] done in {time.perf_counter() - start:.1f}s")
        os.makedirs(os.path.dirname(cache_path) or ".", exist_ok=True)
        keys = sorted(cached)
        np.savez_compressed(
            cache_path,
            paths=np.array(keys),
            X=np.stack([cached[k] for k in keys]).astype(np.float32),
        )
        print(f"[cache] wrote {len(keys)} vectors to {cache_path}")

    usable = [r for r in records if r.path in cached]
    skipped = len(records) - len(usable)
    if skipped:
        print(f"[warn] {skipped} slices unreadable and dropped")
    X = np.stack([cached[r.path] for r in usable]).astype(np.float32)
    y = np.array([r.label for r in usable])
    groups = np.array([r.track_id for r in usable])
    return X, y, groups, [r.path for r in usable]


def confusion(y_true: np.ndarray, y_pred: np.ndarray, labels: list[str]) -> np.ndarray:
    index = {lab: i for i, lab in enumerate(labels)}
    mat = np.zeros((len(labels), len(labels)), dtype=int)
    for t, p in zip(y_true, y_pred):
        if t not in index or p not in index:
            continue
        mat[index[t], index[p]] += 1
    return mat


def print_report(y_true, y_pred, labels: list[str]) -> dict:
    mat = confusion(y_true, y_pred, labels)
    accuracy = float(np.mean(y_true == y_pred)) if len(y_true) else 0.0
    width = max(len(lab) for lab in labels) + 2
    print("\nConfusion matrix (rows = truth, cols = predicted)")
    print(" " * width + "".join(f"{lab:>10}" for lab in labels) + f"{'recall':>10}")
    per_class = {}
    for i, lab in enumerate(labels):
        row = mat[i]
        recall = float(row[i] / max(row.sum(), 1))
        print(f"{lab:<{width}}" + "".join(f"{v:>10}" for v in row) + f"{recall:>10.3f}")
        precision = float(mat[i, i] / max(mat[:, i].sum(), 1))
        f1 = 2 * precision * recall / max(precision + recall, 1e-9)
        per_class[lab] = {
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "support": int(row.sum()),
        }
    print(f"\noverall accuracy: {accuracy:.4f}  (n={len(y_true)})")
    macro_f1 = float(np.mean([v["f1"] for v in per_class.values()])) if per_class else 0.0
    print(f"macro F1: {macro_f1:.4f}")
    return {
        "accuracy": round(accuracy, 4),
        "macro_f1": round(macro_f1, 4),
        "per_class": per_class,
        "confusion": mat.tolist(),
        "labels": labels,
    }


def fit_classifier(X_train: np.ndarray, y_train: np.ndarray, seed: int, force_fallback: bool = False):
    """Fit sklearn HistGB if present, else numpy boosted stumps."""
    ok, info = sklearn_available()
    if ok and not force_fallback:
        from sklearn.ensemble import HistGradientBoostingClassifier

        model = HistGradientBoostingClassifier(
            max_iter=400,
            learning_rate=0.08,
            max_leaf_nodes=31,
            l2_regularization=1.0,
            early_stopping=True,
            validation_fraction=0.15,
            random_state=seed,
        )
        model.fit(X_train, y_train)
        backend = f"sklearn {info} HistGradientBoostingClassifier"
        return model, backend, int(getattr(model, "n_iter_", 0) or 0)
    if not ok:
        print(f"[backend] sklearn is not installed ({info}); using numpy boosted stumps.")
    else:
        print("[backend] --force-fallback: numpy boosted stumps instead of sklearn.")
    from ml.boosted_trees import NumpyBoostedTrees

    model = NumpyBoostedTrees(
        n_estimators=80,
        learning_rate=0.12,
        max_bins=24,
        seed=seed,
    )
    model.fit(X_train, y_train)
    return model, "numpy boosted stumps (sklearn missing or --force-fallback)", int(model.n_iter_)


def save_artifact(artifact: dict, path: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    try:
        import joblib

        joblib.dump(artifact, path, compress=3)
    except Exception:
        import pickle

        with open(path, "wb") as handle:
            pickle.dump(artifact, handle, protocol=4)


def _filename_baseline(paths: list[str], y: np.ndarray, val_idx: np.ndarray) -> float:
    """Keyword-rule accuracy on the same held-out slices (not used at inference)."""
    from db.index_578gb_corpus import infer_stem_type

    rule_to_truth = {
        "rhythm": "drums",
        "vocal": "vocals",
        "lead": "other",
        "harmonic": "other",
    }
    hits = 0
    for i in val_idx:
        guess = rule_to_truth.get(
            infer_stem_type(paths[i].lower().replace("\\", "/")), "other"
        )
        hits += int(guess == y[i])
    return hits / max(len(val_idx), 1)


def run_training(
    *,
    corpus: str = CORPUS_ROOT,
    per_group: int = 20,
    workers: int = 6,
    val_fraction: float = 0.25,
    seed: int = 1337,
    cache: str = DEFAULT_CACHE,
    out: str = DEFAULT_MODEL,
    force_fallback: bool = False,
) -> dict:
    """Train, print the held-out report, save the artifact. Returns metrics."""
    ok, info = sklearn_available()
    if ok:
        print(f"[backend] sklearn {info} available — HistGradientBoostingClassifier")
    else:
        print(f"[backend] sklearn NOT available ({info}) — numpy/scipy boosted stumps")

    records = build_manifest(root=corpus)
    print("[manifest]", json.dumps(summarize(records), indent=2))
    if not records:
        raise FileNotFoundError(
            f"no labeled musdb/dsd100 slices under {corpus} "
            "(expected drums_s4_*.wav, bass_s4_*.wav, vocals_s4_*.wav, other_s4_*.wav)"
        )
    subset = select_subset(records, per_group, seed=seed)
    print(f"[subset] {len(subset)} slices (<= {per_group} per track+label)")

    X, y, groups, paths = build_feature_matrix(subset, workers, cache)
    print(f"[data] X={X.shape} classes={sorted(set(y.tolist()))} groups={len(set(groups))}")
    if X.shape[1] != N_FEATURES:
        raise RuntimeError(f"feature width {X.shape[1]} != {N_FEATURES}")

    train_idx, val_idx = group_split(groups, val_fraction, seed=seed)
    assert_no_leakage(groups, train_idx, val_idx)
    print(
        f"[split] train={len(train_idx)} slices / {len(set(groups[train_idx]))} songs, "
        f"val={len(val_idx)} slices / {len(set(groups[val_idx]))} songs, no shared songs"
    )

    start = time.perf_counter()
    model, backend, n_iter = fit_classifier(
        X[train_idx], y[train_idx], seed=seed, force_fallback=force_fallback
    )
    train_secs = time.perf_counter() - start
    print(f"[train] {backend}; fit in {train_secs:.1f}s, {n_iter} boosting iterations")

    labels = list(CLASSES)
    y_pred = model.predict(X[val_idx])
    report = print_report(y[val_idx], y_pred, labels)

    proba = model.predict_proba(X[val_idx])
    confidence = proba.max(axis=1)
    correct = y[val_idx] == y_pred
    print("\nConfidence calibration on held-out songs:")
    for threshold in (0.5, 0.7, 0.9):
        keep = confidence >= threshold
        coverage = float(np.mean(keep))
        precision = float(np.mean(correct[keep])) if keep.any() else float("nan")
        print(
            f"  conf >= {threshold:.1f}: covers {coverage:6.1%} of slices, "
            f"accuracy {precision:.4f}"
        )

    baseline = _filename_baseline(paths, y, val_idx)
    print(f"\nFilename-keyword baseline on the same held-out slices: {baseline:.4f}")
    print("(inference does not use filenames; this line is a comparison only)")

    artifact = {
        "model": model,
        "labels": labels,
        "feature_names": feature_names(),
        "n_features": N_FEATURES,
        "metrics": report,
        "backend": backend,
        "train_seconds": round(train_secs, 2),
        "sklearn_version": info if ok and not force_fallback else None,
    }
    save_artifact(artifact, out)
    size_mb = os.path.getsize(out) / 1e6
    print(f"\n[save] {out} ({size_mb:.2f} MB)")
    report_path = os.path.splitext(out)[0] + "_metrics.json"
    payload = {
        **report,
        "backend": backend,
        "train_seconds": round(train_secs, 2),
        "filename_baseline_accuracy": round(baseline, 4),
        "n_train": int(len(train_idx)),
        "n_val": int(len(val_idx)),
        "n_groups_train": int(len(set(groups[train_idx]))),
        "n_groups_val": int(len(set(groups[val_idx]))),
    }
    with open(report_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
    print(f"[save] {report_path}")
    return payload


def backfill_stem_type_ml(
    db_path: str,
    model_path: str = DEFAULT_MODEL,
    limit: int = 200,
    only_unlabeled: bool = True,
) -> dict:
    """Write ``stem_type_ml`` + confidence for up to ``limit`` indexed rows.

    Requires the caller to pass ``--ml-backfill``. Never writes ``stem_type``.
    """
    from db.index_578gb_corpus import ensure_ml_columns
    from ml.stem_classifier import StemClassifier

    if not os.path.isfile(db_path):
        raise FileNotFoundError(db_path)
    if not os.path.isfile(model_path):
        raise FileNotFoundError(
            f"No classifier at {model_path}. Train first: "
            "python engine/train_stem_classifier.py"
        )

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA journal_mode=WAL")
    ensure_ml_columns(conn)
    conn.commit()
    try:
        sql = "SELECT file_path, stem_type FROM slice_index WHERE file_path IS NOT NULL"
        if only_unlabeled:
            sql += " AND (stem_type_ml IS NULL OR stem_type_ml = '')"
        sql += " ORDER BY id LIMIT ?"
        rows = conn.execute(sql, (max(1, int(limit)),)).fetchall()
        clf = StemClassifier(model_path)
        updated = 0
        skipped = 0
        unchanged_stem_type = 0
        for path, old_stem in rows:
            if not path or not os.path.isfile(path):
                skipped += 1
                continue
            pred = clf.predict_file(str(path))
            if pred is None:
                skipped += 1
                continue
            conn.execute(
                "UPDATE slice_index SET stem_type_ml = ?, stem_type_ml_confidence = ? "
                "WHERE file_path = ?",
                (pred.role, float(pred.confidence), path),
            )
            row = conn.execute(
                "SELECT stem_type FROM slice_index WHERE file_path = ?",
                (path,),
            ).fetchone()
            if row is not None and row[0] == old_stem:
                unchanged_stem_type += 1
            updated += 1
            if updated % 25 == 0:
                conn.commit()
        conn.commit()
        result = {
            "updated": updated,
            "skipped": skipped,
            "candidates": len(rows),
            "stem_type_unchanged": unchanged_stem_type,
        }
        print(
            f"[ml-backfill] updated={updated} skipped={skipped} "
            f"candidates={len(rows)} stem_type_unchanged={unchanged_stem_type}"
        )
        return result
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", default=CORPUS_ROOT)
    parser.add_argument("--per-group", type=int, default=20, help="max slices per (track, label)")
    parser.add_argument("--workers", type=int, default=6, help="feature-extraction processes")
    parser.add_argument("--val-fraction", type=float, default=0.25)
    parser.add_argument("--seed", type=int, default=1337)
    parser.add_argument("--cache", default=DEFAULT_CACHE)
    parser.add_argument("--out", default=DEFAULT_MODEL)
    parser.add_argument(
        "--force-fallback",
        action="store_true",
        help="train the numpy stumps even if sklearn is installed",
    )
    parser.add_argument("--skip-train", action="store_true", help="do not fit; use an existing artifact")
    parser.add_argument(
        "--ml-backfill",
        action="store_true",
        help="flag: write stem_type_ml + confidence for a subset of slice_index",
    )
    parser.add_argument("--db", default=None, help="slice_index sqlite (default: corpus index)")
    parser.add_argument("--backfill-limit", type=int, default=200)
    parser.add_argument(
        "--backfill-all-labeled",
        action="store_true",
        help="also overwrite existing stem_type_ml values in the subset",
    )
    args = parser.parse_args(argv)

    if not args.skip_train:
        try:
            run_training(
                corpus=args.corpus,
                per_group=args.per_group,
                workers=args.workers,
                val_fraction=args.val_fraction,
                seed=args.seed,
                cache=args.cache,
                out=args.out,
                force_fallback=args.force_fallback,
            )
        except FileNotFoundError as exc:
            print(f"[FATAL] {exc}", file=sys.stderr)
            return 1

    if args.ml_backfill:
        from db.index_578gb_corpus import default_index_db

        db_path = args.db or default_index_db()
        try:
            backfill_stem_type_ml(
                db_path,
                model_path=args.out,
                limit=args.backfill_limit,
                only_unlabeled=not args.backfill_all_labeled,
            )
        except FileNotFoundError as exc:
            print(f"[FATAL] {exc}", file=sys.stderr)
            return 1
    elif args.skip_train:
        print("[FATAL] --skip-train requires --ml-backfill", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    import multiprocessing as mp

    mp.freeze_support()
    raise SystemExit(main())
