/**
 * "bonusman" — chases printed bonuses instead of points.
 *
 * Where greedy values the score plus generic potential, bonusman's evaluation
 * is a bonus economy: banked action-bar unlocks and foxes count most, partial
 * progress toward every still-open bonus group counts convexly (finishing a
 * row beats spreading crosses around), and write tracks feel a "pull" toward
 * their next bonus-carrying slot. Points enter only as a small tiebreaker.
 *
 * Cascades fall out of the one-step lookahead: queued effects are resolved
 * (greedily, under this same evaluation) before an afterstate is scored, so a
 * pick whose bonus cross completes another group — which fires another bonus —
 * is credited for the whole chain, and crossAny resolutions steer into the
 * cells that keep the chain going.
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

export interface BonusmanWeights {
  /** Each cumulative action-bar unlock already banked (reroll/+1/return). */
  banked: number;
  /** Each fox earned. */
  fox: number;
  /** Multiplier on convex (frac²) progress toward unearned group bonuses. */
  progress: number;
  /** Pull toward the next bonus-carrying slot of a write track (decays with distance). */
  trackPull: number;
  /** EVs of the bonus kinds when weighing unearned bonuses. */
  crossEV: number;
  freeEV: number;
  rerollEV: number;
  plus1EV: number;
  returnEV: number;
  /** Holding value of unspent actions (scaled by time left). */
  holdReroll: number;
  holdPlus1: number;
  holdReturn: number;
  /** Option value of dice still in the pool during the active turn. */
  poolDieEV: number;
  /** Weight on the raw score — a tiebreaker, not the objective. */
  points: number;
  /** Reroll instead of picking when the best pick gains less than this. */
  rerollGainThreshold: number;
}

export const defaultBonusmanWeights: BonusmanWeights = {
  banked: 9,
  fox: 12,
  progress: 0.9,
  trackPull: 0.5,
  crossEV: 8,
  freeEV: 6,
  rerollEV: 6,
  plus1EV: 10,
  returnEV: 6,
  holdReroll: 3,
  holdPlus1: 8,
  holdReturn: 4,
  poolDieEV: 4,
  points: 0.35,
  rerollGainThreshold: 5,
};

/** Fraction of the game remaining, in [0, 1]. */
function timeLeft(s: GameState, v: VariantDef): number {
  const turnFrac = s.phase.startsWith('passive') ? 0.25 : 0.75;
  return Math.max(0, (v.rounds - s.round + turnFrac) / v.rounds);
}

/** What an unearned bonus is worth to a bonus chaser. */
function bonusEV(e: Effect, w: BonusmanWeights): number {
  switch (e.t) {
    case 'fox':
      return w.fox;
    case 'reroll':
      return w.rerollEV;
    case 'plus1':
      return w.plus1EV;
    case 'return':
      return w.returnEV;
    case 'crossAny':
    case 'crossNext':
      return w.crossEV;
    case 'free':
    case 'silverMark':
      return w.freeEV;
    case 'writeNext':
      return e.value * w.points; // a written number is points, not a bonus
    case 'choice':
      return Math.max(...e.options.map((o) => bonusEV(o, w)));
  }
}

export function evaluateBonusman(s: GameState, v: VariantDef, w: BonusmanWeights): number {
  const br = scoreState(s, v);
  const t = timeLeft(s, v);
  let val = br.total * w.points;

  // The objective: bonuses already banked...
  val += (s.barUnlocks.reroll + s.barUnlocks.plus1 + s.barUnlocks.return) * w.banked;
  val += s.foxes * w.fox;

  // ...plus unlocked actions still in hand (worth something while game remains).
  val += (s.rerolls * w.holdReroll + s.plus1 * w.holdPlus1 + s.returns * w.holdReturn) * t;

  // Option value of dice still available for the remaining picks of the turn
  // (picking a high die throws every lower die on the platter).
  if (s.phase === 'roll' || s.phase === 'pick') {
    const picksLeft = Math.max(0, v.picksPerTurn - s.picks);
    if (picksLeft > 0) {
      const pool = s.loc.filter((l) => l === 'pool').length;
      val += Math.min(pool, picksLeft * 2) * w.poolDieEV * (picksLeft / v.picksPerTurn);
    }
  }

  for (const area of v.areas) {
    const cells = s.areas[area.id];
    const ui = area.ui;

    // Convex progress toward every still-open group bonus: two crosses in one
    // row beat one cross in each of two rows. Points-only groups are ignored —
    // that's greedy's job.
    if (ui.groups) {
      for (const g of ui.groups) {
        if (!g.bonus) continue;
        const done = g.cells.filter((c) => cells[c] !== 0).length;
        if (done === g.cells.length) continue; // fired — already banked above
        const frac = done / g.cells.length;
        val += bonusEV(g.bonus, w) * frac * frac * w.progress * t;
      }
    }

    // Write tracks fill left to right: feel a pull toward the next
    // bonus-carrying slots, decaying with how many fills away they are.
    if (ui.kind === 'track') {
      const next = cells.findIndex((c) => c === 0);
      if (next >= 0) {
        for (let i = next; i < ui.cells.length; i++) {
          const b = ui.cells[i].bonus;
          if (!b) continue;
          val += (bonusEV(b, w) * w.trackPull * t) / (1 + (i - next));
        }
      }
    }
  }
  return val;
}

/** Resolve queued bonus decisions greedily under the bonusman evaluation. */
function resolvePending(s: GameState, v: VariantDef, w: BonusmanWeights): GameState {
  let cur = s;
  let guard = 0;
  while (cur.pending.length > 0 && guard++ < 64) {
    const node = getPending(cur, v);
    if (node.kind !== 'decision') break;
    let best: GameState | null = null;
    let bestVal = -Infinity;
    for (const a of node.actions) {
      const ns = applyAction(cur, v, a);
      const val = evaluateBonusman(ns, v, w);
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

export function makeBonusman(weights: Partial<BonusmanWeights> = {}): Strategy {
  const w: BonusmanWeights = { ...defaultBonusmanWeights, ...weights };
  return {
    name: 'bonusman',
    choose(state, actions, ctx) {
      const v = ctx.variant;
      let best = actions[0];
      let bestVal = -Infinity;
      for (const a of actions) {
        if (a.t === 'reroll') continue; // handled by threshold below
        const ns = resolvePending(applyAction(state, v, a), v, w);
        const val = evaluateBonusman(ns, v, w);
        if (val > bestVal) {
          bestVal = val;
          best = a;
        }
      }
      // A myopic eval never likes spending the reroll itself; take it when the
      // best pick advances the bonus economy too little.
      const canReroll = actions.some((a) => a.t === 'reroll');
      if (canReroll && bestVal - evaluateBonusman(state, v, w) < w.rerollGainThreshold) {
        return { t: 'reroll' };
      }
      return best;
    },
  };
}
