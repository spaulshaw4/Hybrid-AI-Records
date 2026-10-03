"""Tests for the QC-gate quarantine branch of the live API worker."""
from __future__ import annotations

import json
import os
import sys

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from api import headless_job_runner as runner  # noqa: E402

SESSION = "ht_caa94c0b7821"

# Verbatim from scripts/run_master_pipeline.ps1 step 4b.
GATE_MESSAGE = (
    f"QC compliance gate failed for session {SESSION}. Upload aborted; scratch quarantined."
)

REPORT = {
    "metrics": {
        "integrated_lufs": -19.54,
        "true_peak_dbtp": -3.09,
        "stereo_phase_correlation": 0.225,
    },
    "targets": {
        "lufs_window": [-15.0, -13.0],
        "true_peak_ceiling_dbtp": -0.5,
        "phase_window": [0.25, 0.95],
    },
    "compliance": {
        "true_peak_safety_met": True,
        "phase_compatibility_met": False,
        "dc_offset_clean": True,
        "plr_in_band": True,
        "overall_qc_passed": False,
    },
}


def test_is_qc_quarantine_matches_the_gate_message():
    assert runner._is_qc_quarantine(RuntimeError(GATE_MESSAGE))


def test_is_qc_quarantine_matches_powershell_error_block():
    wrapped = (
        "At C:\\scripts\\run_master_pipeline.ps1:309 char:13\n"
        f"+   throw \"{GATE_MESSAGE}\"\n"
        "+   ~~~~~~~~~~~~~~~~~~~~~~~\n"
        "    + CategoryInfo : OperationStopped\n"
    )
    assert runner._is_qc_quarantine(RuntimeError(wrapped))


def test_is_qc_quarantine_ignores_unrelated_failures():
    assert not runner._is_qc_quarantine(RuntimeError("Master pipeline failed. REAPER exited 1"))
    assert not runner._is_qc_quarantine(RuntimeError("QC compliance gate failed"))
    assert not runner._is_qc_quarantine(FileNotFoundError("master_output.wav"))


def _write_report(tmp_path, monkeypatch, payload) -> None:
    monkeypatch.setattr(runner, "RENDERS_ROOT", str(tmp_path))
    session_dir = tmp_path / SESSION
    session_dir.mkdir(parents=True, exist_ok=True)
    body = payload if isinstance(payload, str) else json.dumps(payload)
    (session_dir / "master_output_qc_report.json").write_text(body, encoding="utf-8")


def test_qc_failure_hint_names_the_failing_check(tmp_path, monkeypatch):
    _write_report(tmp_path, monkeypatch, REPORT)
    hint = runner._qc_failure_hint(SESSION)
    assert "phase_compatibility_met" in hint
    assert "0.225" in hint
    assert "0.25-0.95" in hint
    assert "true_peak_safety_met" not in hint


def test_qc_failure_hint_lists_every_failed_check(tmp_path, monkeypatch):
    report = json.loads(json.dumps(REPORT))
    report["compliance"]["streaming_target_met"] = False
    _write_report(tmp_path, monkeypatch, report)
    hint = runner._qc_failure_hint(SESSION)
    assert "streaming_target_met" in hint
    assert "-19.54" in hint
    assert "phase_compatibility_met" in hint


def test_qc_failure_hint_degrades_when_report_is_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "RENDERS_ROOT", str(tmp_path))
    hint = runner._qc_failure_hint("ht_nosuchsession")
    assert hint
    assert "master_output_qc_report.json" in hint


def test_qc_failure_hint_degrades_on_unreadable_report(tmp_path, monkeypatch):
    _write_report(tmp_path, monkeypatch, "{not json")
    assert "master_output_qc_report.json" in runner._qc_failure_hint(SESSION)


def test_qc_failure_hint_handles_a_report_with_no_failures(tmp_path, monkeypatch):
    report = json.loads(json.dumps(REPORT))
    report["compliance"] = {"phase_compatibility_met": True, "overall_qc_passed": True}
    _write_report(tmp_path, monkeypatch, report)
    assert "no failed check" in runner._qc_failure_hint(SESSION)


def test_quarantined_session_keeps_its_scratch(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "SCRATCH_ROOT", str(tmp_path))
    monkeypatch.setattr(runner, "_API_LOG", str(tmp_path / "api.log"))
    monkeypatch.delenv("HYBRID_KEEP_SCRATCH", raising=False)
    session_dir = tmp_path / SESSION
    session_dir.mkdir()
    mix = session_dir / "unmastered_mix.wav"
    mix.write_bytes(b"0" * 2048)

    monkeypatch.setitem(runner._jobs, SESSION, {"delivery_status": "quarantined"})
    assert runner._purge_scratch_audio(SESSION) == 0
    assert mix.is_file()

    monkeypatch.setitem(runner._jobs, SESSION, {"delivery_status": "completed"})
    assert runner._purge_scratch_audio(SESSION) == 2048
    assert not mix.exists()
