// ============================================================
// Bluegrass Mic Plot — acoustic model and solver.
// Pure functions, no DOM or Three.js, so the app (index.html), the browser
// test page (tests.html) and the Node test suite all run the same code.
//
// Coordinates: feet. The mic stand is at the origin (x, z) with the capsule at
// height mic.height; y is up. A facing angle f (radians) points along
// (sin f, 0, cos f). Mic rotation is in degrees, same convention.
// Levels are absolute: estimated dB SPL arriving at the mic, plus mic.gain.
// ============================================================

export const FT_PER_M = 3.28084;
export const STAGE_SIZE = 24;            // ft, square stage
export const PLAYER_RADIUS = 1.25;       // ft, body + instrument footprint (2.5 ft wide)

// Near-field clamp. Below ~30 cm a voice or instrument is not a point source and
// the 1/r law over-predicts badly (it diverges at r = 0).
export const MIN_SOURCE_DIST_M = 0.3;

// Real large-diaphragm cardioids reject roughly 15–25 dB at the rear (less at low
// frequencies); an ideal cardioid has a perfect null. Floor at −20 dB.
export const MIC_REAR_FLOOR = 0.1;

// Floor for source directivity, so no source ever has a perfect null.
export const SOURCE_DIR_FLOOR = 0.1;

// Source model: first-order directivity g(θ) = a + (1 − a)·cos θ, so the level
// behind the source is 20·log10(2a − 1). SPL values are ESTIMATES of a typical
// player at 1 m on-axis; users should measure their own (see UI tip).
//   a = 0.625 → rear −12 dB, 0.66 → −10, 0.70 → −8, 0.75 → −6, 0.85 → −3.
export const INSTRUMENTS = {
  banjo:    { label: 'Banjo',            dir: 0.625, spl: 88,   hFrac: 0.57, desc: 'Resonator: most forward-projecting (rear ≈ −12 dB)' },
  dobro:    { label: 'Dobro',            dir: 0.66,  spl: 83,   hFrac: 0.54, desc: 'Resonator guitar: forward projection (rear ≈ −10 dB)' },
  guitar:   { label: 'Guitar',           dir: 0.70,  spl: 82,   hFrac: 0.56, desc: 'Acoustic: soundhole + top (rear ≈ −8 dB)' },
  mandolin: { label: 'F-style Mandolin', dir: 0.70,  spl: 84,   hFrac: 0.58, desc: 'F-style: soundhole + top (rear ≈ −8 dB)' },
  fiddle:   { label: 'Fiddle',           dir: 0.75,  spl: 85,   hFrac: 0.72, desc: 'Violin: top + f-holes (rear ≈ −6 dB)' },
  bass:     { label: 'Stand-up Bass',    dir: 0.85,  spl: 78,   hFrac: 0.47, desc: 'Upright: nearly omnidirectional (rear ≈ −3 dB)' },
  vocals:   { label: 'Vocals Only',      dir: 1.00,  spl: null, hFrac: 0.50, desc: 'No instrument' },
};

// Singing voice: about −3 dB at 90° and −7 dB behind (broadband), not a null.
export const VOICE = { dir: 0.72, spl: 80, hOff: -0.5 };

export const HEIGHT_RANGE_FT = [3, 8];
export const SPL_RANGE = [40, 120];

export const SOLVER = {
  minR: 2.5,              // ft, closest a player's centre may be to the mic stand (horizontal)
  maxR: 9.0,              // ft, furthest
  maxBearingDeg: 75,      // max off-axis bearing, measured from the mic's facing direction
  minSep: 2 * PLAYER_RADIUS + 0.5, // ft centre-to-centre (bodies 2.5 ft wide + 6 in)
  tolDb: 0.5,             // converged when spread ≤ this
  maxIter: 600,
};

// Manual drags may not put a player inside the mic stand.
export const STAND_CLEARANCE = PLAYER_RADIUS + 0.25;

// ------------------------------------------------------------
// Basic helpers
// ------------------------------------------------------------
export const deg2r = d => d * Math.PI / 180;
export const r2deg = r => r * 180 / Math.PI;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const ampToDb = a => 20 * Math.log10(a);
export const wrapAngle = a => { const t = (a + Math.PI) % (2 * Math.PI); return (t < 0 ? t + 2 * Math.PI : t) - Math.PI; };

