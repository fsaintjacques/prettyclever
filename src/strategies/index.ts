import { makeExpectimax } from './expectimax';
import { makeGreedy } from './greedy';
import { makeMcts } from './mcts';
import { makeMonteCarlo } from './montecarlo';
import { makePlanner, type PlannerOpts } from './planner';
import { makeRandom } from './random';
import { makeTdNet, makeTdNetEval } from './tdnet';
import { makeTdNetTwice } from './tdnet-twice';
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
export * from './tdnet-twice';
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

/** Variant-agnostic algorithms — they read everything they need from VariantDef. */
const globalStrategies: Record<string, StrategyFactory> = {
  random: () => makeRandom(),
  greedy: (opts) => makeGreedy(opts as never),
  planner: (opts) => makePlanner(opts as never),
  mc: (opts) => makeMonteCarlo({ rollouts: 24, policy: 'random', ...opts }),
  'mc-greedy': (opts) => makeMonteCarlo({ rollouts: 8, policy: 'greedy', maxActions: 8, ...opts }),
  expectimax: (opts) => makeExpectimax(opts as never),
  mcts: (opts) => makeMcts(opts as never),
};

/**
 * Tuned/learned strategies, keyed by the variant their weights or feature
 * extraction were trained on. A future variant registers its own block here.
 */
const variantStrategies: Record<string, Record<string, StrategyFactory>> = {
  'thats-pretty-clever': {
    // CEM-optimized weights (scripts/optimize.ts); held-out mean 166.4 ± 35.5
    // (seed 777, 1500 games) vs 139.5 for default greedy on the same seeds.
    'greedy-tuned': (opts) => makeGreedy({ ...TUNED_WEIGHTS, ...opts }, 'greedy-tuned'),
    'planner-tuned': (opts) => makePlanner({ ...PLANNER_TUNED, ...opts }, 'planner-tuned'),
    // Tuned eval transfers cleanly to search: 183.8 ± 35.2 (seed 11, 100 games)
    // vs 165.1 for expectimax on default weights.
    'expectimax-tuned': (opts) => makeExpectimax({ weights: TUNED_WEIGHTS, ...opts }),
    // TD(λ) self-play value network (scripts/train-td.ts), pure afterstate argmax.
    // 240k episodes: 250.7 ± 22.5 (seed 11) / 250.1 ± 23.7 (seed 777), 1000 games each.
    'td-net': (opts) => makeTdNet(opts as never),
    // v1 features + phase-gated die-face block (scripts/train-td-v2.ts).
    // At an equal 240k-episode budget: 249.7 ± 22.4 / 249.9 ± 23.8 (seeds 11/777)
    // vs v1's 250.7 / 250.1 — the face features are a wash at this width.
    'td-net-v2': (opts) => makeTdNetV2(opts as never),
    // Expectimax searching over the tuned eval's pruning with the TD net as leaf value.
    // With the 60k-episode net, depth-3 search no longer beats raw td-net (within noise).
    'expectimax-net': (opts) => makeExpectimax({ weights: TUNED_WEIGHTS, evalFn: makeTdNetEval(), ...opts }),
  },
  'twice-as-clever': {
    // TD(λ) self-play value network (scripts/train-td-parallel.ts --features twice),
    // pure afterstate argmax over the twice-specific face-blind features.
    // Trained with the yellow-cap curriculum (--cap-yellow 8) + fox spotlight,
    // which escaped the yellow-max local optimum into the fox-economy regime:
    // 296.5 ± 35.9 (seed 11) / 296.2 ± 35.3 (seed 777), 500 games each.
    'td-net': (opts) => makeTdNetTwice(opts as never),
  },
};

/** Merged view for the CLI and UI: global algorithms + this variant's tuned entries. */
export function strategiesFor(variantId: string): Record<string, StrategyFactory> {
  return { ...globalStrategies, ...variantStrategies[variantId] };
}

export function makeStrategy(variantId: string, name: string, opts?: Record<string, unknown>): Strategy {
  const reg = strategiesFor(variantId);
  const f = reg[name];
  if (!f) {
    throw new Error(
      `unknown strategy '${name}' for variant '${variantId}' (available: ${Object.keys(reg).join(', ')})`,
    );
  }
  return f(opts);
}
