/**
 * Weights found by the cross-entropy optimizer in scripts/optimize.ts
 * (16 generations, pop 26, 300 paired games per candidate, rotating tuning
 * seed sets starting at 101).
 *
 * Held-out confirmation (seeds never used during tuning), vs defaultWeights
 * on the same paired seeds:
 *   seed 777,    1500 games: 166.4 ± 35.5   (default 139.5 ± 24.5)
 *   seed 999,    1000 games: 166.6 ± 34.1   (default 140.3 ± 25.2)
 *   seed 424242, 1000 games: 164.8 ± 34.4   (default 138.6 ± 25.0)
 *
 * Notable shifts from the defaults: foxEV and purpleSlotEV shrink a lot
 * (foxes and purple slot hoarding were over-valued), groupPotential nearly
 * vanishes, while blueShaping, poolDieEV and a higher reroll threshold do
 * the heavy lifting.
 */
import type { Weights } from './greedy';

export const TUNED_WEIGHTS: Weights = {
  reroll: 2.927,
  plus1: 6.322,
  foxEV: 5.326,
  groupPotential: 0.027,
  crossEV: 7.808,
  purpleSlotEV: 0.27,
  orangeSlotEVPerMult: 1.09,
  blueShaping: 7.093,
  greenShaping: 3.313,
  poolDieEV: 9.486,
  rerollGainThreshold: 8.004,
};