/** Cardioid pressure sensitivity 0.5(1 + cos θ), floored at MIC_REAR_FLOOR (−20 dB). */
export const micGain = theta => Math.max(MIC_REAR_FLOOR, 0.5 + 0.5 * Math.cos(theta));
/** First-order source directivity a + (1 − a)cos θ, floored at SOURCE_DIR_FLOOR. */
export const dirGain = (theta, a) => Math.max(SOURCE_DIR_FLOOR, a + (1 - a) * Math.cos(theta));

export function micForward(rotDeg) { const a = deg2r(rotDeg || 0); return { x: Math.sin(a), y: 0, z: Math.cos(a) }; }
export const facingToMic = (x, z) => Math.atan2(-x, -z);

/** World (x, z) → mic-local: f = distance along mic axis, l = lateral. */
export function toMicLocal(x, z, rotDeg) {
  const a = deg2r(rotDeg || 0), s = Math.sin(a), c = Math.cos(a);
  return { f: x * s + z * c, l: x * c - z * s };
}
export function fromMicLocal(f, l, rotDeg) {
  const a = deg2r(rotDeg || 0), s = Math.sin(a), c = Math.cos(a);
  return { x: l * c + f * s, z: -l * s + f * c };
}
/** World (x, z) → mic-local polar: r (horizontal ft), b (bearing off mic axis, rad). */
export function toPolar(pos, rotDeg) { const { f, l } = toMicLocal(pos.x, pos.z, rotDeg); return { r: Math.hypot(f, l), b: Math.atan2(l, f) }; }
export function fromPolar(r, b, rotDeg) { return fromMicLocal(r * Math.cos(b), r * Math.sin(b), rotDeg); }

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = v => Math.hypot(v.x, v.y, v.z);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const angleBetweenUnit = (u, v) => Math.acos(clamp(dot(u, v), -1, 1));

/** Incoherent (power) sum of levels in dB. Non-finite entries are ignored. Returns null if none. */
export function dbSum(levels) {
  const fin = levels.filter(l => Number.isFinite(l));
  if (!fin.length) return null;
  return 10 * Math.log10(fin.reduce((s, l) => s + Math.pow(10, l / 10), 0));
}

// ------------------------------------------------------------
// Source → mic level
// ------------------------------------------------------------
/**
 * Level (dB) at the mic from one point source.
 * src: { pos: {x,y,z} ft, facing: rad, spl: dB SPL @ 1 m on-axis, dir: a }
 * mic: { height ft, rotation deg, gain dB }
 */
export function sourceLevel(src, mic) {
  const mPos = { x: 0, y: mic.height, z: 0 };
  const toMic = sub(mPos, src.pos);
  const dFt = len(toMic);
  const dM = Math.max(dFt / FT_PER_M, MIN_SOURCE_DIST_M);
  let srcAngle = 0, micAngle = 0;
  if (dFt > 1e-9) {
    const u = { x: toMic.x / dFt, y: toMic.y / dFt, z: toMic.z / dFt };
    const fwd = { x: Math.sin(src.facing), y: 0, z: Math.cos(src.facing) };
    srcAngle = angleBetweenUnit(fwd, u);
    micAngle = angleBetweenUnit(micForward(mic.rotation), { x: -u.x, y: -u.y, z: -u.z });
  }
  return src.spl - 20 * Math.log10(dM) + ampToDb(dirGain(srcAngle, src.dir)) + ampToDb(micGain(micAngle)) + (mic.gain || 0);
}

export const hasInstrument = p => INSTRUMENTS[p.instrument] && INSTRUMENTS[p.instrument].spl !== null;

export function resolveInstHeight(p) {
  const h = p.instrumentHeight ?? (p.height * INSTRUMENTS[p.instrument].hFrac);
  return clamp(h, 0.5, p.height);
}
export function resolveVoiceHeight(p) {
  const h = p.voiceHeight ?? (p.height + VOICE.hOff);
  return clamp(h, 0.5, p.height);
}

/**
 * Per-player levels at the mic. Absent sources (not singing, vocals-only
 * instrument) are null, not a sentinel dB value.
 */
