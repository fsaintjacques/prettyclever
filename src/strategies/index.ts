import { makeGreedy } from './greedy';
import { makeMonteCarlo } from './montecarlo';
import { makeRandom } from './random';
import type { Strategy } from './types';

export * from './types';
export * from './random';
export * from './greedy';
export * from './montecarlo';

export type StrategyFactory = (opts?: Record<string, unknown>) => Strategy;

/** Registry used by the CLI and the UI. Add experimental strategies here. */
export const strategyRegistry: Record<string, StrategyFactory> = {
  random: () => makeRandom(),
  greedy: (opts) => makeGreedy(opts as never),
  mc: (opts) => makeMonteCarlo({ rollouts: 24, policy: 'random', ...opts }),
  'mc-greedy': (opts) => makeMonteCarlo({ rollouts: 8, policy: 'greedy', maxActions: 8, ...opts }),
};

export function makeStrategy(name: string, opts?: Record<string, unknown>): Strategy {
  const f = strategyRegistry[name];
  if (!f) {
    throw new Error(`unknown strategy '${name}' (available: ${Object.keys(strategyRegistry).join(', ')})`);
  }
  return f(opts);
}
