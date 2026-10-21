// Shared test cases for sim.js. Run by tests/sim.test.mjs (node --test) and by
// tests.html in the browser, so both exercise exactly the module the app uses.
import * as S from '../sim.js';

class AssertionError extends Error {}
const ok = (cond, msg) => { if (!cond) throw new AssertionError(msg); };
const approx = (actual, expected, tol, msg = '') =>
  ok(Math.abs(actual - expected) <= tol, `${msg} expected ${expected} ± ${tol}, got ${actual}`);

const mic0 = { height: 5, gain: 0, rotation: 0 };
const fmtPos = ps => ps.map(p => `(${p.x.toFixed(2)},${p.z.toFixed(2)})`).join(' ');

/** A point source at mic height, on the mic axis, facing the mic: pure geometry. */
function onAxis(distFt, spl = 80, rotDeg = 0) {
  const { x, z } = S.fromMicLocal(distFt, 0, rotDeg);
  return S.sourceLevel({ pos: { x, y: 5, z }, facing: S.facingToMic(x, z), spl, dir: 0.7 }, { height: 5, gain: 0, rotation: rotDeg });
}

function bandAt(positions, faceMic = true) {
  return S.makeDefaultBand().map((p, i) => {
    const q = { ...p, position: { ...positions[i] } };
    if (faceMic) { const f = S.facingToMic(q.position.x, q.position.z); q.bodyFacing = q.voiceFacing = q.instrumentFacing = f; }
    return q;
  });
}

function checkSolved(players, mic, res) {
  ok(res.converged, `did not converge: reason=${res.reason} spread=${res.spread}`);
  ok(res.spread <= S.SOLVER.tolDb, `spread ${res.spread}`);
  ok(S.pairsOk(res.positions), `overlap: ${fmtPos(res.positions)}`);
  res.positions.forEach(p => ok(S.inBounds(p, mic.rotation), `out of bounds / behind mic: ${fmtPos([p])}`));
  // Re-check the claimed spread independently.
  const placed = players.map((p, i) => ({ ...p, position: res.positions[i], ...(res.facings ? { voiceFacing: res.facings[i], instrumentFacing: res.facings[i] } : {}) }));
  approx(S.spread(S.computeMix(placed, mic)), res.spread, 1e-9, 'reported spread');
}