export function computePlayerMix(p, mic) {
  const inst = INSTRUMENTS[p.instrument];
  const vPos = { x: p.position.x, y: resolveVoiceHeight(p), z: p.position.z };
  const iPos = { x: p.position.x, y: resolveInstHeight(p), z: p.position.z };
  const voiceLevel = p.singing
    ? sourceLevel({ pos: vPos, facing: p.voiceFacing, spl: p.voiceSPL, dir: VOICE.dir }, mic) : null;
  const instrumentLevel = hasInstrument(p)
    ? sourceLevel({ pos: iPos, facing: p.instrumentFacing, spl: p.instrumentSPL, dir: inst.dir }, mic) : null;
  const mPos = { x: 0, y: mic.height, z: 0 };
  return {
    name: p.name, color: p.color,
    voiceLevel, instrumentLevel,
    combinedLevel: dbSum([voiceLevel, instrumentLevel]),
    dist: len(sub(mPos, hasInstrument(p) ? iPos : vPos)),
    vPos: p.singing ? vPos : null,
    iPos: hasInstrument(p) ? iPos : null,
  };
}

export const computeMix = (players, mic) => players.map(p => computePlayerMix(p, mic));

/** Max − min of combined levels over players who make sound. */
export function spread(mix) {
  const l = mix.map(m => m.combinedLevel).filter(Number.isFinite);
  return l.length < 2 ? 0 : Math.max(...l) - Math.min(...l);
}

// ------------------------------------------------------------
// Input sanitation
// ------------------------------------------------------------
const finiteOr = (v, d) => (typeof v === 'number' && Number.isFinite(v)) ? v : d;

/** Parse a height entered as feet + inches (imperial) or cm (metric). Returns ft, or null if invalid. */
export function parseHeight({ ft, inches, cm }) {
  let h;
  if (cm !== undefined) {
    if (String(cm).trim() === '') return null;
    h = Number(cm) / 100 * FT_PER_M;
  } else {
    if (String(ft).trim() === '' || String(inches).trim() === '') return null;
    h = Number(ft) + Number(inches) / 12;
  }
  if (!Number.isFinite(h) || h < HEIGHT_RANGE_FT[0] || h > HEIGHT_RANGE_FT[1]) return null;
  return h;
}

/** Split a height in ft into whole feet + inches without ever showing 12 in. */
export function feetInches(hFt) {
  const total = Math.round(hFt * 12);
  return { ft: Math.floor(total / 12), inches: total % 12 };
}

/** Repair a (possibly loaded-from-storage) player so every field the model reads is valid. */
export function sanitizePlayer(p) {
  const instrument = INSTRUMENTS[p && p.instrument] ? p.instrument : 'guitar';
  const height = clamp(finiteOr(p && p.height, 5.75), ...HEIGHT_RANGE_FT);
  const x = finiteOr(p && p.position && p.position.x, 0);
  const z = finiteOr(p && p.position && p.position.z, 4);
  const face = facingToMic(x, z);
  const srcH = v => (typeof v === 'number' && Number.isFinite(v)) ? clamp(v, 0.5, height) : null;
  const defSpl = INSTRUMENTS[instrument].spl;
  return {
    ...p,
    name: typeof (p && p.name) === 'string' ? p.name : 'Player',
    instrument, height,
    position: { x, z },
    bodyFacing: finiteOr(p && p.bodyFacing, face),
    voiceFacing: finiteOr(p && p.voiceFacing, face),
    instrumentFacing: finiteOr(p && p.instrumentFacing, face),
    instrumentSPL: defSpl === null ? null : clamp(finiteOr(p && p.instrumentSPL, defSpl), ...SPL_RANGE),
    voiceSPL: clamp(finiteOr(p && p.voiceSPL, VOICE.spl), ...SPL_RANGE),
    singing: !!(p && p.singing),
    instrumentHeight: srcH(p && p.instrumentHeight),
    voiceHeight: srcH(p && p.voiceHeight),
  };
}

// ------------------------------------------------------------
// Geometry constraints (all in mic-local coordinates, so any mic rotation works)
// ------------------------------------------------------------
const maxB = () => deg2r(SOLVER.maxBearingDeg);

