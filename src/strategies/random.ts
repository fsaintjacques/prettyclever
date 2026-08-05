import type { Strategy } from './types';

/** Uniform random over legal actions. The floor baseline. */
export function makeRandom(): Strategy {
  return {
    name: 'random',
    choose(_state, actions, ctx) {
      return actions[Math.floor(ctx.rng() * actions.length)];
    },
  };
}
