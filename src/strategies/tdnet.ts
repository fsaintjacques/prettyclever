/**
 * TD(λ)-trained value network, TD-Gammon style.
 *
 * V(state) → predicted final score / 300, learned by self-play temporal
 * difference learning (scripts/train-td.ts). The policy is pure afterstate
 * argmax: at every decision node, apply each candidate action, resolve any
 * queued bonus decisions by the same argmax (mirrors resolvePendingGreedy),
 * and pick the action whose resulting state V likes best. Chance is exogenous
 * and the features deliberately exclude die faces, so a state in a roll phase
 * is valued as an implicit expectation over rolls — which is exactly what
 * makes reroll actions comparable to picks without any threshold hack.
 *
 * Terminal states are always valued with the real scoreState() total, never
 * with the net.
 *
 * The network is a hand-rolled MLP (input → 128 → 128 → 1, ReLU hidden,
 * linear output on score/300) over ~160 hand-crafted features. Weights live
 * in tdnet-weights.ts (a generated module; a .ts file instead of .json so the
 * import works identically under tsx, vite and vitest with no config).
 */
import {
  applyAction,
  getPending,
  scoreState,
  type Action,
  type GameState,
  type RNG,
  type VariantDef,
} from '../engine';
import type { Strategy } from './types';
import { TDNET_WEIGHTS } from './tdnet-weights';

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

export const TD_FEATURES = 163;

interface VMeta {
  yellowGroups: { cells: number[] }[];
  blueGroups: { cells: number[] }[];
  greenThresholds: number[];
  orangeMult: number[];
}

const metaCache = new WeakMap<VariantDef, VMeta>();

function metaOf(v: VariantDef): VMeta {
  let m = metaCache.get(v);
  if (m) return m;
  const area = (id: string) => v.areas.find((a) => a.id === id);
  const groupsOf = (id: string) => area(id)?.ui.groups ?? [];
  const green = area('green');
  const orange = area('orange');
  m = {
    yellowGroups: groupsOf('yellow'),
    blueGroups: groupsOf('blue'),
    greenThresholds: green
      ? green.ui.cells.map((c) => Number((c.label ?? '≥0').slice(1)) || 0)
      : [],
    orangeMult: orange
      ? orange.ui.cells.map((c) => (c.label ? Number(c.label.replace('×', '')) || 1 : 1))
      : [],
  };
  metaCache.set(v, m);
  return m;
}

const PHASES = [
  'roll',
  'pick',
  'endTurn',
  'passiveRoll',
  'passivePick',
  'passiveEndTurn',
  'over',
] as const;

/**
 * Encode a state into `x` (length TD_FEATURES), everything in ~[0, 1].
 * Die faces are intentionally not encoded (see module doc).
 */
