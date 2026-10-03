"""Novelty ledger: a second render must not reuse the first render's DNA."""
from engine.arrangement_planner import EngineMemory, plan_scratch


def test_fatigue_is_immediate_then_decays(tmp_path):
    memory = EngineMemory(str(tmp_path / "engine_memory.db"))
    memory.record_render("outlaw_country", "G_minor", 104, ["Gm", "Eb", "Bb", "F"], ["gt_acoustic_boomchick"])
    assert memory.get_fatigue_penalty("gt_acoustic_boomchick") == 0.90
    assert memory.get_fatigue_penalty("never_used") == 0.0
    for index in range(4):
        memory.record_render("outlaw_country", "A_minor", 110 + index, ["Am"], [f"other_{index}"])
    # The acoustic guitar is now five renders back: 0.90 - 4 * 0.18.
    assert memory.get_fatigue_penalty("gt_acoustic_boomchick") == 0.18
    memory.record_render("outlaw_country", "D_minor", 120, ["Dm"], ["other_5"])
    assert memory.get_fatigue_penalty("gt_acoustic_boomchick") == 0.0
    memory.close()


def test_scratch_blueprint_avoids_the_last_render(tmp_path):
    memory = EngineMemory(str(tmp_path / "engine_memory.db"))
    first = plan_scratch("outlaw_country", memory)
    memory.record_render(
        "outlaw_country",
        first.key,
        first.bpm,
        ["Gm", "Eb", "Bb", "F"],
        ["dr_kick"],
        form=first.form_id,
        feel=first.rhythmic_feel,
        swing_ms=first.swing_offset_ms,
        progression_id=first.progression_id,
    )
    second = plan_scratch("outlaw_country", memory)
    assert second.key != first.key
    assert second.bpm != first.bpm
    assert second.progression_id != first.progression_id
    assert second.rhythmic_feel != first.rhythmic_feel
    assert second.form_id != first.form_id
    assert second.swing_offset_ms != first.swing_offset_ms or second.rhythmic_feel != first.rhythmic_feel
    memory.close()
