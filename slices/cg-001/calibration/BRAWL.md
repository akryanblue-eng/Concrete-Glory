# CG-003 — Asphalt Brawl Report

A tiny violence espresso shot bolted onto the hockey loop: qualifying checks
build **Tension**; at the threshold the court goes silent for a beat, then two
skaters settle it in a short rhythm confrontation, and play resumes from a clean
face-off. It is a rhythm minigame, **not** a fighting engine — no health bars, no
injuries, no cinematic camera, no random triggering, no button-mashing.

All brawl tunables live in `TUNING.brawl` in [`../game.js`](../game.js).

---

## How it works

1. **Tension** — every *qualifying check* (a check that lands) adds
   `tensionPerCheck` (25) to a meter that maxes at `tensionMax` (100). So the
   brawl triggers on the **4th** qualifying check — deterministic, never random.
   The meter is always visible and pulses red past `warnAt` (70%).
2. **The silence beat** — on trigger, play freezes for `freezeTime` (0.5s): the
   wheels stop, the fence rattles, the screen dims, `GLOVES OFF` flashes. The
   puck, the match clock, and every skater are frozen.
3. **The rhythm scrap** — `beats` (4) strikes, `beatPeriod` (1.0s) apart, each
   with a gold hit window (`windowOpen` 0.35s in, `windowLen` 0.35s long). Tap /
   space / click **in the window** to land a hit. A press anywhere else in the
   beat is an immediate miss (so mashing loses); an unpressed beat times out as a
   miss.
4. **Outcome** — the player wins the scrap with `winHits` (3) of 4 hits.
   - **Winner** gets a momentum benefit: a `winnerBoostTime` (2.0s) speed boost
     (`winnerBoostMult` 1.35×), shown as a green halo.
   - **Loser** gets a short disadvantage: a `loserPenaltyTime` (2.0s) stagger.
5. **Clean return** — tension resets to 0, positions reset to a deterministic
   face-off, and the match clock resumes **exactly** where it froze.

The two participants are always the checker and the checked carrier — and since
checks only land across teams, it is always **you vs a rival**.

---

## New metrics (extending CG-002)

`tension_gained`, `brawl_triggered`, `brawl_input`, `brawl_hit`, `brawl_miss`,
`brawl_resolved`, `play_resumed` — plus an ordered `brawlEvents` log
(`trigger` / `hit` / `miss` / `resolve` / `resume`, each stamped with a
deterministic sim-tick). Read them with `window.CG.getMetrics()`; inspect live
state with `window.CG.getState()`.

---

## Deterministic scenarios

Brawls use **no randomness** — the trigger is threshold-based and the outcome is
input-based — so seeded runs reproduce byte-identical event logs. Scenarios take
a scripted `brawlInput` policy:

| Scenario | Seed | Length | Input | Purpose |
| --- | ---: | ---: | --- | --- |
| `brawl-perfect-30s` | 10747927 | 30s | perfect | every brawl → player wins |
| `brawl-fail-30s` | 10747927 | 30s | fail | every brawl → rival wins, loser penalized |
| `brawl-canonical-60s` | 10852887 | 60s | perfect | canonical evidence run |

Run one from the console: `window.CG.runScenario('brawl-canonical-60s')`.

---

## Proof results (all green)

From [`brawl-proofs.json`](./brawl-proofs.json), headless Chromium over `file://`:

1. **Threshold** — brawl triggers at `tension == 100`, on exactly **4** checks
   (`ceil(max / perCheck)`), every time.
2. **Perfect input** — always `PLAYER` wins (3/3 brawls, 4 hits each).
3. **Failed input** — always `RIVAL` wins (3/3), 0 hits, loser penalized.
4. **Resume** — the match clock is byte-identical across each `trigger`→`resume`
   pair (frozen), the puck returns loose at face-off, every skater is finite and
   in-bounds, and phase is back to `PLAY`.
5. **Reproducibility** — two same-page runs and a fresh-page run emit identical
   `brawlEvents` logs.

Plus a **core-hockey regression**: with brawls off, `ai-faceoff-60s` reproduces
the committed CG-002 baseline exactly (`shots/passes/checks/fenceImpacts/angle/
possession/elapsed/goals` all match), confirming the brawl layer changed nothing
underneath.

Canonical `brawl-canonical-60s` (seed 10852887): 7 brawls triggered, 6 resolved
in-window (the 7th still in progress at the 60s cutoff), 24 hits / 0 misses under
perfect input. See [`evidence-brawl-canonical-60s.json`](./evidence-brawl-canonical-60s.json)
and the overlay screenshot [`brawl-overlay.png`](./brawl-overlay.png).

---

## Acceptance evidence

syntax/build green · `file://` smoke green · deployed (HTTP) smoke green (metrics
**and** event logs identical to `file://`) · **0** console errors · **0** stray
404s · core-hockey regression green · seeded brawl scenarios repeatable ·
event evidence committed.

## Stop condition (met)

The tension meter makes it obvious *why* the brawl triggered; the rhythm windows
are playable without instructions; the result is unambiguous (win/lose the
scrap, with a visible boost/penalty); and play resumes with the clock, puck, and
skaters intact — proven by the resume checks and the regression.
