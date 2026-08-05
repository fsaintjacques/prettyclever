/**
 * Hand-crafted domain strategy ("planner"): expert heuristics layered on top
 * of the greedy one-step evaluation.
 *
 * Design: greedy's evaluate() is already a decent static value function, so
 * instead of re-deriving one from scratch the planner reuses it and fixes the
 * specific blind spots of one-step play with cheap rule layers, all O(sheet)
 * per candidate action:
 *
 * 1. Round-phased weights — the same sheet cell is worth different amounts in
 *    round 1 vs round 6 (convex green/blue tables want early feeding, hoarded
 *    +1 actions want spending late), so the eval weights shift by round.
 * 2. Purple 6-chains — a one-step eval sees a purple 6 as just 6 points, but
 *    a written 6 also resets the ascending constraint, roughly doubling the
 *    track's future throughput. The planner adds an explicit time-scaled
 *    bonus for every purple 6 that appears in the post-state diff (so
 *    cascaded purple-6 bonuses from blue/green/orange are priced too). A
 *    symmetric "bar-delta" penalty (charging the ascending bar left behind
 *    by mid writes) tested negative and defaults to 0.
 * 3. Orange multiplier timing — writing a low face onto a ×2/×3 slot burns
 *    the sheet's best point real estate. Penalize post-state orange writes on
 *    multiplier slots proportional to (5 − face) · mult. (Ablation: with the
 *    per-mult slot opportunity cost already in the eval weights this extra
 *    penalty tested slightly negative, so it defaults to 0 and stays
 *    available as a knob.)
 * 4. Per-die pool option value — greedy prices every die left in the pool at
 *    a flat rate, but a surviving purple die facing a bar of 5 is nearly
 *    worthless while the white die is always live. The planner replaces the
 *    flat term with a per-color, sheet-aware option value (survivors get
 *    re-rolled, so only color + sheet state matter, not current faces).
 * 5. Re-roll policy — dynamic threshold: re-rolling is worth more with more
 *    dice still in the pool, when holding several re-rolls, and in the last
 *    rounds (unused re-rolls expire).
 * 6. Fox awareness — fox points (foxes × min area) are exact in scoreState,
 *    so late-game min-area raising is already priced; the planner just keeps
 *    greedy's fox EV for acquisition.
 */
import { applyAction, areaById, type GameState, type VariantDef } from '../engine';
import { defaultWeights, evaluate, resolvePendingGreedy, type Weights } from './greedy';
import type { Strategy } from './types';

export interface PlannerOpts {
  /** Base eval weights (greedy defaults unless overridden). */
  weights?: Partial<Weights>;
  /** Purple: cost per point of ascending "bar" left on the track. */
  purpleBarW: number;
  /** Purple: extra value of writing a 6 (resets the track; one-step eval is blind to it). */
  purpleSixBonus: number;
  /** Orange: cost per (5 − face) · mult of a write on a ×2/×3 slot. */
  orangeMultW: number;
  /** Extra green/blue shaping in rounds 1–2 / removed in rounds 5–6. */
  earlyShaping: number;
  /** +1 action value by phase of the game (hoard early, dump late). */
  plus1Early: number;
  plus1Mid: number;
  plus1Late: number;
  /** Re-roll when the best action gains less than base + perDie·pool (+late). */
  rerollBase: number;
  rerollPerDie: number;
  rerollLate: number;
  /** Extra value per yellow cross (yellow feeds columns, bonuses, and is the chronic min area). */
  yellowShapeW: number;
  /** Scale on the per-die pool option values. */
  poolScale: number;
  /** Option value of the wild die on top of the best colored option. */
  wildBonus: number;
}

export const defaultPlannerOpts: PlannerOpts = {
  weights: {
    groupPotential: 1.0,
    purpleSlotEV: 0.5,
    crossEV: 16,
    blueShaping: 6,
    orangeSlotEVPerMult: 2,
  },
  purpleBarW: 0,
  purpleSixBonus: 7,
  orangeMultW: 0,
  earlyShaping: 1.5,
  plus1Early: 14,
  plus1Mid: 9,
  plus1Late: 8,
  yellowShapeW: 0,
  rerollBase: 2.5,
  rerollPerDie: 0.35,
  rerollLate: 1.5,
  poolScale: 1.0,
  wildBonus: 1.5,
};

