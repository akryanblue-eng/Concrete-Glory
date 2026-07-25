# CG-001 — First Playable Slice

The first vertical slice of **Concrete Glory**. Its only job is to prove the
core loop is fun before any of the empire (menus, progression, cosmetics,
online) gets built. See the [product canon](../../README.md) for the full
picture.

## How to run

No build step, no dependencies, no server. Open the file:

```
slices/cg-001/index.html
```

Double-click it, or drag it into any modern browser. It starts immediately.

## What's in scope

- **One arena** — a single concrete rink with neon chain-link fence and two goals.
- **One 60-second period** — the clock runs once; at zero you get the final
  whistle and a "run it back" reset.
- **3-on-3** — you drive your crew's active skater; the other five are AI.
- **The core loop, end to end:**
  - **Skate** — drag to steer the active skater; momentum carries.
  - **Pass** — tap to snap the puck to a teammate.
  - **Shoot** — flick to fire at the net; flick speed sets the power.
  - **Check** — skate hard into the puck-carrier to knock it loose.
  - **Rebound** — chase the loose puck; it banks off the fence, nearest skater grabs it.
- **One readable hazard** — a fixed oil slick, drawn on the surface with a dashed
  warning ring. Skate onto it and you lose grip: less steering authority and less
  braking, so momentum carries you. Grip restores fully the instant you leave.
  It's the same for every skater, never moves, and carries no hidden penalty.
- **Basic opponent** — the rival crew chases, carries, passes, and shoots.

You always control whichever of your skaters has the puck; when you don't have
it, you control your crew member closest to the puck.

## Controls

| Action | Touch / mouse            | Keyboard              |
| ------ | ------------------------ | --------------------- |
| Skate  | Drag                     | WASD / arrow keys     |
| Pass   | Quick tap                | `J`                   |
| Shoot  | Flick (fast drag-release)| `K` / `Space`         |
| Check  | Skate into a carrier     | (same — it's contact) |
| Restart| "RUN IT BACK" button     | `R`                   |

## Explicitly NOT in this slice

Per the milestone boundary: no main menu, no cosmetics or gear, no career/meta
progression, no Heat/rivalry system, no asphalt brawl, no multiple arenas, no
full three-period match, and no online play. Those layer on top once the loop
feels right. (One readable hazard — the oil slick — is in scope; a wider hazard
set is not.)

## Notes for the next step

This slice is framework-free on purpose. `game.js` is organized as the engine's
**systems** layer — input, AI, physics, and render are separated so the whole
thing can be lifted into a canvas/Phaser `MatchView` (per the blueprint) without
a rewrite.

## Feel calibration (CG-002)

Every feel-critical constant lives in one authoritative `TUNING` object at the
top of `game.js` (reachable at runtime as `window.CG.TUNING`). The slice ships
with measuring instruments:

- **Diagnostics overlay** — press `` ` `` (or `window.CG.setDiag(true)`) for live
  fps, metrics, and the active constants.
- **Metrics** — shots + shot velocity, passes, checks, fence impacts + angle,
  possession changes, and goals. Read a snapshot with `window.CG.getMetrics()`.
- **Deterministic scenarios** — `window.CG.runScenario('ai-faceoff-60s')` runs a
  seeded, fixed-timestep match that produces identical metrics every time.

Baseline evidence and the full report live in
[`calibration/`](./calibration/CALIBRATION.md).