export const cases = [
  // ---------------- Mic polar pattern ----------------
  ['mic: on-axis gain is 0 dB', () => approx(S.ampToDb(S.micGain(0)), 0, 1e-9)],
  ['mic: 90° is −6.02 dB (pressure cardioid)', () => approx(S.ampToDb(S.micGain(S.deg2r(90))), -6.02, 0.01)],
  ['mic: 120° is −12.04 dB', () => approx(S.ampToDb(S.micGain(S.deg2r(120))), -12.04, 0.01)],
  ['mic: rear is floored at −20 dB, not a perfect null', () => {
    approx(S.ampToDb(S.micGain(Math.PI)), -20, 1e-9);
    approx(S.ampToDb(S.micGain(S.deg2r(170))), -20, 1e-9);
  }],
  ['mic: pattern is symmetric and monotonic 0→180°', () => {
    approx(S.micGain(S.deg2r(-45)), S.micGain(S.deg2r(45)), 1e-12);
    for (let d = 1; d <= 180; d++) ok(S.micGain(S.deg2r(d)) <= S.micGain(S.deg2r(d - 1)) + 1e-12, `not monotonic at ${d}°`);
  }],

  // ---------------- Source directivity ----------------
  ['voice: about −3 dB at 90° and −7 dB behind (no null)', () => {
    approx(S.ampToDb(S.dirGain(S.deg2r(90), S.VOICE.dir)), -2.85, 0.1);
    approx(S.ampToDb(S.dirGain(Math.PI, S.VOICE.dir)), -7.13, 0.1);
  }],
  ['voice level falls monotonically as the singer turns away (no discontinuity at 180°)', () => {
    const p = S.makePlayer('V', 'vocals', 5.5, null, 0, 4);
    p.voiceHeight = 5;
    let prev = Infinity;
    for (let d = 0; d <= 180; d++) {
      p.voiceFacing = Math.PI + S.deg2r(d);
      const L = S.computePlayerMix(p, mic0).voiceLevel;
      ok(L <= prev + 1e-9, `voice level rose at ${d}°`);
      prev = L;
    }
    p.voiceFacing = Math.PI; const front = S.computePlayerMix(p, mic0).voiceLevel;
    p.voiceFacing = 0;       const back = S.computePlayerMix(p, mic0).voiceLevel;
    approx(front - back, 7.13, 0.1, 'front-to-back');
  }],
  ['instruments: rear rejection is moderate and ordered (banjo most directional, bass least)', () => {
    const rear = k => S.ampToDb(S.dirGain(Math.PI, S.INSTRUMENTS[k].dir));
    ok(rear('banjo') < rear('guitar'), 'banjo should be more directional than guitar');
    ok(rear('banjo') < rear('dobro') && rear('dobro') < rear('guitar'), 'banjo < dobro < guitar');
    ok(rear('guitar') < rear('fiddle') && rear('fiddle') < rear('bass'), 'guitar < fiddle < bass');
    for (const k of ['banjo', 'dobro', 'guitar', 'mandolin', 'fiddle', 'bass'])
      ok(rear(k) >= -15 && rear(k) <= -2, `${k} rear ${rear(k).toFixed(1)} dB outside −15…−2`);
  }],

  // ---------------- Distance law and units ----------------
  ['distance: absolute level equals SPL@1m at exactly 1 m, on-axis', () => approx(onAxis(S.FT_PER_M, 80), 80, 1e-9)],
  ['distance: doubling distance is −6.02 dB (pressure, 20·log10)', () => {
    approx(onAxis(3) - onAxis(6), 6.02, 0.01);
    approx(onAxis(4) - onAxis(8), 6.02, 0.01);
  }],
  ['distance law holds for any mic rotation', () => approx(onAxis(3, 80, 90) - onAxis(6, 80, 90), 6.02, 0.01)],
  ['levels are absolute dB SPL at the mic (default band is 70–95 dB)', () => {
    S.computeMix(S.makeDefaultBand(), mic0).forEach(m => ok(m.combinedLevel > 70 && m.combinedLevel < 95, `${m.name} ${m.combinedLevel}`));
  }],

  // ---------------- r → 0 ----------------
  ['r→0: a voice exactly at the capsule is finite and clamped to the 0.3 m near-field limit', () => {
    const p = S.makePlayer('Z', 'guitar', 5.5, null, 0, 0); // voice height 5.0 = mic height
    const m = S.computePlayerMix(p, mic0);
    ok(Number.isFinite(m.voiceLevel) && Number.isFinite(m.combinedLevel), `voice ${m.voiceLevel}`);
    ok(m.voiceLevel <= 80 - 20 * Math.log10(S.MIN_SOURCE_DIST_M) + 1e-9, `voice ${m.voiceLevel} exceeds clamp`);
    ok(Number.isFinite(S.spread(S.computeMix([p, S.makePlayer('B', 'banjo', 6, null, 2, 4)], mic0))), 'spread not finite');
  }],
  ['r→0: 0.2 ft from the capsule gives the same clamped level as 0.5 ft', () => {
    const lvl = d => { const p = S.makePlayer('Z', 'guitar', 5.5, null, 0, d); p.voiceFacing = Math.PI; return S.computePlayerMix(p, mic0).voiceLevel; };
    approx(lvl(0.2), lvl(0.5), 1e-9);
  }],
  ['manual drag cannot enter the mic stand', () => {
    for (const pos of [{ x: 0, z: 0 }, { x: 0.3, z: -0.2 }]) {
      const c = S.clampManualPosition(pos);
      ok(Math.hypot(c.x, c.z) >= S.STAND_CLEARANCE - 1e-9, fmtPos([c]));
    }
  }],

  // ---------------- Geometry ----------------
  ['angle convention: facing the mic is louder than facing away', () => {
    const p = S.makePlayer('B', 'banjo', 6, null, 0, 4);
    const toward = S.computePlayerMix(p, mic0).instrumentLevel;
    p.instrumentFacing += Math.PI;
    const away = S.computePlayerMix(p, mic0).instrumentLevel;
    approx(toward - away, 12, 1.5, 'banjo front-to-back');
  }],
  ['mic rotation: pointing the mic at a player raises their level', () => {
    const p = S.makePlayer('R', 'guitar', 5.83, null, 4, 0);
    ok(S.computePlayerMix(p, { ...mic0, rotation: 90 }).instrumentLevel > S.computePlayerMix(p, mic0).instrumentLevel + 5);
  }],
  ['mic-local coordinates round-trip', () => {
    for (const rot of [0, 37, 90, -135, 180]) {
      const w = S.fromMicLocal(3, -1.5, rot), back = S.toMicLocal(w.x, w.z, rot);
      approx(back.f, 3, 1e-12); approx(back.l, -1.5, 1e-12);
    }
    const fwd = S.fromMicLocal(1, 0, 90); approx(fwd.x, 1, 1e-12); approx(fwd.z, 0, 1e-12);
  }],

  // ---------------- Power sum ----------------
  ['power sum: two equal incoherent sources are +3.01 dB', () => approx(S.dbSum([80, 80]), 83.01, 0.01)],
  ['power sum: combined ≥ each part and ≤ max + 3.01 dB', () => {
    S.computeMix(S.makeDefaultBand(), mic0).forEach(m => {
      ok(m.combinedLevel >= Math.max(m.voiceLevel, m.instrumentLevel) - 1e-9);
      ok(m.combinedLevel <= Math.max(m.voiceLevel, m.instrumentLevel) + 3.011);
    });
  }],
  ['not singing: voice is absent (null), combined equals the instrument', () => {
    const p = S.makePlayer('G', 'guitar', 5.83, null, 0, 3); p.singing = false;
    const m = S.computePlayerMix(p, mic0);
    ok(m.voiceLevel === null); approx(m.combinedLevel, m.instrumentLevel, 1e-12);
  }],
  ['vocals-only and not singing makes no sound and is excluded from the spread', () => {
    const p = S.makePlayer('V', 'vocals', 5.83, null, 0, 3); p.singing = false;
    const m = S.computePlayerMix(p, mic0);
    ok(m.combinedLevel === null && m.instrumentLevel === null);
    const s = S.spread(S.computeMix([p, ...S.makeDefaultBand()], mic0));
    approx(s, S.spread(S.computeMix(S.makeDefaultBand(), mic0)), 1e-12);
  }],
  ['mic gain shifts every level equally and leaves the spread unchanged', () => {
    const lo = S.computeMix(S.makeDefaultBand(), { ...mic0, gain: -10 }), hi = S.computeMix(S.makeDefaultBand(), { ...mic0, gain: 10 });
    lo.forEach((m, i) => approx(hi[i].combinedLevel - m.combinedLevel, 20, 1e-9));
    approx(S.spread(hi), S.spread(lo), 1e-9);
  }],

  // ---------------- NaN / invalid input ----------------
  ['parseHeight rejects blank, non-numeric and out-of-range input', () => {
    ok(S.parseHeight({ ft: '', inches: '10' }) === null);
    ok(S.parseHeight({ ft: '5', inches: '' }) === null);
    ok(S.parseHeight({ ft: 'x', inches: '1' }) === null);
    ok(S.parseHeight({ cm: '' }) === null);
    ok(S.parseHeight({ ft: '12', inches: '0' }) === null);
    approx(S.parseHeight({ ft: '5', inches: '10' }), 5 + 10 / 12, 1e-12);
    approx(S.parseHeight({ cm: '182' }), 1.82 * S.FT_PER_M, 1e-9);
  }],
  ['sanitizePlayer repairs NaN/null fields (e.g. corrupted saved state) so levels are finite', () => {
    const bad = { name: 'X', instrument: 'nope', height: NaN, position: { x: null, z: NaN }, voiceFacing: undefined, instrumentSPL: NaN, voiceSPL: null, singing: true, voiceHeight: NaN };
    const p = S.sanitizePlayer(bad);
    const m = S.computePlayerMix(p, mic0);
    ok([m.voiceLevel, m.instrumentLevel, m.combinedLevel].every(Number.isFinite), JSON.stringify(m));
    ok(S.sanitizePlayer(JSON.parse(JSON.stringify({ ...S.makeDefaultBand()[0], height: NaN }))).height === 5.75);
  }],
  ['feetInches never shows 12 inches (182 cm → 6 ft 0 in)', () => {
    const fi = S.feetInches(1.82 * S.FT_PER_M); ok(fi.ft === 6 && fi.inches === 0, JSON.stringify(fi));
    const fi2 = S.feetInches(5 + 11.6 / 12); ok(fi2.ft === 6 && fi2.inches === 0, JSON.stringify(fi2));
  }],

  // ---------------- Presets, default band, add player ----------------
  ['default band does not overlap and is in front of the mic', () => {
    const pos = S.makeDefaultBand().map(p => p.position);
    ok(S.pairsOk(pos), fmtPos(pos));
    pos.forEach(p => ok(S.inBounds(p, 0), fmtPos([p])));
  }],
  ['every preset is feasible for 1–8 players at any mic rotation', () => {
    for (const name of S.PRESETS) for (let n = 1; n <= 8; n++) for (const rot of [0, 90, -45, 180]) {
      const ps = S.presetPositions(name, n, rot);
      ok(ps.length === n, `${name} n=${n}`);
      ok(S.pairsOk(ps), `${name} n=${n} rot=${rot} overlaps: ${fmtPos(ps)}`);
      ps.forEach(p => ok(S.inBounds(p, rot), `${name} n=${n} rot=${rot} out of bounds ${fmtPos([p])}`));
    }
  }],
  ['add player: each new player gets a distinct, non-overlapping spot', () => {
    for (const rot of [0, 90]) {
      const pos = S.presetPositions('semicircle', 4, rot);
      for (let k = 0; k < 4; k++) pos.push(S.findFreeSpot(pos, rot));
      ok(S.pairsOk(pos), `rot ${rot}: ${fmtPos(pos)}`);
      pos.slice(4).forEach(p => ok(S.inBounds(p, rot), fmtPos([p])));
    }
  }],
  ['projectFeasible separates coincident and overlapping players and moves players out from behind the mic', () => {
    for (const rot of [0, 90]) {
      const r = S.projectFeasible([{ x: 0, z: 3 }, { x: 0, z: 3 }, { x: 0, z: 3.1 }, { x: 0, z: -5 }], rot);
      ok(r.ok, fmtPos(r.positions));
      r.positions.forEach(p => ok(S.inBounds(p, rot), fmtPos([p])));
    }
  }],

  // ---------------- Auto Balance ----------------
  ['auto balance converges for the default band, mic at 0°', () => {
    const band = S.makeDefaultBand(); const res = S.autoBalance(band, mic0);
    checkSolved(band, mic0, res);
  }],
  ['auto balance converges with the mic rotated 90°, −45° and 180° (constraints are mic-relative)', () => {
    for (const rotation of [90, -45, 180]) {
      const mic = { ...mic0, rotation };
      const band = S.makeDefaultBand(); const res = S.autoBalance(band, mic);
      checkSolved(band, mic, res);
    }
  }],
  ['auto balance: louder instruments end up further back (banjo behind mandolin)', () => {
    const band = S.makeDefaultBand(); const res = S.autoBalance(band, mic0);
    const r = res.positions.map(p => Math.hypot(p.x, p.z));
    ok(r[0] > r[3], `banjo ${r[0].toFixed(2)} vs mandolin ${r[3].toFixed(2)}`);
  }],
  ['auto balance in Lock Dir mode keeps facings and still converges', () => {
    const band = S.makeDefaultBand(); const res = S.autoBalance(band, mic0, { faceMic: false });
    ok(res.facings === null);
    checkSolved(band, mic0, res);
  }],
  ['auto balance converges from an infeasible start (overlapping, behind the mic)', () => {
    const band = bandAt([{ x: 0, z: 3 }, { x: 0.1, z: 3 }, { x: 0, z: -4 }, { x: 0, z: 0 }]);
    const res = S.autoBalance(band, mic0);
    checkSolved(band, mic0, res);
  }],
  ['auto balance converges for 6 players', () => {
    const insts = ['banjo', 'guitar', 'bass', 'mandolin', 'fiddle', 'dobro'];
    const ps = [];
    insts.forEach((k, i) => { const p = S.findFreeSpot(ps.map(q => q.position), 0); ps.push(S.makePlayer('P' + i, k, 5.8, null, p.x, p.z)); });
    checkSolved(ps, mic0, S.autoBalance(ps, mic0));
  }],
  ['auto balance reports failure (not success) when a player cannot get quiet enough', () => {
    const band = S.makeDefaultBand(); band[0].instrumentSPL = 115;
    const res = S.autoBalance(band, mic0);
    ok(!res.converged && res.reason === 'range' && res.spread > S.SOLVER.tolDb, JSON.stringify({ c: res.converged, r: res.reason }));
    ok(S.pairsOk(res.positions));
  }],
  ['auto balance reports failure when the arc is too crowded, without overlapping anyone', () => {
    const ps = [];
    for (let i = 0; i < 10; i++) { const p = S.findFreeSpot(ps.map(q => q.position), 0); ps.push(S.makePlayer('P' + i, 'guitar', 5.8, null, p.x, p.z)); }
    const res = S.autoBalance(ps, mic0, { maxIter: 200 });
    if (!res.converged) { ok(res.reason === 'crowded' || res.reason === 'range', String(res.reason)); ok(res.iterations <= 200); }
    ok(S.pairsOk(res.positions), fmtPos(res.positions));
  }],
];

export { AssertionError };
