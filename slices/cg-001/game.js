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

  // Movement / feel. Tuned by hand for a snappy arcade slice.
  var ACCEL = 1150;                   // px/s^2 toward steer target
  var MAX_SPEED = 250;                // px/s
  var SKATER_FRICTION = 4.2;          // per second (linear damping)
  var PUCK_FRICTION = 0.85;           // concrete glide — pucks carry
  var TURN_HANDLING = 9.5;            // how fast heading snaps to input

  var CARRY_DIST = SKATER_R + PUCK_R + 2;
  var PICKUP_R = SKATER_R + PUCK_R + 5;
  var SHOOT_SPEED = 560;
  var PASS_SPEED = 400;
  var CHECK_R = SKATER_R * 2 + 3;
  var CHECK_MIN_SPEED = 120;          // checker must be moving this fast
  var CHECK_KNOCK = 330;
  var STAGGER_TIME = 0.45;            // seconds a checked carrier is stunned
  var PICKUP_LOCKOUT = 0.16;          // brief no-grab window after a release

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

  // ---- Helpers -------------------------------------------------------
  function len(x, y) { return Math.sqrt(x * x + y * y); }
  function dist(a, b) { return len(a.x - b.x, a.y - b.y); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function makeSkater(team, x, y, role) {
    return { id: 0, team: team, x: x, y: y, vx: 0, vy: 0,
             fx: team === TEAM_PLAYER ? 1 : -1, fy: 0, // facing
             role: role, stagger: 0 };
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
    var tx = oppNetX(s.team), ty = clamp(s.y, GOAL_TOP + 10, GOAL_BOTTOM - 10);
    var dx = tx - puck.x, dy = ty - puck.y, d = len(dx, dy) || 1;
    releasePuck((dx / d) * SHOOT_SPEED, (dy / d) * SHOOT_SPEED, id);
    if (s.team === TEAM_PLAYER) flash('SHOOT!', 0.4);
  }

  function shootDir(id, dx, dy, speed) {
    var d = len(dx, dy) || 1;
    releasePuck((dx / d) * speed, (dy / d) * speed, id);
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
    releasePuck((dx / d) * PASS_SPEED, (dy / d) * PASS_SPEED, id);
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
      shootDir(id, pointer.vx, pointer.vy, clamp(flick * 620, 380, SHOOT_SPEED));
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
        if (Math.random() < 0.05) shootTowardNet(s.id);
      } else if (Math.random() < 0.012) {
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
    s.vx += a.x * ACCEL * speedScale * dt;
    s.vy += a.y * ACCEL * speedScale * dt;

    // Friction
    var f = Math.max(0, 1 - SKATER_FRICTION * dt);
    s.vx *= f; s.vy *= f;

    // Clamp speed
    var sp = len(s.vx, s.vy), max = MAX_SPEED * speedScale;
    if (sp > max) { s.vx = s.vx / sp * max; s.vy = s.vy / sp * max; }

    s.x += s.vx * dt; s.y += s.vy * dt;

    // Keep skaters inside the rink.
    s.x = clamp(s.x, RINK.left + SKATER_R, RINK.right - SKATER_R);
    s.y = clamp(s.y, RINK.top + SKATER_R, RINK.bottom - SKATER_R);

    // Facing follows heading.
    if (sp > 8) {
      var nx = s.vx / sp, ny = s.vy / sp, t = clamp(TURN_HANDLING * dt, 0, 1);
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
      if (dist(s, carrier) > CHECK_R) continue;
      var sp = len(s.vx, s.vy);
      if (sp < CHECK_MIN_SPEED) continue;
      // Must be moving toward the carrier.
      var tx = carrier.x - s.x, ty = carrier.y - s.y, td = len(tx, ty) || 1;
      if ((s.vx * tx + s.vy * ty) / (sp * td) < 0.3) continue;
      // Knock the puck loose along the carrier's momentum + push.
      var kx = tx / td, ky = ty / td;
      releasePuck(kx * CHECK_KNOCK + carrier.vx * 0.5,
                  ky * CHECK_KNOCK + carrier.vy * 0.5, s.id);
      carrier.stagger = STAGGER_TIME;
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
    var f = Math.max(0, 1 - PUCK_FRICTION * dt);
    puck.vx *= f; puck.vy *= f;
    puck.x += puck.vx * dt; puck.y += puck.vy * dt;

    // Top / bottom fence — always bank.
    if (puck.y - PUCK_R < RINK.top) { puck.y = RINK.top + PUCK_R; puck.vy = Math.abs(puck.vy); }
    if (puck.y + PUCK_R > RINK.bottom) { puck.y = RINK.bottom - PUCK_R; puck.vy = -Math.abs(puck.vy); }

    // End walls — goal mouth scores, everything else banks.
    var inMouth = puck.y > GOAL_TOP && puck.y < GOAL_BOTTOM;
    if (puck.x - PUCK_R < RINK.left) {
      if (inMouth) { goal(TEAM_OPP); return; }
      puck.x = RINK.left + PUCK_R; puck.vx = Math.abs(puck.vx);
    }
    if (puck.x + PUCK_R > RINK.right) {
      if (inMouth) { goal(TEAM_PLAYER); return; }
      puck.x = RINK.right - PUCK_R; puck.vx = -Math.abs(puck.vx);
    }

    // Pickup / rebound — nearest skater in range grabs it.
    if (puck.lockout <= 0) {
      var best = -1, bd = PICKUP_R;
      for (var i = 0; i < skaters.length; i++) {
        var d = dist(skaters[i], puck);
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) { puck.owner = best; puck.vx = 0; puck.vy = 0; }
    }
  }

  function goal(team) {
    if (team === TEAM_PLAYER) { score.player++; flash('GOAL!', 1.2); }
    else { score.opponent++; flash('THEY SCORE', 1.2); }
    resetPositions(true);
  }

  function flash(text, secs) { flashText = text; flashTimer = secs; }

  // ---- Main loop -----------------------------------------------------
  var last = 0, acc = 0, STEP = 1 / 60;

  function frame(now) {
    if (!last) last = now;
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (running) {
      acc += dt;
      while (acc >= STEP) { step(STEP); acc -= STEP; }
      timeRemaining -= dt;
      if (timeRemaining <= 0) { timeRemaining = 0; endGame(); }
    }
    if (flashTimer > 0) flashTimer -= dt;

    render();
    requestAnimationFrame(frame);
  }

  function step(dt) {
    var humanId = activeHumanId();
    for (var i = 0; i < skaters.length; i++) {
      var s = skaters[i];
      var a = (i === humanId) ? humanAccel(s) : aiAccel(s);
      integrateSkater(s, a, dt);
    }
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

  function drawSkater(s, isHuman) {
    var color = s.team === TEAM_PLAYER ? COLOR.player : COLOR.opp;
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

    resetPositions(true);
    startGame();
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
