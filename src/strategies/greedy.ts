/**
 * One-step lookahead with a tunable evaluation function.
 *
 * The evaluation function is the main experimentation surface: it values the
 * current score plus "potential" — unspent actions, earned foxes, partially
 * complete bonus groups, and the opportunity cost of burning orange/purple
 * slots on low numbers. All weights are parameters; tweak them or pass your
 * own via makeGreedy({...}).
 */
import {
  applyAction,
  getPending,
  scoreState,
  type Effect,
  type GameState,
  type VariantDef,
} from '../engine';
import type { Strategy } from './types';

export interface Weights {
  /** Value of an unspent reroll / +1 action (scaled by time left). */
  reroll: number;
  plus1: number;
  /** Expected end-game value of one fox (used while the min area is still low). */
  foxEV: number;
  /** Multiplier on partial progress toward group bonuses/points (yellow/blue rows, cols). */
  groupPotential: number;
  /** Expected value of a generic bonus cross (crossAny/crossNext) when valuing groups. */
  crossEV: number;
  /** Expected future value of one empty purple slot. */
  purpleSlotEV: number;
  /** Expected future value of one empty orange slot, per multiplier unit. */
  orangeSlotEVPerMult: number;
  /**
   * Convex point tables (blue count, green track) pay almost nothing for
   * early crosses; these value each cross at its amortized slope so greedy
   * doesn't starve those areas.
   */
  blueShaping: number;
  greenShaping: number;
  /**
   * Option value of a die still in the pool during the active turn: picking a
   * high die throws every lower die on the platter, which a one-step eval
   * would otherwise not see.
   */
  poolDieEV: number;
  /** Reroll instead of picking when the best pick gains less than this. */
  rerollGainThreshold: number;
}

export const defaultWeights: Weights = {
  reroll: 4,
  plus1: 9,
  foxEV: 16,
  groupPotential: 0.8,
  crossEV: 7,
  purpleSlotEV: 4,
  orangeSlotEVPerMult: 3.5,
  blueShaping: 5,
  greenShaping: 6,
  poolDieEV: 6,
  rerollGainThreshold: 4,
};

/** Fraction of the game remaining, in [0, 1]. */
function timeLeft(s: GameState, v: VariantDef): number {
  const turnFrac = s.phase.startsWith('passive') ? 0.25 : 0.75;
  return Math.max(0, (v.rounds - s.round + turnFrac) / v.rounds);
}

function effectEV(e: Effect, w: Weights): number {
  switch (e.t) {
    case 'fox':
      return w.foxEV;
    case 'reroll':
      return w.reroll;
    case 'plus1':
      return w.plus1;
    case 'crossAny':
    case 'crossNext':
      return w.crossEV;
    case 'writeNext':
      return e.value;
    case 'return':
    case 'free':
    case 'silverMark':
      return 0; // Twice-as-Clever effects: no shaping yet (variant-specific eval is follow-up work)
    case 'choice':
      return Math.max(...e.options.map((o) => effectEV(o, w)));
  }
}

export function evaluate(s: GameState, v: VariantDef, w: Weights): number {
  const br = scoreState(s, v);
  const t = timeLeft(s, v);
  let val = br.total;

  // Unspent actions are worth something only while there is game left.
  val += (s.rerolls * w.reroll + s.plus1 * w.plus1) * t;

  // Foxes will be worth the final min area, not the current one.
  val += s.foxes * Math.max(0, w.foxEV - br.minArea) * t;

  // Dice still available for the remaining picks of this active turn.
  if (s.phase === 'roll' || s.phase === 'pick') {
    const picksLeft = Math.max(0, v.picksPerTurn - s.picks);
    if (picksLeft > 0) {
      const pool = s.loc.filter((l) => l === 'pool').length;
      val += Math.min(pool, picksLeft * 2) * w.poolDieEV * (picksLeft / v.picksPerTurn);
    }
  }

  for (const area of v.areas) {
    const cells = s.areas[area.id];

    // Partial progress toward row/column/diagonal bonuses and points.
    const groups = area.ui.groups;
    if (groups) {
      for (const g of groups) {
        const done = g.cells.filter((c) => cells[c] !== 0).length;
        if (done === g.cells.length) continue;
        const frac = done / g.cells.length;
        const ev = g.points ?? (g.bonus ? effectEV(g.bonus, w) : 0);
        val += ev * frac * frac * w.groupPotential * t;
      }
    }

    // Amortized-slope shaping for convex tables (see Weights doc).
    if (area.id === 'blue') {
      val += cells.reduce((a, b) => a + b, 0) * w.blueShaping * t;
    } else if (area.id === 'green') {
      val += cells.reduce((a, b) => a + b, 0) * w.greenShaping * t;
    }

    // Opportunity cost of write-track slots: an empty slot has expected
    // future value, so filling one with a low number is penalized naturally.
    if (area.id === 'purple') {
      const remaining = cells.filter((c) => c === 0).length;
      val += remaining * w.purpleSlotEV * t;
    } else if (area.id === 'orange') {
      for (let i = 0; i < cells.length; i++) {
        if (cells[i] === 0) val += area.ui.cells[i].label === null ? w.orangeSlotEVPerMult * t : 0;
      }
      // multiplier slots (×2/×3) carry proportionally more potential
      for (let i = 0; i < cells.length; i++) {
        const lbl = area.ui.cells[i].label;
        if (cells[i] === 0 && lbl !== null) {
          const mult = Number(lbl.replace('×', '')) || 1;
          val += mult * w.orangeSlotEVPerMult * t;
        }
      }
    }
  }
  return val;
}

/** Resolve queued bonus decisions greedily (one-step eval per decision). */
export function resolvePendingGreedy(s: GameState, v: VariantDef, w: Weights): GameState {
  let cur = s;
  let guard = 0;
  while (cur.pending.length > 0 && guard++ < 64) {
    const node = getPending(cur, v);
    if (node.kind !== 'decision') break;
    let best: GameState | null = null;
    let bestVal = -Infinity;
    for (const a of node.actions) {
      const ns = applyAction(cur, v, a);
      const val = evaluate(ns, v, w);
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

export function makeGreedy(weights: Partial<Weights> = {}, name = 'greedy'): Strategy {
  const w: Weights = { ...defaultWeights, ...weights };
  return {
    name,
    choose(state, actions, ctx) {
      const v = ctx.variant;
      let best = actions[0];
      let bestVal = -Infinity;
      for (const a of actions) {
        if (a.t === 'reroll') continue; // handled by threshold below
        const ns = resolvePendingGreedy(applyAction(state, v, a), v, w);
        const val = evaluate(ns, v, w);
        if (val > bestVal) {
          bestVal = val;
          best = a;
        }
      }
      // Myopic eval can never like a reroll (it just spends a resource), so
      // use it when the best available pick gains too little.
      const canReroll = actions.some((a) => a.t === 'reroll');
      if (canReroll && bestVal - evaluate(state, v, w) < w.rerollGainThreshold) {
        return { t: 'reroll' };
      }
      return best;
    },
  };
}
