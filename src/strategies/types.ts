import type { Action, GameState, VariantDef } from '../engine';
import type { RNG } from '../engine';

export interface StrategyCtx {
  variant: VariantDef;
  /** RNG for the strategy's own randomness (rollouts, tie-breaks). */
  rng: RNG;
}

/**
 * A strategy picks one of the legal actions at every decision node.
 * `state` must be treated as read-only; use engine.applyAction (pure) or
 * cloneState + *Mut functions to look ahead.
 */
export interface Strategy {
  name: string;
  choose(state: GameState, actions: Action[], ctx: StrategyCtx): Action;
}