export function extractFeatures(s: GameState, v: VariantDef, x: Float64Array): void {
  x.fill(0);
  const m = metaOf(v);
  const br = scoreState(s, v);
  let k = 0;

  // Yellow: per-cell crossed bits (16) + group completion fractions (9).
  const yellow = s.areas.yellow;
  if (yellow) for (let i = 0; i < 16 && i < yellow.length; i++) if (yellow[i]) x[k + i] = 1;
  k += 16;
  for (let g = 0; g < 9; g++) {
    const grp = m.yellowGroups[g];
    if (grp && yellow) {
      let done = 0;
      for (const c of grp.cells) if (yellow[c]) done++;
      x[k + g] = done / grp.cells.length;
    }
  }
  k += 9;

  // Blue: per-cell bits (11) + count thermometer (11) + group fractions (7).
  const blue = s.areas.blue;
  let blueCount = 0;
  if (blue) {
    for (let i = 0; i < 11 && i < blue.length; i++) {
      if (blue[i]) {
        x[k + i] = 1;
        blueCount++;
      }
    }
  }
  k += 11;
  for (let i = 0; i < blueCount; i++) x[k + i] = 1;
  k += 11;
  for (let g = 0; g < 7; g++) {
    const grp = m.blueGroups[g];
    if (grp && blue) {
      let done = 0;
      for (const c of grp.cells) if (blue[c]) done++;
      x[k + g] = done / grp.cells.length;
    }
  }
  k += 7;

  // Green: crossed-count thermometer (11) + ease of the next threshold (1).
  const green = s.areas.green;
  let gc = 0;
  if (green) {
    while (gc < green.length && green[gc]) gc++;
    for (let i = 0; i < gc && i < 11; i++) x[k + i] = 1;
  }
  k += 11;
  if (green && gc < m.greenThresholds.length) x[k] = (7 - m.greenThresholds[gc]) / 6;
  k += 1;

  // Orange: filled thermometer (11) + normalized sum (1) + next multiplier one-hot (4).
  const orange = s.areas.orange;
  let oc = 0;
  let osum = 0;
  if (orange) {
    while (oc < orange.length && orange[oc] !== 0) oc++;
    for (const c of orange) osum += c;
    for (let i = 0; i < oc && i < 11; i++) x[k + i] = 1;
  }
  k += 11;
  x[k] = osum / 60;
  k += 1;
  if (orange) {
    if (oc >= orange.length) x[k] = 1; // track full
    else x[k + Math.min(3, m.orangeMult[oc] ?? 1)] = 1; // ×1 / ×2 / ×3
  }
  k += 4;

  // Purple: filled thermometer (11) + current ascending bar one-hot (7) + sum (1).
  const purple = s.areas.purple;
  let pc = 0;
  let psum = 0;
  if (purple) {
    while (pc < purple.length && purple[pc] !== 0) pc++;
    for (const c of purple) psum += c;
    for (let i = 0; i < pc && i < 11; i++) x[k + i] = 1;
  }
  k += 11;
  if (purple && pc < purple.length) {
    const last = pc === 0 ? 0 : purple[pc - 1];
    x[k + (last === 6 ? 0 : Math.min(6, last))] = 1;
  }
  k += 7;
  x[k] = psum / 66;
  k += 1;

  // Unspent actions and foxes (capped thermometers).
  for (let i = 0; i < 4 && i < s.rerolls; i++) x[k + i] = 1;
  k += 4;
  for (let i = 0; i < 4 && i < s.plus1; i++) x[k + i] = 1;
  k += 4;
  for (let i = 0; i < 6 && i < s.foxes; i++) x[k + i] = 1;
  k += 6;
  x[k] = s.foxes / 6;
  k += 1;

  // Current score snapshot.
  x[k] = (br.areas.yellow ?? 0) / 60;
  x[k + 1] = (br.areas.blue ?? 0) / 56;
  x[k + 2] = (br.areas.green ?? 0) / 66;
  x[k + 3] = (br.areas.orange ?? 0) / 60;
  x[k + 4] = (br.areas.purple ?? 0) / 60;
  k += 5;
  x[k] = br.minArea / 40;
  k += 1;
  x[k] = br.total / 300;
  k += 1;

  // Time: round one-hot (6), phase one-hot (7), picks one-hot (4), time left (1).
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

  // Dice locations (faces excluded on purpose) and +1 usage.
  for (let i = 0; i < 6 && i < s.loc.length; i++) if (s.loc[i] === 'pool') x[k + i] = 1;
  k += 6;
  for (let i = 0; i < 6 && i < s.loc.length; i++) if (s.loc[i] === 'platter') x[k + i] = 1;
  k += 6;
  for (let i = 0; i < 6 && i < s.plus1Used.length; i++) if (s.plus1Used[i]) x[k + i] = 1;
  k += 6;

  // Pending bonus queue.
  x[k] = Math.min(3, s.pending.length) / 3;
  for (const e of s.pending) {
    if (e.t === 'crossAny') {
      if (e.area === 'yellow') x[k + 1] = 1;
      else if (e.area === 'blue') x[k + 2] = 1;
    } else if (e.t === 'choice') x[k + 3] = 1;
  }
  k += 4;

  if (k !== TD_FEATURES) throw new Error(`tdnet feature count mismatch: ${k} != ${TD_FEATURES}`);
}

// ---------------------------------------------------------------------------
// MLP (hand-rolled, no dependencies)
// ---------------------------------------------------------------------------

/** Serialized weights (row-major: W1[i * nH1 + j] connects input i → hidden j). */
export interface TdNetParams {
  nIn: number;
  nH1: number;
  nH2: number;
  W1: number[];
  b1: number[];
  W2: number[];
  b2: number[];
  W3: number[];
  b3: number;
}

export interface Net {
  nIn: number;
  nH1: number;
  nH2: number;
  W1: Float64Array;
  b1: Float64Array;
  W2: Float64Array;
  b2: Float64Array;
  W3: Float64Array;
  b3: Float64Array; // length 1
}

export function netFromParams(p: TdNetParams): Net {
  if (p.W1.length !== p.nIn * p.nH1 || p.W2.length !== p.nH1 * p.nH2 || p.W3.length !== p.nH2) {
    throw new Error('tdnet weights have inconsistent shapes');
  }
  return {
    nIn: p.nIn,
    nH1: p.nH1,
    nH2: p.nH2,
    W1: Float64Array.from(p.W1),
    b1: Float64Array.from(p.b1),
    W2: Float64Array.from(p.W2),
    b2: Float64Array.from(p.b2),
    W3: Float64Array.from(p.W3),
    b3: Float64Array.of(p.b3),
  };
}

const round5 = (x: number) => Number(x.toPrecision(5));

export function paramsFromNet(net: Net): TdNetParams {
  return {
    nIn: net.nIn,
    nH1: net.nH1,
    nH2: net.nH2,
    W1: Array.from(net.W1, round5),
    b1: Array.from(net.b1, round5),
    W2: Array.from(net.W2, round5),
    b2: Array.from(net.b2, round5),
    W3: Array.from(net.W3, round5),
    b3: round5(net.b3[0]),
  };
}