function clampPolar({ r, b }) {
  return { r: clamp(Number.isFinite(r) ? r : 4, SOLVER.minR, SOLVER.maxR), b: clamp(Number.isFinite(b) ? b : 0, -maxB(), maxB()) };
}

/** Minimum bearing separation (rad) for two players at radii r1, r2 to be minSep apart. */
function requiredBearingSep(r1, r2, s = SOLVER.minSep) {
  const c = (r1 * r1 + r2 * r2 - s * s) / (2 * r1 * r2);
  if (c >= 1) return 0;
  if (c <= -1) return Math.PI;
  return Math.acos(c);
}

const polarDist = (a, b) => Math.sqrt(Math.max(0, a.r * a.r + b.r * b.r - 2 * a.r * b.r * Math.cos(a.b - b.b)));

/** True if every pair of (x, z) positions is at least minSep apart. */
export function pairsOk(positions, s = SOLVER.minSep, tol = 1e-3) {
  for (let i = 0; i < positions.length; i++)
    for (let j = i + 1; j < positions.length; j++)
      if (Math.hypot(positions[i].x - positions[j].x, positions[i].z - positions[j].z) < s - tol) return false;
  return true;
}

/** True if a position is inside the solver's allowed region in front of the mic. */
export function inBounds(pos, rotDeg, tol = 1e-3) {
  const { r, b } = toPolar(pos, rotDeg);
  return r >= SOLVER.minR - tol && r <= SOLVER.maxR + tol && Math.abs(b) <= maxB() + tol;
}

/**
 * Project positions onto the feasible set: in front of the mic (bearing ≤ maxBearing),
 * minR ≤ r ≤ maxR, and pairwise ≥ minSep. Returns { positions, ok }.
 */
export function projectFeasible(positions, rotDeg) {
  let pol = positions.map(p => clampPolar(toPolar(p, rotDeg)));
  let pos = pol.map(q => fromPolar(q.r, q.b, rotDeg));
  const s = SOLVER.minSep;
  for (let pass = 0; pass < 200; pass++) {
    let moved = false;
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        let dx = pos[j].x - pos[i].x, dz = pos[j].z - pos[i].z;
        let d = Math.hypot(dx, dz);
        if (d >= s - 1e-6) continue;
        if (d < 1e-6) { // coincident: push apart sideways (mic-local lateral)
          const lat = fromMicLocal(0, 1, rotDeg); dx = lat.x; dz = lat.z; d = 0;
        } else { dx /= d; dz /= d; }
        const push = (s - d) / 2 + 1e-4;
        pos[i] = { x: pos[i].x - dx * push, z: pos[i].z - dz * push };
        pos[j] = { x: pos[j].x + dx * push, z: pos[j].z + dz * push };
        moved = true;
      }
    }
    pol = pos.map(p => clampPolar(toPolar(p, rotDeg)));
    pos = pol.map(q => fromPolar(q.r, q.b, rotDeg));
    if (!moved) break;
  }
  return { positions: pos, ok: pairsOk(pos) };
}

/** Keep a manually dragged player out of the mic stand and on the stage. */
export function clampManualPosition(pos) {
  const half = STAGE_SIZE / 2 - 0.5;
  let { x, z } = pos;
  const r = Math.hypot(x, z);
  if (r < STAND_CLEARANCE) {
    if (r < 1e-6) { x = 0; z = STAND_CLEARANCE; }
    else { x *= STAND_CLEARANCE / r; z *= STAND_CLEARANCE / r; }
  }
  return { x: clamp(x, -half, half), z: clamp(z, -half, half) };
}

// ------------------------------------------------------------
// Presets and new-player placement
// ------------------------------------------------------------
function arcPolar(n, spanDeg, r, radial = () => 0) {
  return Array.from({ length: n }, (_, i) => ({
    r: r + radial(i),
    b: n === 1 ? 0 : deg2r(-spanDeg / 2 + spanDeg * i / (n - 1)),
  }));
}
function polarPairsOk(pts) {
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      if (polarDist(pts[i], pts[j]) < SOLVER.minSep - 1e-3) return false;
  return true;
}
/** Smallest base radius ≥ r0 at which the arc layout has no overlaps. */
function fitArc(n, spanDeg, r0, radial) {
  let pts = arcPolar(n, spanDeg, r0, radial);
  for (let r = r0; r <= SOLVER.maxR; r += 0.05) {
    pts = arcPolar(n, spanDeg, r, radial);
    if (polarPairsOk(pts)) return pts;
  }
  return pts;
}

