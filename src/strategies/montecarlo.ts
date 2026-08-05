/**
 * Flat Monte-Carlo: for each candidate action, complete the game many times
 * with a fast rollout policy and pick the action with the best mean score.
 *
 * Much slower than greedy but sees the value of rerolls, platter effects and
 * long-term slot economy. Use `policy: 'greedy'` for stronger (and much
 * slower) rollouts.
 */
import {
  applyActionMut,
  cloneState,
  getPending,
  mulberry32,
  forkSeed,
  resolveChanceMut,
  scoreState,
  applyAction,
  type GameState,
} from '../engine';
import { defaultWeights, evaluate, makeGreedy, resolvePendingGreedy, type Weights } from './greedy';
import type { Strategy, StrategyCtx } from './types';

export interface MonteCarloOpts {
  rollouts: number;
  /** Rollout policy: cheap uniform-random or the greedy strategy. */
  policy: 'random' | 'greedy';
  /** Evaluate at most this many candidate actions (pre-ranked by greedy eval). */
  maxActions: number;
  weights: Partial<Weights>;
}

const defaults: MonteCarloOpts = { rollouts: 24, policy: 'random', maxActions: 12, weights: {} };

export function makeMonteCarlo(opts: Partial<MonteCarloOpts> = {}): Strategy {
  const o = { ...defaults, ...opts };
  const w = { ...defaultWeights, ...o.weights };
  const greedy = makeGreedy(o.weights, 'rollout-greedy');
  const name = `mc-${o.policy}-${o.rollouts}`;

  function rollout(start: GameState, ctx: StrategyCtx): number {
    const v = ctx.variant;
    const rng = mulberry32(forkSeed(ctx.rng));
    const s = cloneState(start);
    let guard = 0;
    while (guard++ < 5000) {
      const node = getPending(s, v);
      if (node.kind === 'over') break;
      if (node.kind === 'chance') {
        resolveChanceMut(s, v, rng);
        continue;
      }
      const actions = node.actions;
      const a =
        o.policy === 'random'
          ? actions[Math.floor(rng() * actions.length)]
          : greedy.choose(s, actions, { variant: v, rng });
      applyActionMut(s, v, a);
    }
    return scoreState(s, v).total;
  }

  return {
    name,
    choose(state, actions, ctx) {
      if (actions.length === 1) return actions[0];
      const v = ctx.variant;

      // Rank candidates by greedy eval and keep the most promising ones.
      const ranked = actions
        .map((a) => {
          if (a.t === 'reroll') return { a, val: Infinity }; // always worth sampling
          const ns = resolvePendingGreedy(applyAction(state, v, a), v, w);
          return { a, val: evaluate(ns, v, w) };
        })
        .sort((x, y) => y.val - x.val)
        .slice(0, o.maxActions);

      let best = ranked[0].a;
      let bestMean = -Infinity;
      for (const { a } of ranked) {
        const ns = applyAction(state, v, a);
        let sum = 0;
        for (let k = 0; k < o.rollouts; k++) sum += rollout(ns, ctx);
        const mean = sum / o.rollouts;
        if (mean > bestMean) {
          bestMean = mean;
          best = a;
        }
      }
      return best;
    },
  };
}
