# CG-002 — Feel Calibration Report

CG-002 does **not** tune the game. It builds the measuring instruments and
establishes a defensible baseline: every feel constant lives in one authoritative
place, gameplay is deterministic under a seed, and the core loop is now
measurable, not merely functional. Tuning comes later, against these numbers.

---

## 1. The one authoritative tuning surface

All feel-critical constants live in a single `TUNING` object at the top of
[`../game.js`](../game.js). Nothing else in the file hard-codes these numbers,
and the object is reachable at runtime via `window.CG.TUNING`. Change a value
there and the feel changes; change nothing else.

| Group | Constant | Baseline | Governs |
| --- | --- | ---: | --- |
| movement | `accel` | 1150 | steering acceleration toward target (px/s²) |
| movement | `maxSpeed` | 250 | top skater speed (px/s) |
| steering | `turnHandling` | 9.5 | how fast heading snaps to input |
| friction | `skater` | 4.2 | per-second linear damping on skaters |
| oil | `accelMult` | 0.34 | steering authority kept on the slick (lower = slicker) |
| oil | `frictionMult` | 0.30 | braking kept on the slick |
| pass | `speed` | 400 | pass velocity (px/s) |
| shot | `minSpeed` | 380 | floor of flick shot power (px/s) |
| shot | `maxSpeed` | 560 | ceiling of flick power; keyboard shot uses this |
| check | `impulse` | 330 | knock imparted to a loose puck on a check |
| check | `minSpeed` | 120 | minimum closing speed to land a check |
| check | `radius` | 29 | check reach (px) |
| puck | `damping` | 0.85 | per-second glide damping (concrete) |
| fence | `restitution` | 1.0 | puck bounce energy off the boards (1 = elastic) |
| pickup | `radius` | 24 | loose-puck grab range (px) |

These baseline values are **unchanged from the shipped CG-001 feel** — CG-002
only relocated them, so the baseline metrics below describe the game as it
already plays.

---

## 2. Instruments

### Diagnostics overlay
Toggle with the **`` ` ``** key, or `window.CG.toggleDiag()` /
`window.CG.setDiag(true)`. It shows live fps, elapsed sim time, every metric
below, current puck speed, and a compact readout of the active constants.
Screenshot: [`diagnostics-overlay.png`](./diagnostics-overlay.png).

### Metrics (what each counts)
| Metric | Definition |
| --- | --- |
| `shots` + `shotSpeed{last,min,max,avg}` | every shot released, and its launch velocity |
| `passes` | completed pass attempts |
| `fenceImpacts` + `lastFenceAngleDeg` | puck bounces off the boards; travel angle at last impact |
| `possessionChanges` | how often the controlling **team** flipped (steals, intercepts, rebounds to rivals) |
| `checks` | checks that knocked the puck loose |
| `goals{player,opponent}` | goals scored |
| `elapsed` | simulated seconds |

Read a live snapshot any time with `window.CG.getMetrics()`.

---

## 3. Deterministic scenarios

Same seed + fixed `1/60` timestep + scripted setup ⇒ identical metrics on every
run, on every machine, regardless of framerate. Run one from the console:

```js
window.CG.runScenario('ai-faceoff-60s')   // returns a metrics snapshot
window.CG.scenarios                         // lists all scenario names
```

| Scenario | Seed | Length | Purpose |
| --- | ---: | ---: | --- |
| `ai-faceoff-60s` | 12648430 | 60s | canonical evidence run, full AI vs AI |
| `ai-faceoff-10s` | 45067 | 10s | short repeatability check |
| `ai-faceoff-30s-altseed` | 12245589 | 30s | different seed, confirms seed sensitivity |

Every scenario verified **repeatable within a page and across fresh page loads**
(see [`determinism.json`](./determinism.json)).

---

## 4. Observed baseline (canonical 60-second run)

From [`evidence-ai-faceoff-60s.json`](./evidence-ai-faceoff-60s.json), scenario
`ai-faceoff-60s`, seed 12648430:

| Metric | Value |
| --- | ---: |
| shots | 1 (all at 560 px/s) |
| passes | 14 |
| checks | 58 |
| fence impacts | 15 (last angle 15°) |
| possession changes | 11 |
| goals (you / rivals) | 4 / 1 |

**Reading it:** in pure AI-vs-AI play the puck changes hands often (11 team
flips) and contact dominates (58 checks), while clean shots are rare (1). Goals
therefore come mostly from scramble deflections off checks and passes, not from
aimed shots — a concrete, measurable starting point. This is an observation about
the baseline, **not** a value that was tuned. When real tuning begins, this is
the number to move deliberately and re-measure.

---

## 5. Reproducing the evidence

The artifacts in this folder are produced headless (Chromium) against the game
loaded over `file://`:

1. Open [`../index.html`](../index.html) (no server, no build step).
2. In the console: `window.CG.runScenario('ai-faceoff-60s')`.
3. Compare the returned `metrics` to `evidence-ai-faceoff-60s.json` — identical.

The committed run reports: syntax check green, `file://` smoke green, deployed
smoke green, **0 console errors**, **0 stray 404s**, all scenarios repeatable.

---

## Stop condition (met)

The same inputs and scenarios produce explainable, measurable results, and every
gameplay constant is tunable from one authoritative location (`TUNING`). CG-002
is the instrument, not the tuning pass.