export const PRESETS = ['semicircle', 'tight', 'diamond', 'line'];

/** Feasible (non-overlapping, in front of the mic) positions for a named layout. */
export function presetPositions(name, n, rotDeg = 0) {
  if (n <= 0) return [];
  let pol;
  switch (name) {
    case 'tight':   pol = fitArc(n, 80, SOLVER.minR); break;
    case 'diamond': pol = fitArc(n, 90, 3.0, i => Math.abs(i - (n - 1) / 2) * 1.2); break;
    case 'line': {
      const half = (n - 1) / 2 * SOLVER.minSep;
      // Far enough forward that the end players stay inside the bearing limit.
      const f0 = Math.max(3.5, half / Math.tan(maxB()) + 0.1);
      pol = Array.from({ length: n }, (_, i) => {
        const l = (i - (n - 1) / 2) * SOLVER.minSep;
        return { r: Math.hypot(f0, l), b: Math.atan2(l, f0) };
      });
      break;
    }
    case 'semicircle':
    default:        pol = fitArc(n, 120, 3.5); break;
  }
  return projectFeasible(pol.map(q => fromPolar(q.r, q.b, rotDeg)), rotDeg).positions;
}

/** A free spot for a new player: nearest the mic axis and the mic, not overlapping anyone. */
export function findFreeSpot(positions, rotDeg = 0) {
  const ok = c => positions.every(p => Math.hypot(p.x - c.x, p.z - c.z) >= SOLVER.minSep);
  for (let r = 3.5; r <= SOLVER.maxR + 1e-9; r += 0.5) {
    for (let k = 0; k * 5 <= SOLVER.maxBearingDeg; k++) {
      for (const sgn of k === 0 ? [1] : [1, -1]) {
        const c = fromPolar(r, deg2r(sgn * k * 5), rotDeg);
        if (ok(c)) return c;
      }
    }
  }
  // Stage is full: take the candidate furthest from everyone.
  let best = fromPolar(SOLVER.maxR, 0, rotDeg), bestD = -1;
  for (let r = SOLVER.minR; r <= SOLVER.maxR; r += 0.5)
    for (let deg = -SOLVER.maxBearingDeg; deg <= SOLVER.maxBearingDeg; deg += 5) {
      const c = fromPolar(r, deg2r(deg), rotDeg);
      const d = Math.min(...positions.map(p => Math.hypot(p.x - c.x, p.z - c.z)));
      if (d > bestD) { bestD = d; best = c; }
    }
  return best;
}

// ------------------------------------------------------------
// Auto Balance
// ------------------------------------------------------------
function playerAt(p, pos, faceMic) {
  const q = { ...p, position: pos };
  if (faceMic) { const f = facingToMic(pos.x, pos.z); q.bodyFacing = f; q.voiceFacing = f; q.instrumentFacing = f; }
  return q;
}
const levelAtPolar = (p, r, b, mic, faceMic) =>
  computePlayerMix(playerAt(p, fromPolar(r, b, mic.rotation), faceMic), mic).combinedLevel;

/** Radius along bearing b at which player p's combined level equals target (bisection, clamped). */
function solveRadius(p, b, target, mic, faceMic) {
  const lo = SOLVER.minR, hi = SOLVER.maxR;
  const Llo = levelAtPolar(p, lo, b, mic, faceMic), Lhi = levelAtPolar(p, hi, b, mic, faceMic);
  if (target >= Llo) return lo;
  if (target <= Lhi) return hi;
  let a = lo, c = hi;
  for (let k = 0; k < 50; k++) {
    const m = (a + c) / 2;
    if (levelAtPolar(p, m, b, mic, faceMic) > target) a = m; else c = m;
  }
  return (a + c) / 2;
}

/**
 * Balance every player's combined level at the mic.
 *
 * Each player's level depends only on their own position, so for a given bearing
 * the radius that hits a target level is found directly (1-D root find). The
 * target is the quietest player's level at the closest allowed distance, so the
 * quietest player stands closest. Overlaps are resolved by spreading bearings;
 * if the arc is too crowded, the target is lowered 1 dB (everyone steps back).
 *
 * Returns { positions, facings|null, converged, spread, iterations, reason }.
 */
