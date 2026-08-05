import {
  applyActionMut,
  getPending,
  mulberry32,
  newGame,
  resolveChanceMut,
  scoreState,
  type GameState,
  type ScoreBreakdown,
  type VariantDef,
} from '../engine';
import type { Strategy } from '../strategies';

export interface GameResult {
  seed: number;
  score: ScoreBreakdown;
  state: GameState;
  decisions: number;
  /** Marks made with an actual die (picks, +1s, passive picks — not bonuses), as [dieIndex][face-1] counts. */
  diceUsed: number[][];
}

/** Play one seeded game to completion. */
export function playGame(v: VariantDef, strategy: Strategy, seed: number): GameResult {
  const rng = mulberry32(seed);
  const s = newGame(v);
  const ctx = { variant: v, rng };
  const diceUsed = v.colors.map(() => Array(6).fill(0) as number[]);
  let decisions = 0;
  let guard = 0;
  for (;;) {
    if (guard++ > 100000) throw new Error('game did not terminate');
    const node = getPending(s, v);
    if (node.kind === 'over') break;
    if (node.kind === 'chance') {
      resolveChanceMut(s, v, rng);
      continue;
    }
    const a = strategy.choose(s, node.actions, ctx);
    if (
      (a.t === 'pick' && a.placement) ||
      a.t === 'plus1' ||
      a.t === 'passivePick'
    ) {
      diceUsed[a.die][s.faces[a.die] - 1]++;
    }
    applyActionMut(s, v, a);
    decisions++;
  }
  return { seed, score: scoreState(s, v), state: s, decisions, diceUsed };
}

export interface SimOptions {
  games: number;
  seed: number;
  onGame?: (result: GameResult, index: number) => void;
}

export function simulate(v: VariantDef, strategy: Strategy, opts: SimOptions): GameResult[] {
  const results: GameResult[] = [];
  for (let i = 0; i < opts.games; i++) {
    const r = playGame(v, strategy, (opts.seed + i * 2654435761) >>> 0);
    results.push(r);
    opts.onGame?.(r, i);
  }
  return results;
}
