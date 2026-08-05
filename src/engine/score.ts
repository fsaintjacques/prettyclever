import type { GameState, VariantDef } from './types';

export interface ScoreBreakdown {
  areas: Record<string, number>;
  minArea: number;
  foxCount: number;
  foxPoints: number;
  total: number;
}

export function scoreState(s: GameState, v: VariantDef): ScoreBreakdown {
  const areas: Record<string, number> = {};
  let sum = 0;
  let min = Infinity;
  for (const a of v.areas) {
    const pts = a.score(s.areas[a.id]);
    areas[a.id] = pts;
    sum += pts;
    if (pts < min) min = pts;
  }
  const foxPoints = s.foxes * min;
  return { areas, minArea: min, foxCount: s.foxes, foxPoints, total: sum + foxPoints };
}

export function rating(v: VariantDef, score: number): string {
  for (const r of v.rating) if (score >= r.min) return r.label;
  return '';
}
