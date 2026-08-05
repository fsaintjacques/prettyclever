import type { VariantDef } from '../engine';
import { rating } from '../engine';
import type { GameResult } from './runner';

export interface SimStats {
  games: number;
  mean: number;
  std: number;
  min: number;
  max: number;
  p10: number;
  p50: number;
  p90: number;
  /** Histogram in buckets of 20 points: bucketStart → count. */
  histogram: { start: number; count: number }[];
  /** Mean points per area + foxes. */
  meanAreas: Record<string, number>;
  meanFoxes: number;
  meanFoxPoints: number;
  ratingCounts: { label: string; count: number }[];
}

export function computeStats(v: VariantDef, results: GameResult[]): SimStats {
  const scores = results.map((r) => r.score.total).sort((a, b) => a - b);
  const n = scores.length;
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const pct = (p: number) => scores[Math.min(n - 1, Math.floor((p / 100) * n))];

  const bucket = 20;
  const lo = Math.floor(scores[0] / bucket) * bucket;
  const hi = Math.floor(scores[n - 1] / bucket) * bucket;
  const histogram: { start: number; count: number }[] = [];
  for (let b = lo; b <= hi; b += bucket) histogram.push({ start: b, count: 0 });
  for (const sc of scores) histogram[Math.floor((sc - lo) / bucket)].count++;

  const meanAreas: Record<string, number> = {};
  for (const a of v.areas) {
    meanAreas[a.id] = results.reduce((acc, r) => acc + r.score.areas[a.id], 0) / n;
  }

  const ratingCounts = new Map<string, number>();
  for (const r of results) {
    const label = rating(v, r.score.total);
    ratingCounts.set(label, (ratingCounts.get(label) ?? 0) + 1);
  }

  return {
    games: n,
    mean,
    std,
    min: scores[0],
    max: scores[n - 1],
    p10: pct(10),
    p50: pct(50),
    p90: pct(90),
    histogram,
    meanAreas,
    meanFoxes: results.reduce((a, r) => a + r.score.foxCount, 0) / n,
    meanFoxPoints: results.reduce((a, r) => a + r.score.foxPoints, 0) / n,
    ratingCounts: v.rating
      .map((r) => ({ label: r.label, count: ratingCounts.get(r.label) ?? 0 }))
      .filter((r) => r.count > 0),
  };
}