/** Ascending-track "bar": the value the next purple write must exceed (0 = free). */
function purpleBar(cells: number[]): number {
  let c = 0;
  while (c < cells.length && cells[c] !== 0) c++;
  if (c >= cells.length || c === 0) return 0;
  const last = cells[c - 1];
  return last === 6 ? 0 : last;
}

/** Fraction of the game remaining (mirrors greedy's timeLeft). */
function timeLeft(s: GameState, v: VariantDef): number {
  const turnFrac = s.phase.startsWith('passive') ? 0.25 : 0.75;
  return Math.max(0, (v.rounds - s.round + turnFrac) / v.rounds);
}

/**
 * Sheet-state-aware option value of each die color while it stays in the pool.
 * Pool dice are re-rolled before the next pick, so only color matters.
 */
function dieOptionValues(s: GameState, v: VariantDef, o: PlannerOpts): number[] {
  const fv: number[] = Array(v.colors.length).fill(0);
  let bestColored = 0;
  for (let die = 0; die < v.colors.length; die++) {
    const color = v.colors[die];
    if (color === v.wild) continue;
    let val = 0;
    if (color === 'yellow') {
      const cells = s.areas.yellow;
      const area = areaById(v, 'yellow');
      // distinct face values still crossable
      const open = new Set<string>();
      area.ui.cells.forEach((c, i) => {
        if (!c.pre && cells[i] === 0 && c.label) open.add(c.label);
      });
      val = (open.size / 6) * 7;
    } else if (color === 'blue') {
      const openBlue = s.areas.blue.filter((c) => c === 0).length;
      val = openBlue > 0 ? Math.min(5.5, 2 + 0.35 * openBlue) : 0;
    } else if (color === 'green') {
      const cells = s.areas.green;
      let c = 0;
      while (c < cells.length && cells[c] === 1) c++;
      if (c < cells.length) {
        const thr = Number(areaById(v, 'green').ui.cells[c].label!.slice(1));
        val = ((7 - thr) / 6) * 7;
      }
    } else if (color === 'orange') {
      const full = s.areas.orange.every((c) => c !== 0);
      val = full ? 0 : 4.5;
    } else if (color === 'purple') {
      const cells = s.areas.purple;
      const full = cells.every((c) => c !== 0);
      if (!full) {
        const bar = purpleBar(cells);
        val = ((6 - bar) / 6) * ((bar + 7) / 2) * 0.8;
      }
    }
    fv[die] = val;
    if (val > bestColored) bestColored = val;
  }
  const wildIdx = v.wild ? v.colors.indexOf(v.wild) : -1;
  if (wildIdx >= 0) fv[wildIdx] = bestColored + o.wildBonus;
  return fv;
}

/**
 * Zero-centered correction for the dice surviving in the pool after picking
 * `die`. The eval already prices survivors at a flat rate (poolDieEV); this
 * adds (fv − flat) per surviving die, so a pick that platters a nearly dead
 * purple die is cheap and one that platters the wild die is expensive.
 */
function survivorCorrection(
  s: GameState,
  v: VariantDef,
  fv: number[],
  fvMean: number,
  die: number,
  o: PlannerOpts,
): number {
  const picksLeftAfter = v.picksPerTurn - s.picks - 1;
  if (picksLeftAfter <= 0) return 0;
  const f = s.faces[die];
  const vals: number[] = [];
  for (let i = 0; i < s.loc.length; i++) {
    if (i === die || s.loc[i] !== 'pool') continue;
    if (s.faces[i] < f) continue; // goes to the platter
    vals.push(fv[i]);
  }
  vals.sort((a, b) => b - a);
  let sum = 0;
  const usable = Math.min(vals.length, picksLeftAfter * 2);
  // Mean-centered: survivor count is already priced by the eval's flat pool
  // term; this only cares about *which* dice survive.
  for (let i = 0; i < usable; i++) sum += vals[i] - fvMean;
  return sum * o.poolScale * (picksLeftAfter / v.picksPerTurn);
}

