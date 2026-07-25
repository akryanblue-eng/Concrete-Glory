/*
 * Concrete Glory — CG-001 first playable slice
 * ------------------------------------------------------------
 * Scope (deliberately small): one arena, one 60-second period,
 * and the core loop — skate, pass, shoot, check, rebound —
 * against a basic opponent. No menus, cosmetics, or progression.
 *
 * Framework-free on purpose: this file is the "systems" layer.
 * The functions below (input, physics, ai, render) map onto the
 * engine structure in the product blueprint and are meant to be
 * lifted into a canvas/Phaser MatchView later without a rewrite.
 */
(function () {
  'use strict';

  // ---- World constants (logical pixels) ------------------------------
  var W = 960, H = 540;
  var FENCE = 26;
  var RINK = { left: FENCE, right: W - FENCE, top: FENCE, bottom: H - FENCE };
  var GOAL_HALF = 74;                 // half-height of each goal mouth
  var GOAL_TOP = H / 2 - GOAL_HALF;
  var GOAL_BOTTOM = H / 2 + GOAL_HALF;

  var SKATER_R = 13;
  var PUCK_R = 6;

  // ============================================================
  // CG-002 — FEEL TUNING
  // The single authoritative source for every gameplay-feel constant:
  // everything the player touches each second is tuned from here (and
  // reachable at runtime via window.CG.TUNING). Change a value here and
  // the feel changes; nothing else in this file hard-codes these numbers.
  // ============================================================
  var TUNING = {
    movement: { accel: 1150, maxSpeed: 250 },          // px/s^2 toward steer target; px/s cap
    steering: { turnHandling: 9.5 },                   // how fast heading snaps to input
    friction: { skater: 4.2 },                         // per-second linear damping on skaters
    oil:      { accelMult: 0.34, frictionMult: 0.30 }, // grip retained on the slick (lower = slicker)
    pass:     { speed: 400 },                          // px/s pass velocity
    shot:     { minSpeed: 380, maxSpeed: 560 },        // flick power clamps here; keyboard shot = max
    check:    { impulse: 330, minSpeed: 120, radius: SKATER_R * 2 + 3 }, // knock; min closing speed; reach
    puck:     { damping: 0.85 },                       // per-second glide damping (concrete)
    fence:    { restitution: 1.0 },                    // puck bounce energy off the boards (1 = elastic)
    pickup:   { radius: SKATER_R + PUCK_R + 5 }         // loose-puck grab range
  };

  // Non-feel geometry / timing (fixed; deliberately outside the tuning surface).
  var CARRY_DIST = SKATER_R + PUCK_R + 2;
  var STAGGER_TIME = 0.45;            // seconds a checked carrier is stunned
  var PICKUP_LOCKOUT = 0.16;          // brief no-grab window after a release

  // Readable concrete hazard: a fixed oil slick (geometry here; grip in TUNING.oil).
  var OIL = { x: W * 0.5, y: H * 0.68, rx: 48, ry: 30 };

  var PERIOD_SECONDS = 60;

  var TEAM_PLAYER = 0, TEAM_OPP = 1;
  var COLOR = {
    player: '#06b6d4',   // neon cyan
    opp: '#f43f5e',      // neon pink
    puck: '#eab308',     // neon yellow
    fence: '#39ff14',    // neon green
    asphalt: '#17171c'
  };

  // ---- State ---------------------------------------------------------
  var canvas, ctx, dpr = 1;
  var skaters = [];
  var puck;
  var score = { player: 0, opponent: 0 };
  var timeRemaining = PERIOD_SECONDS;
  var running = false;
  var flashText = null, flashTimer = 0;

  // Input
  var pointer = { down: false, x: 0, y: 0, startX: 0, startY: 0, startT: 0,
                  lastX: 0, lastY: 0, lastT: 0, vx: 0, vy: 0 };
  var keys = {};

  // ---- CG-002 instruments (metrics, determinism, diagnostics) --------
  var metrics, lastPossessionTeam = -1;
  var simAiOnly = false;   // deterministic scenarios drive every skater by AI
  var diagOn = false;      // toggleable diagnostics overlay
  var fps = 0;

  // Seeded PRNG (mulberry32) so scenarios are reproducible. All gameplay
  // randomness routes through rng(); live play seeds from the clock, scenarios
  // seed from a fixed value.
  var rngState = 1, currentSeed = 1;
  function seedRng(seed) { currentSeed = seed >>> 0; rngState = currentSeed || 1; }
  function rng() {
    rngState = (rngState + 0x6D2B79F5) | 0;
    var t = rngState;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function resetMetrics() {
    metrics = {
      shots: 0,
      shotSpeed: { last: 0, min: 0, max: 0, avg: 0, _sum: 0 },
      passes: 0,
      fenceImpacts: 0,
      lastFenceAngleDeg: 0,
      possessionChanges: 0,
      checks: 0,
      goals: { player: 0, opponent: 0 },
      elapsed: 0
    };
    lastPossessionTeam = -1;
  }
  resetMetrics();

  function recordShot(speed) {
    metrics.shots++;
    var ss = metrics.shotSpeed;
    ss.last = speed;
    ss.min = metrics.shots === 1 ? speed : Math.min(ss.min, speed);
    ss.max = Math.max(ss.max, speed);
    ss._sum += speed;
    ss.avg = ss._sum / metrics.shots;
  }
  function recordFenceImpact() {
    metrics.fenceImpacts++;
    // Puck travel angle at the moment of impact (pre-reflection), in degrees.
    metrics.lastFenceAngleDeg = Math.round(Math.atan2(puck.vy, puck.vx) * 180 / Math.PI);
  }

  // ---- Helpers -------------------------------------------------------
  function len(x, y) { return Math.sqrt(x * x + y * y); }
  function dist(a, b) { return len(a.x - b.x, a.y - b.y); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // Point-in-ellipse test for the oil slick.
  function onOil(x, y) {
    var dx = (x - OIL.x) / OIL.rx, dy = (y - OIL.y) / OIL.ry;
    return dx * dx + dy * dy < 1;
  }

  function makeSkater(team, x, y, role) {
    return { id: 0, team: team, x: x, y: y, vx: 0, vy: 0,
             fx: team === TEAM_PLAYER ? 1 : -1, fy: 0, // facing
             role: role, stagger: 0, onOil: false };
  }

  function ownerTeam() { return puck.owner >= 0 ? skaters[puck.owner].team : -1; }

  function teamSkaters(team) {
    var out = [];
    for (var i = 0; i < skaters.length; i++) if (skaters[i].team === team) out.push(skaters[i]);
    return out;
  }

  // The one player-team skater the human is currently driving:
  // the puck carrier if we have it, otherwise our closest to the puck.
  function activeHumanId() {
    if (puck.owner >= 0 && skaters[puck.owner].team === TEAM_PLAYER) return puck.owner;
    var best = -1, bd = Infinity;
    for (var i = 0; i < skaters.length; i++) {
      if (skaters[i].team !== TEAM_PLAYER) continue;
      var d = dist(skaters[i], puck);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  function oppNetX(team) { return team === TEAM_PLAYER ? RINK.right : RINK.left; }

  // ---- Setup ---------------------------------------------------------
  function resetPositions(faceoff) {
    skaters = [];
    // Player crew attacks right; opponent crew attacks left. 3-on-3.
    skaters.push(makeSkater(TEAM_PLAYER, W * 0.30, H * 0.5, 'center'));
    skaters.push(makeSkater(TEAM_PLAYER, W * 0.20, H * 0.28, 'wing'));
    skaters.push(makeSkater(TEAM_PLAYER, W * 0.20, H * 0.72, 'wing'));
    skaters.push(makeSkater(TEAM_OPP, W * 0.70, H * 0.5, 'center'));
    skaters.push(makeSkater(TEAM_OPP, W * 0.80, H * 0.28, 'wing'));
    skaters.push(makeSkater(TEAM_OPP, W * 0.80, H * 0.72, 'wing'));
    for (var i = 0; i < skaters.length; i++) skaters[i].id = i;

    puck = { x: W / 2, y: H / 2, vx: 0, vy: 0, owner: -1,
             lockout: 0, lastShooter: -1 };
    if (!faceoff) return;
  }

  function startGame() {
    simAiOnly = false;
    seedRng((Date.now() >>> 0) ^ 0x9e3779b9); // live play: varied each period
    resetMetrics();
    score.player = 0; score.opponent = 0;
    timeRemaining = PERIOD_SECONDS;
    resetPositions(true);
    hideOverlay();
    flash('FACE-OFF', 1.0);
    running = true;
  }

  function endGame() {
    running = false;
    puck.owner = -1; puck.vx = 0; puck.vy = 0;
    showOverlay();
  }

  // ---- Actions -------------------------------------------------------
  function releasePuck(vx, vy, shooterId) {
    puck.owner = -1;
    puck.vx = vx; puck.vy = vy;
    puck.lockout = PICKUP_LOCKOUT;
    puck.lastShooter = shooterId;
  }

  function shootTowardNet(id) {
    var s = skaters[id];
    var speed = TUNING.shot.maxSpeed;
    var tx = oppNetX(s.team), ty = clamp(s.y, GOAL_TOP + 10, GOAL_BOTTOM - 10);
    var dx = tx - puck.x, dy = ty - puck.y, d = len(dx, dy) || 1;
    releasePuck((dx / d) * speed, (dy / d) * speed, id);
    recordShot(speed);
    if (s.team === TEAM_PLAYER) flash('SHOOT!', 0.4);
  }

  function shootDir(id, dx, dy, speed) {
    var d = len(dx, dy) || 1;
    releasePuck((dx / d) * speed, (dy / d) * speed, id);
    recordShot(speed);
  }

  function passToTeammate(id) {
    var s = skaters[id];
    var mates = teamSkaters(s.team), best = null, bd = Infinity;
    for (var i = 0; i < mates.length; i++) {
      if (mates[i].id === id) continue;
      var d = dist(mates[i], s);
      if (d < bd) { bd = d; best = mates[i]; }
    }
    if (!best) return;
    // Lead the pass slightly toward where the mate is heading.
    var tx = best.x + best.vx * 0.22, ty = best.y + best.vy * 0.22;
    var dx = tx - puck.x, dy = ty - puck.y, d = len(dx, dy) || 1;
    releasePuck((dx / d) * TUNING.pass.speed, (dy / d) * TUNING.pass.speed, id);
    metrics.passes++;
    if (s.team === TEAM_PLAYER) flash('PASS', 0.35);
  }

  // ---- Input ---------------------------------------------------------
  function canvasPoint(clientX, clientY) {
    var r = canvas.getBoundingClientRect();
    return { x: (clientX - r.left) / r.width * W,
             y: (clientY - r.top) / r.height * H };
  }

  function onPointerDown(e) {
    e.preventDefault();
    var p = canvasPoint(e.clientX, e.clientY);
    pointer.down = true;
    pointer.x = pointer.startX = pointer.lastX = p.x;
    pointer.y = pointer.startY = pointer.lastY = p.y;
    pointer.startT = pointer.lastT = performance.now();
    pointer.vx = pointer.vy = 0;
  }

  function onPointerMove(e) {
    if (!pointer.down) return;
    var p = canvasPoint(e.clientX, e.clientY);
    var now = performance.now();
    var dt = Math.max(1, now - pointer.lastT);
    pointer.vx = (p.x - pointer.lastX) / dt;   // px per ms
    pointer.vy = (p.y - pointer.lastY) / dt;
    pointer.lastX = p.x; pointer.lastY = p.y; pointer.lastT = now;
    pointer.x = p.x; pointer.y = p.y;
  }

  function onPointerUp(e) {
    if (!pointer.down) return;
    pointer.down = false;
    if (!running) return;

    var id = activeHumanId();
    if (id < 0) return;
    var havePuck = puck.owner === id;
    if (!havePuck) return;   // no puck → the drag was pure skating

    var totalDt = performance.now() - pointer.startT;
    var moveDist = len(pointer.x - pointer.startX, pointer.y - pointer.startY);
    var flick = len(pointer.vx, pointer.vy); // px/ms

    if (flick > 0.7) {
      // Flick to shoot — direction and power from the release.
      shootDir(id, pointer.vx, pointer.vy, clamp(flick * 620, TUNING.shot.minSpeed, TUNING.shot.maxSpeed));
      flash('SHOOT!', 0.4);
    } else if (totalDt < 220 && moveDist < 16) {
      // Quick tap to pass.
      passToTeammate(id);
    }
    // Otherwise it was a slow drag: just skating, keep the puck.
  }

  function onKey(down) {
    return function (e) {
      var k = e.key.toLowerCase();
      keys[k] = down;
      if (down && running) {
        var id = activeHumanId();
        if (id >= 0 && puck.owner === id) {
          if (k === 'j') passToTeammate(id);
          if (k === 'k' || k === ' ') shootTowardNet(id);
        }
      }
      if (down && (k === 'r')) startGame();
      if (down && (k === '`')) diagOn = !diagOn;   // toggle diagnostics overlay
      if (k === ' ') e.preventDefault();
    };
  }

  function humanAccel(s) {
    // Pointer steering takes priority; keyboard as a fallback.
    if (pointer.down) {
      var dx = pointer.x - s.x, dy = pointer.y - s.y, d = len(dx, dy);
      if (d > 4) return { x: dx / d, y: dy / d };
      return { x: 0, y: 0 };
    }
    var ax = (keys['d'] || keys['arrowright'] ? 1 : 0) - (keys['a'] || keys['arrowleft'] ? 1 : 0);
    var ay = (keys['s'] || keys['arrowdown'] ? 1 : 0) - (keys['w'] || keys['arrowup'] ? 1 : 0);
    var m = len(ax, ay);
    return m ? { x: ax / m, y: ay / m } : { x: 0, y: 0 };
  }

  // ---- AI ------------------------------------------------------------
  function aiAccel(s) {
    var ot = ownerTeam();
    var target;

    if (puck.owner >= 0 && puck.owner === s.id) {
      // I'm carrying: drive at the net, shoot when in range.
      var netX = oppNetX(s.team);
      var onAttackSide = s.team === TEAM_PLAYER ? s.x > W * 0.55 : s.x < W * 0.45;
      var range = Math.abs(netX - s.x);
      if (onAttackSide && range < 250 && Math.abs(s.y - H / 2) < GOAL_HALF + 40) {
        if (rng() < 0.05) shootTowardNet(s.id);
      } else if (rng() < 0.012) {
        // Occasionally move the puck to a teammate.
        passToTeammate(s.id);
      }
      target = { x: netX, y: clamp(H / 2 + (s.y - H / 2) * 0.4, GOAL_TOP, GOAL_BOTTOM) };

    } else if (ot === s.team) {
      // Teammate has it: spread into support toward the attacking end.
      var supportX = s.team === TEAM_PLAYER ? W * 0.62 : W * 0.38;
      var lane = s.role === 'wing' ? (s.y < H / 2 ? H * 0.28 : H * 0.72) : H * 0.5;
      target = { x: supportX, y: lane };

    } else if (ot >= 0) {
      // They have it: nearest defender chases to check, others cover.
      var carrier = skaters[puck.owner];
      if (isNearestOnTeam(s, carrier)) {
        target = { x: carrier.x, y: carrier.y };
      } else {
        var ownNet = oppNetX(s.team === TEAM_PLAYER ? TEAM_OPP : TEAM_PLAYER);
        target = { x: (carrier.x + ownNet) / 2, y: (carrier.y + H / 2) / 2 };
      }

    } else {
      // Loose puck: closest on the team races for it, others hold shape.
      if (isNearestOnTeam(s, puck)) target = { x: puck.x, y: puck.y };
      else target = { x: s.team === TEAM_PLAYER ? W * 0.4 : W * 0.6, y: s.y };
    }

    var dx = target.x - s.x, dy = target.y - s.y, d = len(dx, dy);
    if (d < 6) return { x: 0, y: 0 };
    return { x: dx / d, y: dy / d };
  }

  function isNearestOnTeam(s, target) {
    var mates = teamSkaters(s.team), my = dist(s, target);
    for (var i = 0; i < mates.length; i++) {
      if (mates[i].id === s.id) continue;
      if (dist(mates[i], target) < my - 1) return false;
    }
    return true;
  }

  // ---- Physics / simulation -----------------------------------------
  function integrateSkater(s, a, dt) {
    var speedScale = s.stagger > 0 ? 0.35 : 1;

    // Oil slick: lose grip while inside it. Less steering authority and less
    // braking, so you keep sliding the way you were already going. Restores
    // fully the instant you leave (the flag is recomputed every step).
    s.onOil = onOil(s.x, s.y);
    var accel = s.onOil ? TUNING.movement.accel * TUNING.oil.accelMult : TUNING.movement.accel;
    var friction = s.onOil ? TUNING.friction.skater * TUNING.oil.frictionMult : TUNING.friction.skater;

    s.vx += a.x * accel * speedScale * dt;
    s.vy += a.y * accel * speedScale * dt;

    // Friction
    var f = Math.max(0, 1 - friction * dt);
    s.vx *= f; s.vy *= f;

    // Clamp speed
    var sp = len(s.vx, s.vy), max = TUNING.movement.maxSpeed * speedScale;
    if (sp > max) { s.vx = s.vx / sp * max; s.vy = s.vy / sp * max; }

    s.x += s.vx * dt; s.y += s.vy * dt;

    // Keep skaters inside the rink.
    s.x = clamp(s.x, RINK.left + SKATER_R, RINK.right - SKATER_R);
    s.y = clamp(s.y, RINK.top + SKATER_R, RINK.bottom - SKATER_R);

    // Facing follows heading.
    if (sp > 8) {
      var nx = s.vx / sp, ny = s.vy / sp, t = clamp(TUNING.steering.turnHandling * dt, 0, 1);
      s.fx += (nx - s.fx) * t; s.fy += (ny - s.fy) * t;
      var fl = len(s.fx, s.fy) || 1; s.fx /= fl; s.fy /= fl;
    }

    if (s.stagger > 0) s.stagger = Math.max(0, s.stagger - dt);
  }

  function separateSkaters() {
    for (var i = 0; i < skaters.length; i++) {
      for (var j = i + 1; j < skaters.length; j++) {
        var a = skaters[i], b = skaters[j];
        var dx = b.x - a.x, dy = b.y - a.y, d = len(dx, dy), min = SKATER_R * 2;
        if (d > 0 && d < min) {
          var push = (min - d) / 2, ux = dx / d, uy = dy / d;
          a.x -= ux * push; a.y -= uy * push;
          b.x += ux * push; b.y += uy * push;
        }
      }
    }
  }

  function resolveChecks() {
    if (puck.owner < 0) return;
    var carrier = skaters[puck.owner];
    if (carrier.stagger > 0) return;
    for (var i = 0; i < skaters.length; i++) {
      var s = skaters[i];
      if (s.team === carrier.team) continue;
      if (dist(s, carrier) > TUNING.check.radius) continue;
      var sp = len(s.vx, s.vy);
      if (sp < TUNING.check.minSpeed) continue;
      // Must be moving toward the carrier.
      var tx = carrier.x - s.x, ty = carrier.y - s.y, td = len(tx, ty) || 1;
      if ((s.vx * tx + s.vy * ty) / (sp * td) < 0.3) continue;
      // Knock the puck loose along the carrier's momentum + push.
      var kx = tx / td, ky = ty / td;
      releasePuck(kx * TUNING.check.impulse + carrier.vx * 0.5,
                  ky * TUNING.check.impulse + carrier.vy * 0.5, s.id);
      carrier.stagger = STAGGER_TIME;
      metrics.checks++;
      if (carrier.team === TEAM_PLAYER) flash('CHECKED!', 0.5);
      else flash('BIG HIT', 0.5);
      return;
    }
  }

  function integratePuck(dt) {
    if (puck.lockout > 0) puck.lockout = Math.max(0, puck.lockout - dt);

    if (puck.owner >= 0) {
      // Carried: sit just ahead of the carrier along their facing.
      var s = skaters[puck.owner];
      puck.x = s.x + s.fx * CARRY_DIST;
      puck.y = s.y + s.fy * CARRY_DIST;
      puck.vx = s.vx; puck.vy = s.vy;
      return;
    }

    // Free puck glides and banks off the fence.
    var f = Math.max(0, 1 - TUNING.puck.damping * dt);
    puck.vx *= f; puck.vy *= f;
    puck.x += puck.vx * dt; puck.y += puck.vy * dt;

    var rest = TUNING.fence.restitution;

    // Top / bottom fence — always bank.
    if (puck.y - PUCK_R < RINK.top) { recordFenceImpact(); puck.y = RINK.top + PUCK_R; puck.vy = Math.abs(puck.vy) * rest; }
    if (puck.y + PUCK_R > RINK.bottom) { recordFenceImpact(); puck.y = RINK.bottom - PUCK_R; puck.vy = -Math.abs(puck.vy) * rest; }

    // End walls — goal mouth scores, everything else banks.
    var inMouth = puck.y > GOAL_TOP && puck.y < GOAL_BOTTOM;
    if (puck.x - PUCK_R < RINK.left) {
      if (inMouth) { goal(TEAM_OPP); return; }
      recordFenceImpact(); puck.x = RINK.left + PUCK_R; puck.vx = Math.abs(puck.vx) * rest;
    }
    if (puck.x + PUCK_R > RINK.right) {
      if (inMouth) { goal(TEAM_PLAYER); return; }
      recordFenceImpact(); puck.x = RINK.right - PUCK_R; puck.vx = -Math.abs(puck.vx) * rest;
    }

    // Pickup / rebound — nearest skater in range grabs it.
    if (puck.lockout <= 0) {
      var best = -1, bd = TUNING.pickup.radius;
      for (var i = 0; i < skaters.length; i++) {
        var d = dist(skaters[i], puck);
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) grantPuck(best);
    }
  }

  // Assign the puck to a skater and count a possession change when the
  // controlling team flips (steals, intercepted passes, rebounds to rivals).
  function grantPuck(id) {
    puck.owner = id; puck.vx = 0; puck.vy = 0;
    var t = skaters[id].team;
    if (lastPossessionTeam !== -1 && t !== lastPossessionTeam) metrics.possessionChanges++;
    lastPossessionTeam = t;
  }

  function goal(team) {
    if (team === TEAM_PLAYER) { score.player++; metrics.goals.player++; flash('GOAL!', 1.2); }
    else { score.opponent++; metrics.goals.opponent++; flash('THEY SCORE', 1.2); }
    resetPositions(true);
  }

  function flash(text, secs) { flashText = text; flashTimer = secs; }

  // ---- Main loop -----------------------------------------------------
  var last = 0, acc = 0, STEP = 1 / 60;

  function frame(now) {
    if (!last) last = now;
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (dt > 0) fps += (1 / dt - fps) * 0.1;

    if (running) {
      acc += dt;
      while (acc >= STEP) { step(STEP); metrics.elapsed += STEP; acc -= STEP; }
      timeRemaining -= dt;
      if (timeRemaining <= 0) { timeRemaining = 0; endGame(); }
    }
    if (flashTimer > 0) flashTimer -= dt;

    render();
    requestAnimationFrame(frame);
  }

  function step(dt) {
    var humanId = simAiOnly ? -1 : activeHumanId();
    var humanWasOnOil = humanId >= 0 && skaters[humanId].onOil;
    for (var i = 0; i < skaters.length; i++) {
      var s = skaters[i];
      var a = (i === humanId) ? humanAccel(s) : aiAccel(s);
      integrateSkater(s, a, dt);
    }
    // Immediate feedback the moment your skater hits the slick.
    if (humanId >= 0 && skaters[humanId].onOil && !humanWasOnOil) flash('SLICK!', 0.5);
    separateSkaters();
    resolveChecks();
    integratePuck(dt);
  }

  // ---- Render --------------------------------------------------------
  function render() {
    ctx.clearRect(0, 0, W, H);

    // Asphalt + subtle grid.
    ctx.fillStyle = COLOR.asphalt;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (var gx = RINK.left; gx <= RINK.right; gx += 48) line(gx, RINK.top, gx, RINK.bottom);
    for (var gy = RINK.top; gy <= RINK.bottom; gy += 48) line(RINK.left, gy, RINK.right, gy);

    // Center line + circle.
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 2;
    line(W / 2, RINK.top, W / 2, RINK.bottom);
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 62, 0, Math.PI * 2); ctx.stroke();

    // Oil slick — drawn on the surface, under the skaters, so it reads clearly
    // before anyone touches it.
    drawSlick();

    // Goals.
    drawGoal(RINK.left, COLOR.player);
    drawGoal(RINK.right, COLOR.opp);

    // Neon fence.
    ctx.strokeStyle = COLOR.fence;
    ctx.lineWidth = 4;
    ctx.shadowColor = COLOR.fence; ctx.shadowBlur = 8;
    ctx.strokeRect(RINK.left, RINK.top, RINK.right - RINK.left, RINK.bottom - RINK.top);
    ctx.shadowBlur = 0;

    // Skaters.
    var humanId = running ? activeHumanId() : -1;
    for (var i = 0; i < skaters.length; i++) drawSkater(skaters[i], i === humanId);

    // Puck.
    ctx.beginPath();
    ctx.fillStyle = COLOR.puck;
    ctx.shadowColor = COLOR.puck; ctx.shadowBlur = 12;
    ctx.arc(puck.x, puck.y, PUCK_R, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;

    drawHud();
    if (flashTimer > 0 && flashText) drawFlash();
    if (diagOn) drawDiag();
  }

  // Toggleable diagnostics overlay (` key, or window.CG.toggleDiag()).
  // Shows the live metrics and a few key constants so tuning is legible.
  function drawDiag() {
    var puckSp = puck.owner >= 0 ? 0 : len(puck.vx, puck.vy);
    var ss = metrics.shotSpeed;
    var lines = [
      'DIAGNOSTICS  (` to toggle)' + (simAiOnly ? '  [AI-ONLY]' : ''),
      'fps ' + fps.toFixed(0) + '   t ' + metrics.elapsed.toFixed(1) + 's',
      '',
      'shots ' + metrics.shots + '  v(last/min/max/avg) ' +
        ss.last.toFixed(0) + '/' + ss.min.toFixed(0) + '/' + ss.max.toFixed(0) + '/' + ss.avg.toFixed(0),
      'passes ' + metrics.passes + '   checks ' + metrics.checks,
      'fence hits ' + metrics.fenceImpacts + '  last angle ' + metrics.lastFenceAngleDeg + '°',
      'possession changes ' + metrics.possessionChanges,
      'goals  you ' + metrics.goals.player + '  rivals ' + metrics.goals.opponent,
      'puck speed ' + puckSp.toFixed(0) + ' px/s',
      '',
      'accel ' + TUNING.movement.accel + '  vmax ' + TUNING.movement.maxSpeed,
      'fric ' + TUNING.friction.skater + '  turn ' + TUNING.steering.turnHandling,
      'oil x' + TUNING.oil.accelMult + '/' + TUNING.oil.frictionMult +
        '  puckDamp ' + TUNING.puck.damping,
      'pass ' + TUNING.pass.speed + '  shot ' + TUNING.shot.minSpeed + '-' + TUNING.shot.maxSpeed,
      'check ' + TUNING.check.impulse + '@' + TUNING.check.minSpeed +
        '  fenceRest ' + TUNING.fence.restitution,
      'pickup r ' + TUNING.pickup.radius + '  seed ' + currentSeed
    ];
    var pad = 8, lh = 15, w = 268, h = pad * 2 + lines.length * lh;
    var x = RINK.left + 6, y = RINK.top + 40;
    ctx.fillStyle = 'rgba(6,8,12,0.82)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(57,255,20,0.5)'; ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.font = '600 11px "Courier New", monospace';
    var firstConstLine = 10; // metrics above, TUNING constants below
    for (var i = 0; i < lines.length; i++) {
      ctx.fillStyle = i === 0 ? '#39ff14' : (i >= firstConstLine ? '#9ca3af' : '#cbd5e1');
      ctx.fillText(lines[i], x + pad, y + pad + i * lh);
    }
  }

  function line(x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }

  function drawGoal(x, color) {
    var into = x === RINK.left ? -1 : 1;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(x, GOAL_TOP, into * 16, GOAL_BOTTOM - GOAL_TOP);
    ctx.strokeStyle = color; ctx.lineWidth = 4;
    ctx.shadowColor = color; ctx.shadowBlur = 10;
    line(x, GOAL_TOP, x, GOAL_BOTTOM);
    ctx.shadowBlur = 0;
  }

  function drawSlick() {
    ctx.save();
    ctx.translate(OIL.x, OIL.y);
    var g = ctx.createRadialGradient(-8, -8, 4, 0, 0, OIL.rx);
    g.addColorStop(0, 'rgba(42,44,52,0.95)');
    g.addColorStop(0.7, 'rgba(8,10,14,0.82)');
    g.addColorStop(1, 'rgba(8,10,14,0.15)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, OIL.rx, OIL.ry, -0.2, 0, Math.PI * 2); ctx.fill();
    // Dashed yellow warning ring so it reads before contact.
    ctx.strokeStyle = 'rgba(234,179,8,0.85)'; ctx.lineWidth = 2;
    ctx.setLineDash([5, 6]); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '700 11px "Courier New", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('OIL', 0, 0);
    ctx.restore();
  }

  function drawSkater(s, isHuman) {
    var color = s.team === TEAM_PLAYER ? COLOR.player : COLOR.opp;
    // On the slick: dashed yellow ring, so the loss of grip is legible.
    if (s.onOil) {
      ctx.beginPath(); ctx.strokeStyle = COLOR.puck; ctx.lineWidth = 2;
      ctx.setLineDash([3, 4]);
      ctx.arc(s.x, s.y, SKATER_R + 6, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (isHuman) {
      ctx.beginPath(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5;
      ctx.arc(s.x, s.y, SKATER_R + 4, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.beginPath();
    ctx.fillStyle = s.stagger > 0 ? '#9ca3af' : color;
    ctx.shadowColor = color; ctx.shadowBlur = isHuman ? 14 : 6;
    ctx.arc(s.x, s.y, SKATER_R, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    // Facing pip.
    ctx.beginPath(); ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 3;
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x + s.fx * SKATER_R, s.y + s.fy * SKATER_R); ctx.stroke();
  }

  function drawHud() {
    ctx.font = '700 26px "Courier New", monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLOR.player;
    ctx.fillText('YOU ' + score.player, RINK.left + 8, RINK.top + 8);
    ctx.textAlign = 'right';
    ctx.fillStyle = COLOR.opp;
    ctx.fillText(score.opponent + ' RIVALS', RINK.right - 8, RINK.top + 8);

    var secs = Math.ceil(timeRemaining);
    ctx.textAlign = 'center';
    ctx.fillStyle = secs <= 10 && running ? COLOR.opp : '#e5e7eb';
    ctx.font = '700 30px "Courier New", monospace';
    ctx.fillText('0:' + (secs < 10 ? '0' : '') + secs, W / 2, RINK.top + 6);
  }

  function drawFlash() {
    var alpha = clamp(flashTimer * 2, 0, 1);
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '900 64px "Courier New", monospace';
    ctx.fillStyle = COLOR.puck;
    ctx.shadowColor = COLOR.puck; ctx.shadowBlur = 20;
    ctx.fillText(flashText, W / 2, H * 0.38);
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
  }

  // ---- Overlay (end-of-period result — not a menu) -------------------
  var overlay, overlayTitle, overlaySub;
  function showOverlay() {
    var winner;
    if (score.player > score.opponent) winner = 'YOU WIN THE PERIOD';
    else if (score.player < score.opponent) winner = 'RIVALS TAKE IT';
    else winner = 'DEAD EVEN';
    overlayTitle.textContent = 'FINAL WHISTLE';
    overlaySub.textContent = winner + ' — ' + score.player + ' : ' + score.opponent;
    overlay.style.display = 'flex';
  }
  function hideOverlay() { overlay.style.display = 'none'; }

  // ---- CG-002 deterministic scenarios --------------------------------
  // Same seed + fixed timestep + scripted setup => identical metrics every
  // run. These are the measuring instruments: repeatable, explainable results.
  var SCENARIOS = {
    'ai-faceoff-60s': { seed: 0x00C0FFEE, seconds: 60, aiOnly: true,
                        note: 'canonical 60-second evidence run, full AI vs AI' },
    'ai-faceoff-10s': { seed: 0x0000B00B, seconds: 10, aiOnly: true,
                        note: 'short repeatability check' },
    'ai-faceoff-30s-altseed': { seed: 0xBADA55, seconds: 30, aiOnly: true,
                        note: 'different seed, confirms seed sensitivity' }
  };

  function snapshotMetrics(name, sc) {
    var ss = metrics.shotSpeed;
    return {
      scenario: name,
      seed: sc ? sc.seed : currentSeed,
      seconds: sc ? sc.seconds : metrics.elapsed,
      tuning: JSON.parse(JSON.stringify(TUNING)),
      metrics: {
        shots: metrics.shots,
        shotSpeed: { last: ss.last, min: ss.min, max: ss.max, avg: Math.round(ss.avg * 100) / 100 },
        passes: metrics.passes,
        fenceImpacts: metrics.fenceImpacts,
        lastFenceAngleDeg: metrics.lastFenceAngleDeg,
        possessionChanges: metrics.possessionChanges,
        checks: metrics.checks,
        goals: { player: metrics.goals.player, opponent: metrics.goals.opponent },
        elapsed: Math.round(metrics.elapsed * 1000) / 1000
      }
    };
  }

  // Run a scenario synchronously and deterministically (no requestAnimationFrame,
  // no wall clock). Pauses live play, leaves the world at the scenario's end
  // state, and returns a metrics snapshot.
  function runScenario(name) {
    var sc = SCENARIOS[name];
    if (!sc) throw new Error('unknown scenario: ' + name);
    running = false;
    simAiOnly = !!sc.aiOnly;
    seedRng(sc.seed);
    resetMetrics();
    score.player = 0; score.opponent = 0;   // keep the visible HUD in sync with this run
    timeRemaining = 0;                       // a completed scenario reads 0:00
    resetPositions(true);
    flashText = null; flashTimer = 0;
    var dt = STEP, frames = Math.round(sc.seconds / dt);
    for (var i = 0; i < frames; i++) { step(dt); metrics.elapsed += dt; }
    return snapshotMetrics(name, sc);
  }

  // Headless / console API for measurement and tuning.
  function exposeApi() {
    if (typeof window === 'undefined') return;
    window.CG = {
      version: 'cg-002',
      TUNING: TUNING,                                   // live, tunable
      scenarios: Object.keys(SCENARIOS),
      runScenario: runScenario,
      getMetrics: function () { if (!metrics) resetMetrics(); return snapshotMetrics('live', null); },
      toggleDiag: function () { diagOn = !diagOn; return diagOn; },
      setDiag: function (v) { diagOn = !!v; return diagOn; }
    };
  }

  // ---- Boot ----------------------------------------------------------
  function fitCanvas() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function init() {
    canvas = document.getElementById('rink');
    ctx = canvas.getContext('2d');
    overlay = document.getElementById('overlay');
    overlayTitle = document.getElementById('overlay-title');
    overlaySub = document.getElementById('overlay-sub');
    fitCanvas();
    window.addEventListener('resize', fitCanvas);

    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKey(true));
    window.addEventListener('keyup', onKey(false));
    document.getElementById('again').addEventListener('click', startGame);

    exposeApi();
    resetPositions(true);
    startGame();
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
