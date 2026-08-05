/// <reference lib="webworker" />
import { getVariant } from '../engine';
import { makeStrategy } from '../strategies';
import { playGame } from '../sim/runner';
import { computeStats, type SimStats } from '../sim/stats';
import type { GameResult } from '../sim/runner';

export interface SimRequest {
  id: number;
  variantId: string;
  strategy: string;
  games: number;
  seed: number;
}

export type SimResponse =
  | { id: number; type: 'progress'; done: number }
  | { id: number; type: 'done'; stats: SimStats; ms: number }
  | { id: number; type: 'error'; message: string };

self.onmessage = (e: MessageEvent<SimRequest>) => {
  const { id, variantId, strategy: strategyName, games, seed } = e.data;
  try {
    const v = getVariant(variantId);
    const strategy = makeStrategy(strategyName);
    const results: GameResult[] = [];
    const t0 = performance.now();
    let lastPost = t0;
    for (let i = 0; i < games; i++) {
      results.push(playGame(v, strategy, (seed + i * 2654435761) >>> 0));
      const now = performance.now();
      if (now - lastPost > 150) {
        lastPost = now;
        (self as unknown as Worker).postMessage({ id, type: 'progress', done: i + 1 });
      }
    }
    const stats = computeStats(v, results);
    (self as unknown as Worker).postMessage({
      id,
      type: 'done',
      stats,
      ms: performance.now() - t0,
    });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, type: 'error', message: String(err) });
  }
};