export function autoBalance(players, mic, { faceMic = true, maxIter = SOLVER.maxIter } = {}) {
  const rot = mic.rotation || 0;
  const n = players.length;
  const start = projectFeasible(players.map(p => p.position), rot).positions; // project once
  const b = start.map(p => toPolar(p, rot).b);
  const r = start.map(p => toPolar(p, rot).r);
  const active = players.map(p => p.singing || hasInstrument(p));
  const done = (converged, iterations, reason) => {
    let positions = r.map((ri, i) => fromPolar(ri, b[i], rot));
    // Never hand back overlapping players, even when giving up.
    if (!pairsOk(positions)) positions = projectFeasible(positions, rot).positions;
    const placed = players.map((p, i) => playerAt(p, positions[i], faceMic));
    return {
      positions,
      facings: faceMic ? positions.map(q => facingToMic(q.x, q.z)) : null,
      converged, iterations, reason,
      spread: spread(computeMix(placed, mic)),
    };
  };
  if (n === 0 || active.filter(Boolean).length < 2) return done(true, 0, null);

  let offset = 0, stall = 0;
  for (let iter = 1; iter <= maxIter; iter++) {
    // Achievable range per player along their current bearing.
    let minHi = Infinity, maxLo = -Infinity;
    players.forEach((p, i) => {
      if (!active[i]) return;
      minHi = Math.min(minHi, levelAtPolar(p, SOLVER.minR, b[i], mic, faceMic));
      maxLo = Math.max(maxLo, levelAtPolar(p, SOLVER.maxR, b[i], mic, faceMic));
    });
    const target = Math.max(minHi - offset, maxLo);
    players.forEach((p, i) => { if (active[i]) r[i] = solveRadius(p, b[i], target, mic, faceMic); });

    // Resolve overlaps by spreading bearings (radii stay at their solved values).
    let collided = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const need = requiredBearingSep(r[i], r[j]);
        const gap = Math.abs(b[j] - b[i]);
        if (gap >= need - 1e-6) continue;
        collided = true;
        const dir = Math.sign(b[j] - b[i]) || 1;
        const deficit = need - gap + 1e-4;
        b[i] = clamp(b[i] - dir * deficit / 2, -maxB(), maxB());
        b[j] = clamp(b[j] + dir * deficit / 2, -maxB(), maxB());
      }
    }

    if (!collided) {
      const placed = players.map((p, i) => playerAt(p, fromPolar(r[i], b[i], rot), faceMic));
      const s = spread(computeMix(placed, mic));
      if (s <= SOLVER.tolDb) return done(true, iter, null);
      // No overlaps but not balanced: some player cannot reach the target within minR..maxR.
      return done(false, iter, 'range');
    }
    if (++stall >= 20) { stall = 0; offset += 1; } // crowded: step everyone back 1 dB
  }
  return done(false, maxIter, 'crowded');
}

// ------------------------------------------------------------
// Default band
// ------------------------------------------------------------
export function makePlayer(name, instrument, heightFt, color, x, z) {
  const facing = facingToMic(x, z);
  return {
    name, instrument, height: heightFt, color,
    position: { x, z },
    bodyFacing: facing, voiceFacing: facing, instrumentFacing: facing,
    instrumentSPL: INSTRUMENTS[instrument].spl, voiceSPL: VOICE.spl,
    singing: true,
    instrumentHeight: null, voiceHeight: null,
  };
}

export const DEFAULT_BAND_SPEC = [
  ['Mike',   'banjo',    6 + 2 / 12],
  ['Tim',    'guitar',   5 + 8 / 12],
  ['Matt',   'bass',     6 + 5 / 12],
  ['Robert', 'mandolin', 6 + 5 / 12],
];

export function makeDefaultBand(colors = []) {
  const pos = presetPositions('semicircle', DEFAULT_BAND_SPEC.length, 0);
  return DEFAULT_BAND_SPEC.map(([name, inst, h], i) => makePlayer(name, inst, h, colors[i % (colors.length || 1)], pos[i].x, pos[i].z));
}
