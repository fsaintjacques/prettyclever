/**
 * TD(λ) value network for Twice as Clever (Doppelt so clever).
 *
 * Mirrors tdnet.ts: V(state) → predicted final score / 400, learned by
 * self-play TD (scripts/train-td-parallel.ts --features twice). The policy is
 * pure afterstate argmax over V — every new action type of this variant
 * (return/proceed, platter-chain row choices, colored ?s) is absorbed by the
 * afterstate formulation with no action encoding. Pending bonus decisions are
 * resolved by the same argmax; terminal states use the real scoreState().
 *
 * Features are face-blind (as in the base game): chance is exogenous, so a
 * state in a roll phase is valued as an implicit expectation over rolls.
 *
 * Encoding notes (everything ~[0, 1]):
 *  - The green pair area and therefore minArea / fox points / total can be
 *    NEGATIVE. Signed quantities use the affine map (x + 92) / 184 — ±92 is
 *    the exact green extreme (sum of per-pair best/worst: ±(10+11+15+16+17+23))
 *    — so 0 points sits at 0.5. The value target score/400 is simply allowed
 *    to go negative; the output head is linear.
 *  - Yellow's circled-but-not-crossed distinction ("stored energy" for the
 *    brutally convex crossing table) gets separate circled/crossed cell bits
 *    and separate count thermometers, so the net can see tempo.
 *  - Green tempo: next-slot parity + next-slot multiplier one-hot + the
 *    pending first-of-pair written value (the subtraction exposure, /24).
 *  - Action bars carry both the *available* counters (capped thermometers)
 *    and the *cumulative* unlock thermometers (end-of-bar bonuses — the 6th
 *    reroll unlock is a fox, i.e. a scoring line).
 *
 * The Net / forward / EvalCtx machinery is reused from tdnet.ts; weights live
 * in tdnet-twice-weights.ts (generated).
 */
import {
  applyAction,
  getPending,
  scoreState,
  type Action,
  type GameState,
  type VariantDef,
} from '../engine';
import type { Strategy } from './types';
import {
  createEvalCtx,
  forward,
  netFromParams,
  type EvalCtx,
  type TdNetParams,
} from './tdnet';
import { TDNET_TWICE_WEIGHTS } from './tdnet-twice-weights';

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

export const TDT_FEATURES = 252;

/** Value scale: predicted final score / 400 (rating tops out at 320+). */
export const TDT_SCALE = 400;

/** Signed score map: ±92 (the exact green-area extremes) → [0, 1], 0 ↦ 0.5. */
const signed = (x: number) => (x + 92) / 184;

interface TMeta {
  /** Indices of the 10 real yellow lattice cells (layout holes skipped). */
  yellowCells: number[];
  yellowGroups: { cells: number[] }[];
  /** Green per-slot multipliers (1–4). */
  greenMult: number[];
  /** Pink per-slot bonus thresholds (0 = ungated). */
  pinkThresholds: number[];
}

const metaCache = new WeakMap<VariantDef, TMeta>();

function metaOf(v: VariantDef): TMeta {
  let m = metaCache.get(v);
  if (m) return m;
  const area = (id: string) => v.areas.find((a) => a.id === id);
  const yellow = area('yellow');
  const green = area('green');
  const pink = area('pink');
  const yellowCells: number[] = [];
  yellow?.ui.cells.forEach((c, i) => {
    if (!c.void) yellowCells.push(i);
  });
  m = {
    yellowCells,
    yellowGroups: yellow?.ui.groups ?? [],
    greenMult: green ? green.ui.cells.map((c) => Number((c.label ?? '×1').slice(1)) || 1) : [],
    pinkThresholds: pink
      ? pink.ui.cells.map((c) => (c.label?.startsWith('≥') ? Number(c.label.slice(1)) || 0 : 0))
      : [],
  };
  metaCache.set(v, m);
  return m;
}

const PHASES = [
  'roll',
  'preRoll',
  'pick',
  'endTurn',
  'passiveRoll',
  'passivePick',
  'passiveEndTurn',
] as const;

const AREA_IDX: Record<string, number> = { silver: 0, yellow: 1, blue: 2, green: 3, pink: 4 };

/**
 * Encode a state into `x` (length TDT_FEATURES). Die faces are intentionally
 * not encoded (see module doc).
 */