/** Rule-layer adjustment computed on the post-state diff (sees bonus cascades). */
function ruleAdjust(
  s: GameState,
  ns: GameState,
  v: VariantDef,
  t: number,
  o: PlannerOpts,
): number {
  let adj = 0;
  // Purple discipline: charge the delta of the ascending bar, and reward
  // written 6s (track reset) beyond their face value.
  const pb = s.areas.purple;
  const pa = ns.areas.purple;
  if (pb && pa) {
    adj -= o.purpleBarW * t * (purpleBar(pa) - purpleBar(pb));
    if (o.purpleSixBonus !== 0) {
      for (let i = 0; i < pa.length; i++) {
        if (pb[i] === 0 && pa[i] === 6) adj += o.purpleSixBonus * t;
      }
    }
  }
  // Yellow shaping: flat credit per new cross (columns/bonuses potential).
  if (o.yellowShapeW !== 0) {
    const yb = s.areas.yellow;
    const ya = ns.areas.yellow;
    if (yb && ya) {
      let d = 0;
      for (let i = 0; i < ya.length; i++) if (yb[i] === 0 && ya[i] !== 0) d++;
      adj += o.yellowShapeW * t * d;
    }
  }
  // Orange multiplier timing: penalize low faces landing on ×2/×3 slots.
  const ob = s.areas.orange;
  const oa = ns.areas.orange;
  if (ob && oa) {
    const ui = areaById(v, 'orange').ui.cells;
    for (let i = 0; i < oa.length; i++) {
      if (ob[i] === 0 && oa[i] !== 0) {
        const lbl = ui[i].label;
        if (lbl !== null) {
          const mult = Number(lbl.replace('×', '')) || 1;
          const face = oa[i] / mult;
          if (mult >= 2) adj -= o.orangeMultW * t * mult * Math.max(0, 5 - face);
        }
      }
    }
  }
  return adj;
}

function roundWeights(s: GameState, base: Weights, o: PlannerOpts): Weights {
  const w = { ...base };
  const r = s.round;
  if (r <= 2) {
    w.blueShaping += o.earlyShaping;
    w.greenShaping += o.earlyShaping;
    w.plus1 = o.plus1Early;
  } else if (r >= 5) {
    w.blueShaping = Math.max(0, w.blueShaping - o.earlyShaping);
    w.greenShaping = Math.max(0, w.greenShaping - o.earlyShaping);
    w.plus1 = o.plus1Late;
  } else {
    w.plus1 = o.plus1Mid;
  }
  return w;
}

export function makePlanner(opts: Partial<PlannerOpts> = {}, name = 'planner'): Strategy {
  const o: PlannerOpts = {
    ...defaultPlannerOpts,
    ...opts,
    weights: { ...defaultPlannerOpts.weights, ...opts.weights },
  };
  const base: Weights = { ...defaultWeights, ...o.weights };
  return {
    name,
    choose(state, actions, ctx) {
      const v = ctx.variant;
      const w = roundWeights(state, base, o);
      const t = timeLeft(state, v);
      const inPick = state.phase === 'pick' && state.pending.length === 0;
      const fv = inPick ? dieOptionValues(state, v, o) : null;
      let fvMean = 0;
      if (fv) {
        let n = 0;
        for (let i = 0; i < state.loc.length; i++) {
          if (state.loc[i] === 'pool') {
            fvMean += fv[i];
            n++;
          }
        }
        if (n > 0) fvMean /= n;
      }

      let best = actions[0];
      let bestVal = -Infinity;
      for (const a of actions) {
        if (a.t === 'reroll') continue; // handled by threshold rule below
        const ns = resolvePendingGreedy(applyAction(state, v, a), v, w);
        let val = evaluate(ns, v, w) + ruleAdjust(state, ns, v, t, o);
        if (fv && a.t === 'pick') {
          val += survivorCorrection(state, v, fv, fvMean, a.die, o);
        }
        if (val > bestVal) {
          bestVal = val;
          best = a;
        }
      }
      if (actions.some((a) => a.t === 'reroll')) {
        const pool = state.loc.filter((l) => l === 'pool').length;
        const threshold =
          o.rerollBase + o.rerollPerDie * pool + (state.round >= 5 ? o.rerollLate : 0);
        if (bestVal - evaluate(state, v, w) < threshold) return { t: 'reroll' };
      }
      return best;
    },
  };
}