/** He-normal initialization from a seeded RNG. */
export function initNet(nIn: number, nH1: number, nH2: number, rng: RNG): Net {
  const gauss = () => {
    const u = Math.max(rng(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
  const fill = (arr: Float64Array, fanIn: number) => {
    const sd = Math.sqrt(2 / fanIn);
    for (let i = 0; i < arr.length; i++) arr[i] = gauss() * sd;
    return arr;
  };
  return {
    nIn,
    nH1,
    nH2,
    W1: fill(new Float64Array(nIn * nH1), nIn),
    b1: new Float64Array(nH1),
    W2: fill(new Float64Array(nH1 * nH2), nH1),
    b2: new Float64Array(nH2),
    W3: fill(new Float64Array(nH2), nH2),
    b3: new Float64Array(1),
  };
}

/**
 * Forward pass. `h1`/`h2` receive the post-ReLU hidden activations (the
 * trainer's backprop reads them). The input layer skips zero features — the
 * encoding is mostly sparse binary, which roughly halves the cost.
 */
export function forward(net: Net, x: Float64Array, h1: Float64Array, h2: Float64Array): number {
  const { nH1, nH2, W1, W2, W3 } = net;
  h1.set(net.b1);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    if (xi === 0) continue;
    const off = i * nH1;
    for (let j = 0; j < nH1; j++) h1[j] += xi * W1[off + j];
  }
  h2.set(net.b2);
  for (let j = 0; j < nH1; j++) {
    let hj = h1[j];
    if (hj <= 0) {
      h1[j] = 0;
      continue;
    }
    const off = j * nH2;
    for (let t = 0; t < nH2; t++) h2[t] += hj * W2[off + t];
  }
  let y = net.b3[0];
  for (let t = 0; t < nH2; t++) {
    if (h2[t] <= 0) h2[t] = 0;
    else y += h2[t] * W3[t];
  }
  return y;
}

// ---------------------------------------------------------------------------
// Value-based policy
// ---------------------------------------------------------------------------

/** Reusable scratch buffers for one evaluation stream. */
export interface EvalCtx {
  net: Net;
  x: Float64Array;
  h1: Float64Array;
  h2: Float64Array;
}

export function createEvalCtx(net: Net): EvalCtx {
  return {
    net,
    x: new Float64Array(net.nIn),
    h1: new Float64Array(net.nH1),
    h2: new Float64Array(net.nH2),
  };
}

/** V(state) on the score/300 scale; terminal states use the real score. */
export function stateValue(ctx: EvalCtx, s: GameState, v: VariantDef): number {
  if (s.phase === 'over') return scoreState(s, v).total / 300;
  extractFeatures(s, v, ctx.x);
  return forward(ctx.net, ctx.x, ctx.h1, ctx.h2);
}

/** Resolve queued bonus decisions by one-step V argmax (à la resolvePendingGreedy). */
export function resolvePendingByValue(ctx: EvalCtx, s: GameState, v: VariantDef): GameState {
  let cur = s;
  let guard = 0;
  while (cur.pending.length > 0 && guard++ < 64) {
    const node = getPending(cur, v);
    if (node.kind !== 'decision') break;
    let best: GameState | null = null;
    let bestVal = -Infinity;
    for (const a of node.actions) {
      const ns = applyAction(cur, v, a);
      const val = stateValue(ctx, ns, v);
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
export function chooseByValue(
  ctx: EvalCtx,
  s: GameState,
  v: VariantDef,
  actions: Action[],
): Action {
  let best = actions[0];
  let bestVal = -Infinity;
  for (const a of actions) {
    const ns = resolvePendingByValue(ctx, applyAction(s, v, a), v);
    const val = stateValue(ctx, ns, v);
    if (val > bestVal) {
      bestVal = val;
      best = a;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Strategy factories
// ---------------------------------------------------------------------------

export interface TdNetOpts {
  params?: TdNetParams;
  name?: string;
}

export function makeTdNet(opts: TdNetOpts = {}): Strategy {
  const ctx = createEvalCtx(netFromParams(opts.params ?? TDNET_WEIGHTS));
  return {
    name: opts.name ?? 'td-net',
    choose(state, actions, c) {
      if (actions.length === 1) return actions[0];
      return chooseByValue(ctx, state, c.variant, actions);
    },
  };
}

/** Leaf evaluation on the score scale, for expectimax's `evalFn`. */
export function makeTdNetEval(params?: TdNetParams): (s: GameState, v: VariantDef) => number {
  const ctx = createEvalCtx(netFromParams(params ?? TDNET_WEIGHTS));
  return (s, v) => 300 * stateValue(ctx, s, v);
}