export function extractFeaturesTwice(s: GameState, v: VariantDef, x: Float64Array): void {
  x.fill(0);
  const m = metaOf(v);
  const br = scoreState(s, v);
  let k = 0;

  // Silver: 24 cell bits + per-row count thermometers (4×6) + column fractions (6).
  const silver = s.areas.silver;
  for (let i = 0; i < 24; i++) if (silver[i]) x[k + i] = 1;
  k += 24;
  for (let r = 0; r < 4; r++) {
    let c = 0;
    for (let col = 0; col < 6; col++) if (silver[r * 6 + col]) c++;
    for (let i = 0; i < c; i++) x[k + r * 6 + i] = 1;
  }
  k += 24;
  for (let col = 0; col < 6; col++) {
    let c = 0;
    for (let r = 0; r < 4; r++) if (silver[r * 6 + col]) c++;
    x[k + col] = c / 4;
  }
  k += 6;

  // Yellow: circled bits (10) + crossed bits (10) + circled-count therm (10)
  // + crossed-count therm (10) + group circled-progress fractions (9).
  const yellow = s.areas.yellow;
  let circ = 0;
  let cross = 0;
  for (let i = 0; i < 10; i++) {
    const st = yellow[m.yellowCells[i]];
    if (st >= 1) {
      x[k + i] = 1;
      circ++;
    }
    if (st === 2) {
      x[k + 10 + i] = 1;
      cross++;
    }
  }
  k += 20;
  for (let i = 0; i < circ; i++) x[k + i] = 1;
  k += 10;
  for (let i = 0; i < cross; i++) x[k + i] = 1;
  k += 10;
  for (let g = 0; g < 9; g++) {
    const grp = m.yellowGroups[g];
    if (grp) {
      let done = 0;
      for (const c of grp.cells) if (yellow[c] >= 1) done++;
      x[k + g] = done / grp.cells.length;
    }
  }
  k += 9;

  // Blue: filled thermometer (12) + current floor one-hot (11, values 2–12;
  // an empty track floors at 12 = full descent budget).
  const blue = s.areas.blue;
  let bc = 0;
  while (bc < 12 && blue[bc] !== 0) bc++;
  for (let i = 0; i < bc; i++) x[k + i] = 1;
  k += 12;
  const floor = bc === 0 ? 12 : blue[bc - 1];
  x[k + floor - 2] = 1;
  k += 11;

  // Green: filled thermometer (12) + next-slot parity (1) + next-slot
  // multiplier one-hot (4) + pending first-of-pair value /24 (1) + signed
  // completed-pairs total (1).
  const green = s.areas.green;
  let gc = 0;
  while (gc < 12 && green[gc] !== 0) gc++;
  for (let i = 0; i < gc; i++) x[k + i] = 1;
  k += 12;
  const gOpen = gc < 12;
  if (gOpen && gc % 2 === 0) x[k] = 1; // next write opens a pair
  k += 1;
  if (gOpen) x[k + m.greenMult[gc] - 1] = 1; // ×1..×4
  k += 4;
  if (gOpen && gc % 2 === 1) x[k] = green[gc - 1] / 24; // subtraction exposure
  k += 1;
  x[k] = signed(br.areas.green);
  k += 1;

  // Pink: filled thermometer (12) + next-slot threshold one-hot (6:
  // none/≥2/≥3/≥4/≥5/≥6) + normalized sum (1).
  const pink = s.areas.pink;
  let pc = 0;
  let psum = 0;
  while (pc < 12 && pink[pc] !== 0) pc++;
  for (const c of pink) psum += c;
  for (let i = 0; i < pc; i++) x[k + i] = 1;
  k += 12;
  if (pc < 12) {
    const t = m.pinkThresholds[pc];
    x[k + (t === 0 ? 0 : t - 1)] = 1;
  }
  k += 6;
  x[k] = psum / 72;
  k += 1;

  // Action bars: available counters (capped thermometers, 3×4) and
  // cumulative unlock thermometers (3×6 — bar completion is a bonus line).
  for (let i = 0; i < 4 && i < s.rerolls; i++) x[k + i] = 1;
  k += 4;
  for (let i = 0; i < 4 && i < s.plus1; i++) x[k + i] = 1;
  k += 4;
  for (let i = 0; i < 4 && i < s.returns; i++) x[k + i] = 1;
  k += 4;
  for (let i = 0; i < 6 && i < s.barUnlocks.reroll; i++) x[k + i] = 1;
  k += 6;
  for (let i = 0; i < 6 && i < s.barUnlocks.plus1; i++) x[k + i] = 1;
  k += 6;
  for (let i = 0; i < 6 && i < s.barUnlocks.return; i++) x[k + i] = 1;
  k += 6;

  // Foxes.
  for (let i = 0; i < 6 && i < s.foxes; i++) x[k + i] = 1;
  k += 6;
  x[k] = s.foxes / 6;
  k += 1;

  // Score snapshot (green / minArea / total can be negative — signed maps).
  x[k] = br.areas.silver / 88;
  x[k + 1] = br.areas.yellow / 165;
  x[k + 2] = br.areas.blue / 78;
  x[k + 3] = signed(br.areas.green);
  x[k + 4] = br.areas.pink / 72;
  k += 5;
  x[k] = signed(br.minArea);
  k += 1;
  x[k] = br.total / TDT_SCALE;
  k += 1;

  // Time: round one-hot (6), phase one-hot (7, incl. preRoll), picks one-hot
  // (4), time left (1).
  x[k + Math.min(5, s.round - 1)] = 1;
  k += 6;
  const ph = PHASES.indexOf(s.phase as (typeof PHASES)[number]);
  if (ph >= 0) x[k + ph] = 1;
  k += 7;
  x[k + Math.min(3, s.picks)] = 1;
  k += 4;
  const turnFrac = s.phase.startsWith('passive') ? 0.25 : 0.75;
  x[k] = Math.max(0, (v.rounds - s.round + turnFrac) / v.rounds);
  k += 1;

  // Dice locations (faces excluded on purpose) and +1 usage (per ROUND here).
  for (let i = 0; i < 6 && i < s.loc.length; i++) if (s.loc[i] === 'pool') x[k + i] = 1;
  k += 6;
  for (let i = 0; i < 6 && i < s.loc.length; i++) if (s.loc[i] === 'platter') x[k + i] = 1;
  k += 6;
  for (let i = 0; i < 6 && i < s.plus1Used.length; i++) if (s.plus1Used[i]) x[k + i] = 1;
  k += 6;

  // Pending bonus queue: length + free-? per-area flags + silverMark + choice.
  x[k] = Math.min(3, s.pending.length) / 3;
  for (const e of s.pending) {
    if (e.t === 'free') {
      const i = AREA_IDX[e.area];
      if (i !== undefined) x[k + 1 + i] = 1;
    } else if (e.t === 'silverMark') x[k + 6] = 1;
    else if (e.t === 'choice') x[k + 7] = 1;
  }
  k += 8;

  if (k !== TDT_FEATURES) {
    throw new Error(`tdnet-twice feature count mismatch: ${k} != ${TDT_FEATURES}`);
  }
}

