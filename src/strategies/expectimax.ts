/**
 * Depth-limited expectimax over the explicit decision process.
 *
 * Decision nodes maximize over candidate actions (pruned to the most
 * promising ones by the greedy evaluation); chance nodes average over a small
 * number of sampled rolls (common random numbers across sibling branches to
 * reduce comparison variance). Leaves are scored with the greedy `evaluate`.
 *
 * Depth is measured in *non-bonus* decision plies: pending-bonus resolutions
 * (crossAny cells, black-choice options) are searched like any other decision
 * but do not consume depth, so a bonus cascade cannot eat the horizon.
 *
 * Unlike greedy, rerolls need no special threshold: applying a reroll leads
 * to a chance node whose sampled continuations value it directly. Reroll
 * candidates are always kept through pruning for the same reason MC keeps
 * them — the one-step eval can never rank a pure resource spend highly.
 */
import {
  applyActionMut,
  cloneState,
  getPending,
  mulberry32,
  resolveChanceMut,
  scoreState,
  type Action,
  type GameState,
  type RNG,
} from '../engine';
import { defaultWeights, evaluate, type Weights } from './greedy';
import type { Strategy } from './types';

export interface ExpectimaxOpts {
  /** Search horizon in decision plies (bonus resolutions are free). */
  depth: number;
  /** Sampled rolls per chance node (K). */
  chanceSamples: number;
  /** Candidate actions kept at the root, ranked by greedy eval. */
  rootActions: number;
  /** Candidate actions kept at deeper decision nodes. */
  maxActions: number;
  weights: Partial<Weights>;
}

const defaults: ExpectimaxOpts = {
  depth: 3,
  chanceSamples: 3,
  rootActions: 8,
  maxActions: 4,
  weights: {},
};

interface Child {
  a: Action;
  s: GameState;
  val: number;
}

export function makeExpectimax(opts: Partial<ExpectimaxOpts> = {}): Strategy {
  const o = { ...defaults, ...opts };
  const w: Weights = { ...defaultWeights, ...o.weights };

  return {
    name: `expectimax-d${o.depth}-k${o.chanceSamples}-m${o.maxActions}`,
    choose(state, actions, ctx) {
      if (actions.length === 1) return actions[0];
      const v = ctx.variant;
      // One deterministic base seed per call; chance samples derive from it
      // by (depth, sample index) so sibling branches share the same rolls.
      const baseSeed = Math.floor(ctx.rng() * 0xffffffff) >>> 0;

      const sampleRng = (depthLeft: number, k: number): RNG =>
        mulberry32(
          (baseSeed ^ Math.imul(k + 1, 0x9e3779b9) ^ Math.imul(depthLeft + 1, 0x85ebca6b)) >>> 0,
        );

      function expand(s: GameState, acts: Action[], keep: number): Child[] {
        const kids: Child[] = [];
        for (const a of acts) {
          const ns = cloneState(s);
          applyActionMut(ns, v, a);
          // Rank only when we actually have to prune; rerolls always survive.
          const val =
            acts.length <= keep ? 0 : a.t === 'reroll' ? Infinity : evaluate(ns, v, w);
          kids.push({ a, s: ns, val });
        }
        if (kids.length > keep) {
          kids.sort((x, y) => y.val - x.val);
          kids.length = keep;
        }
        return kids;
      }

      function search(s: GameState, depthLeft: number): number {
        const node = getPending(s, v);
        if (node.kind === 'over') return scoreState(s, v).total;
        if (node.kind === 'chance') {
          if (depthLeft <= 0) return evaluate(s, v, w);
          let sum = 0;
          for (let k = 0; k < o.chanceSamples; k++) {
            const ns = cloneState(s);
            resolveChanceMut(ns, v, sampleRng(depthLeft, k));
            sum += search(ns, depthLeft);
          }
          return sum / o.chanceSamples;
        }
        const isBonus = s.pending.length > 0;
        if (!isBonus && depthLeft <= 0) return evaluate(s, v, w);
        const nextDepth = isBonus ? depthLeft : depthLeft - 1;
        let best = -Infinity;
        for (const kid of expand(s, node.actions, o.maxActions)) {
          const val = search(kid.s, nextDepth);
          if (val > best) best = val;
        }
        return best;
      }

      const rootIsBonus = state.pending.length > 0;
      const nextDepth = rootIsBonus ? o.depth : o.depth - 1;
      const kids = expand(state, actions, o.rootActions);
      let best = kids[0];
      let bestVal = -Infinity;
      for (const kid of kids) {
        const val = search(kid.s, nextDepth);
        if (val > bestVal) {
          bestVal = val;
          best = kid;
        }
      }
      return best.a;
    },
  };
}
