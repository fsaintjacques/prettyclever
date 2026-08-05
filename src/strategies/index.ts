import { makeExpectimax } from './expectimax';
import { makeGreedy } from './greedy';
import { makeMonteCarlo } from './montecarlo';
import { makeRandom } from './random';
import { TUNED_WEIGHTS } from './tuned';
import type { Strategy } from './types';

export * from './types';
export * from './random';
export * from './greedy';
export * from './montecarlo';
export * from './tuned';
export * from './expectimax';

export type StrategyFactory = (opts?: Record<string, unknown>) => Strategy;

/** Registry used by the CLI and the UI. Add experimental strategies here. */
export const strategyRegistry: Record<string, StrategyFactory> = {
  random: () => makeRandom(),
  greedy: (opts) => makeGreedy(opts as never),
  // CEM-optimized weights (scripts/optimize.ts); held-out mean 166.4 ± 35.5
  // (seed 777, 1500 games) vs 139.5 for default greedy on the same seeds.
  'greedy-tuned': (opts) => makeGreedy({ ...TUNED_WEIGHTS, ...opts }, 'greedy-tuned'),
  mc: (opts) => makeMonteCarlo({ rollouts: 24, policy: 'random', ...opts }),
  'mc-greedy': (opts) => makeMonteCarlo({ rollouts: 8, policy: 'greedy', maxActions: 8, ...opts }),
  expectimax: (opts) => makeExpectimax(opts as never),
};

export function makeStrategy(name: string, opts?: Record<string, unknown>): Strategy {
  const f = strategyRegistry[name];
  if (!f) {
    throw new Error(`unknown strategy '${name}' (available: ${Object.keys(strategyRegistry).join(', ')})`);
  }
  return f(opts);
}
