# Genre Gap List — Prioritized Sourcing Targets

## What the corpus already covers

**221 distinct genres**, from the union of two metadata sources on `D:`:

| Source | Genres | Labelled tracks | Metadata file |
|---|---|---|---|
| FMA | 163 (full hierarchy) | 49,598 with `genre_top`, more via `genres_all` | `fma/fma_metadata/fma_metadata/genres.csv` |
| MTG-Jamendo | 95 tags | 135,820 tag assignments | `mtg/data/autotagging_genre.tsv` |
| Overlap | 37 | — | — |

Depth ranges from `Electronic` at 50,893 tracks down to `Deep Funk` at 1 and
`Bollywood` / `Be-Bop` at **0** — both are named in FMA's hierarchy but have no
audio behind them.

A genre needs roughly **14 thirty-second clips** to yield the 420 one-second
slices a single render consumes. Genres below that are listed in Tier 4.

---

## Tier 1 — Blocking: configured in the UI but absent from the corpus

These were wired into `GenerationTrigger.tsx` as selectable options. None of them
match any FMA or MTG label, so every render requesting them aborted at
`No audio slices found`. `genre_resolver.py` now substitutes the listed fallback,
but real audio is what actually fixes this.

| Requested genre | Status | Current fallback | Fallback depth |
|---|---|---|---|
| `heavy_alternative_rock` | Composite, no label | `loud_rock` | 2,469 tracks |
| `nu_metal` | Absent | `metal` | 2,933 tracks |
| `rap_rock` | Absent | `alternative_hip_hop` | 740 tracks |
| `amapiano` | Absent — postdates both datasets | `deephouse` | 427 tracks |

`amapiano` is the weakest substitution here. It is a specific South African house
subgenre defined by log-drum basslines and mid-2010s onward production; nothing
in a 2017-era corpus approximates it. This one genuinely needs sourcing.

---

## Tier 2 — High demand, entirely absent

Contemporary genres a user would plausibly pick first. All postdate the datasets.

**Hip-hop lineage**
`trap`, `drill`, `phonk`, `lofi_hip_hop` (partial — `Lo-Fi` 6,041 and
`Hip-Hop Beats` 1,192 exist but are not the same thing), `grime`

**Electronic**
`hyperpop`, `synthwave` (nearest: `Synth Pop` 2,470), `vaporwave`,
`future_bass`, `afro_house`, `gqom`, `melodic_dubstep`

**Global pop**
`afrobeats` — note FMA's `Afrobeat` (110 tracks) is the Fela Kuti–era genre, not
the Wizkid/Burna Boy one; `reggaeton`, `dembow`, `kpop`, `jpop`

**Heavy**
`metalcore`, `deathcore`, `post_hardcore`, `djent`, `emo`, `math_rock`

---

## Tier 3 — Established genres missing or too thin

Present in name only, or absent despite being long-established.

| Genre | Corpus state |
|---|---|
| `Bollywood` | Listed, **0 tracks** |
| `Be-Bop` | Listed, **0 tracks** |
| `Deep Funk` | 1 track |
| `Western Swing` | 4 tracks |
| `N. Indian Traditional` | 4 tracks |
| `Banter` | 9 tracks |
| `Salsa` | 12 tracks |
| `South Indian Traditional` | 17 tracks |
| `Musical Theater` | 18 tracks |
| `Pacific` | 23 tracks |
| `Symphony` | 25 tracks |
| `Fado` | 26 tracks |
| `Tango` | 30 tracks |
| `North African` | 40 tracks |
| `Flamenco` | 47 tracks |
| `Klezmer` | 57 tracks |
| `Turkish` | 60 tracks |
| `Polka` | 62 tracks |
| `Gospel` | 66 tracks |
| `Cumbia` | 67 tracks |

Fully absent despite being canonical: `zydeco`, `cajun`, `bachata`, `merengue`,
`mariachi`, `norteno`, `corridos`, `sertanejo`, `forro`, `vallenato`, `soca`,
`zouk`, `highlife`, `bhangra`, `qawwali`, `enka`, `gamelan`, `smooth_jazz`,
`hard_bop`, `cool_jazz`, `gypsy_jazz`, `delta_blues`, `chicago_blues`.

---

## Tier 4 — Present but under the render minimum

Genres with real audio that cannot complete a single 420-slice render. Sourcing a
handful of extra tracks each promotes them to fully usable, which is far cheaper
than sourcing a genre from scratch.

Everything in Tier 3's table under ~14 clips falls here. Run this for the live
list once slicing has happened:

```powershell
python D:\MusicDatasets\scripts\genre_resolver.py --list-available
```

It marks each genre `OK` or `THIN` against the 420-slice threshold.

---

## Suggested sourcing order

1. **`amapiano`** — explicitly requested, no acceptable substitute exists.
2. **`trap`, `drill`, `afrobeats`, `reggaeton`** — highest likely pick rate, all absent.
3. **`metalcore`, `emo`, `synthwave`, `hyperpop`** — strong demand, weak fallbacks.
4. **Tier 4 top-ups** — cheapest wins per hour of sourcing.
5. **Tier 3 canonical gaps** — completeness rather than demand.

Free/permissive sources worth checking: Jamendo (CC, already the basis of MTG),
Free Music Archive directly (its API exposes genres the bundled dump omits),
ccMixter, Internet Archive's netlabel collections, and Wikimedia Commons for
traditional and regional music.

---

## How the interim fallback behaves

`scripts/genre_resolver.py` resolves any request down a five-step chain and
reports which rule fired:

1. **exact** — the genre has ≥420 slices
2. **alias** — curated mapping in `ALIAS_MAP` (all Tier 1 and Tier 2 genres above)
3. **family_sibling** — largest genre in the same acoustic family
4. **largest_available** — biggest pool overall
5. **below_minimum** — nothing reaches 420 slices

`run_master_pipeline.ps1` calls it before staging and emits a
`genre_substituted` telemetry event when a fallback is used, so substitutions are
visible in the `/telemetry` dashboard rather than silent.

`ai_inference_engine.py` selects its EQ curve the same way: explicit override,
then one of eleven family curves, then a neutral curve. No genre falls back to a
rock profile by accident.