// ---------------------------------------------------------------------------
// Value-based policy (same shape as tdnet.ts, on the /400 scale)
// ---------------------------------------------------------------------------

/** V(state) on the score/400 scale; terminal states use the real score. */
export function stateValueTwice(ctx: EvalCtx, s: GameState, v: VariantDef): number {
  if (s.phase === 'over') return scoreState(s, v).total / TDT_SCALE;
  extractFeaturesTwice(s, v, ctx.x);
  return forward(ctx.net, ctx.x, ctx.h1, ctx.h2);
}

/** Resolve queued bonus decisions (colored ?s, row choices, black ?) by one-step V argmax. */
export function resolvePendingByValueTwice(ctx: EvalCtx, s: GameState, v: VariantDef): GameState {
  let cur = s;
  let guard = 0;
  while (cur.pending.length > 0 && guard++ < 64) {
    const node = getPending(cur, v);
    if (node.kind !== 'decision') break;
    let best: GameState | null = null;
    let bestVal = -Infinity;
    for (const a of node.actions) {
      const ns = applyAction(cur, v, a);
      const val = stateValueTwice(ctx, ns, v);
      if (val > bestVal) {
        bestVal = val;
        best = ns;
      }
    }
    if (!best) break;
    cur = best;
  }
  return cur;
}

/** Afterstate argmax over V; the policy for td-net and for self-play training. */
export function chooseByValueTwice(
  ctx: EvalCtx,
  s: GameState,
  v: VariantDef,
  actions: Action[],
): Action {
  let best = actions[0];
  let bestVal = -Infinity;
  for (const a of actions) {
    const ns = resolvePendingByValueTwice(ctx, applyAction(s, v, a), v);
    const val = stateValueTwice(ctx, ns, v);
    if (val > bestVal) {
      bestVal = val;
      best = a;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Strategy factory
// ---------------------------------------------------------------------------

export interface TdNetTwiceOpts {
  params?: TdNetParams;
  name?: string;
}

export function makeTdNetTwice(opts: TdNetTwiceOpts = {}): Strategy {
  const ctx = createEvalCtx(netFromParams(opts.params ?? TDNET_TWICE_WEIGHTS));
  return {
    name: opts.name ?? 'td-net',
    choose(state, actions, c) {
      if (actions.length === 1) return actions[0];
      return chooseByValueTwice(ctx, state, c.variant, actions);
    },
  };
}
