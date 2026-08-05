import { makeExpectimax } from './expectimax';
import { makeGreedy } from './greedy';
import { makeMcts } from './mcts';
import { makeMonteCarlo } from './montecarlo';
import { makePlanner, type PlannerOpts } from './planner';
import { makeRandom } from './random';
import { makeTdNet, makeTdNetEval } from './tdnet';
import { makeTdNetV2 } from './tdnetv2';
import { TUNED_WEIGHTS } from './tuned';
import type { Strategy } from './types';

export * from './types';
export * from './random';
export * from './greedy';
export * from './montecarlo';
export * from './tuned';
export * from './expectimax';
export * from './mcts';
export * from './planner';
export * from './tdnet';
export * from './tdnetv2';

/**
 * Joint CEM over planner knobs + base eval weights (scripts/optimize-planner.ts,
 * 14 gens, pop 32, 400 paired games per candidate). Held-out mean 169.7
 * (seeds 777 & 424242, 1000 games each) vs 157.0 for default planner and
 * 165.7 for greedy-tuned on the same paired seeds.
 */
const PLANNER_TUNED: Partial<PlannerOpts> = {
  weights: {
    reroll: 3.019, foxEV: 5.014, groupPotential: 0.047, crossEV: 4.608,
    purpleSlotEV: 0.09, orangeSlotEVPerMult: 0.935, blueShaping: 7.188,
    greenShaping: 4.165, poolDieEV: 9.811,
  },
  purpleBarW: 0.036, purpleSixBonus: 7.014, orangeMultW: 0.045, earlyShaping: 1.401,
  plus1Early: 14.21, plus1Mid: 8.743, plus1Late: 7.553,
  rerollBase: 2.37, rerollPerDie: 0.388, rerollLate: 1.456,
  yellowShapeW: 0.015, poolScale: 0.947, wildBonus: 1.534,
};

export type StrategyFactory = (opts?: Record<string, unknown>) => Strategy;

/** Registry used by the CLI and the UI. Add experimental strategies here. */
export const strategyRegistry: Record<string, StrategyFactory> = {
  random: () => makeRandom(),
  greedy: (opts) => makeGreedy(opts as never),
  // CEM-optimized weights (scripts/optimize.ts); held-out mean 166.4 ± 35.5
  // (seed 777, 1500 games) vs 139.5 for default greedy on the same seeds.
  'greedy-tuned': (opts) => makeGreedy({ ...TUNED_WEIGHTS, ...opts }, 'greedy-tuned'),
  planner: (opts) => makePlanner(opts as never),
  'planner-tuned': (opts) => makePlanner({ ...PLANNER_TUNED, ...opts }, 'planner-tuned'),
  mc: (opts) => makeMonteCarlo({ rollouts: 24, policy: 'random', ...opts }),
  'mc-greedy': (opts) => makeMonteCarlo({ rollouts: 8, policy: 'greedy', maxActions: 8, ...opts }),
  expectimax: (opts) => makeExpectimax(opts as never),
  // Tuned eval transfers cleanly to search: 183.8 ± 35.2 (seed 11, 100 games)
  // vs 165.1 for expectimax on default weights.
  'expectimax-tuned': (opts) => makeExpectimax({ weights: TUNED_WEIGHTS, ...opts }),
  mcts: (opts) => makeMcts(opts as never),
  // TD(λ) self-play value network (scripts/train-td.ts), pure afterstate argmax.
  // 60k episodes: 242.6 ± 23.2 (seed 11) / 239.9 ± 23.6 (seed 777), 1000 games each.
  'td-net': (opts) => makeTdNet(opts as never),
  // v1 features + phase-gated die-face block (scripts/train-td-v2.ts); see tdnetv2.ts.
  'td-net-v2': (opts) => makeTdNetV2(opts as never),
  // Expectimax searching over the tuned eval's pruning with the TD net as leaf value.
  // With the 60k-episode net, depth-3 search no longer beats raw td-net (within noise).
  'expectimax-net': (opts) => makeExpectimax({ weights: TUNED_WEIGHTS, evalFn: makeTdNetEval(), ...opts }),
};

export function makeStrategy(name: string, opts?: Record<string, unknown>): Strategy {
  const f = strategyRegistry[name];
  if (!f) {
    throw new Error(`unknown strategy '${name}' (available: ${Object.keys(strategyRegistry).join(', ')})`);
  }
  return f(opts);
}
