/**
 * Weight-tuning harness for the greedy evaluation function.
 *
 *   npx tsx scripts/tune.ts [--games 400] [--seed 11]
 *
 * Edit the `grid` below to compare weight sets. Same seeds are used for every
 * candidate, so differences are paired (lower variance comparisons).
 */
import { standard } from '../src/engine';
import { makeGreedy, type Weights } from '../src/strategies';
import { simulate } from '../src/sim/runner';
import { computeStats } from '../src/sim/stats';

const games = Number(process.argv.find((a) => a.startsWith('--games'))?.split('=')[1] ?? 400);
const seed = Number(process.argv.find((a) => a.startsWith('--seed'))?.split('=')[1] ?? 11);

const grid: { name: string; w: Partial<Weights> }[] = [
  { name: 'base', w: {} },
  { name: 'A', w: { groupPotential: 1.3, blueShaping: 4, greenShaping: 4.5 } },
  { name: 'B', w: { groupPotential: 1.3, blueShaping: 4, greenShaping: 4.5, foxEV: 20, crossEV: 9 } },
  { name: 'C', w: { groupPotential: 1.6, blueShaping: 4.5, greenShaping: 5, foxEV: 20, crossEV: 9, plus1: 11, rerollGainThreshold: 5 } },
  { name: 'D', w: { groupPotential: 1.6, blueShaping: 4.5, greenShaping: 5, foxEV: 22, crossEV: 10, plus1: 11, purpleSlotEV: 5, rerollGainThreshold: 6 } },
  { name: 'E', w: { groupPotential: 2.0, blueShaping: 5, greenShaping: 5.5, foxEV: 22, crossEV: 10, plus1: 12, purpleSlotEV: 5, rerollGainThreshold: 6 } },
];

for (const g of grid) {
  const st = computeStats(standard, simulate(standard, makeGreedy(g.w), { games, seed }));
  const areas = Object.entries(st.meanAreas)
    .map(([k, x]) => `${k.slice(0, 2)} ${x.toFixed(0).padStart(2)}`)
    .join('  ');
  console.log(
    `${g.name.padEnd(5)} mean ${st.mean.toFixed(1)} ± ${st.std.toFixed(1)}  p50 ${st.p50}  p90 ${st.p90}  | ${areas} | fox ${st.meanFoxes.toFixed(1)}`,
  );
}
