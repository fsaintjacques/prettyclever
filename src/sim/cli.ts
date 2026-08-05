/**
 * Headless simulation CLI.
 *
 *   npm run sim -- --strategy greedy --games 500 --seed 1
 *   npm run sim -- --strategy random,greedy,mc --games 100     (comparison)
 *   npm run sim -- --strategy greedy --games 1 --verbose        (turn log)
 */
import { getVariant, rating } from '../engine';
import { makeStrategy } from '../strategies';
import { playGame, simulate } from './runner';
import { computeStats } from './stats';

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z-]+)(?:=(.*))?$/i);
    if (!m) continue;
    args[m[1]] = m[2] ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const variant = getVariant(args.variant ?? 'standard');
const games = Number(args.games ?? 200);
const seed = Number(args.seed ?? 1);
const names = (args.strategy ?? 'greedy').split(',');

if (args.verbose === 'true') {
  const strategy = makeStrategy(names[0]);
  const r = playGame(variant, strategy, seed);
  const s = r.state;
  console.log(`seed ${r.seed} — ${strategy.name}`);
  for (const a of variant.areas) {
    console.log(
      `  ${a.label.padEnd(7)} ${String(r.score.areas[a.id]).padStart(3)}  [${s.areas[a.id].join(' ')}]`,
    );
  }
  console.log(`  Foxes   ${String(r.score.foxPoints).padStart(3)}  (${r.score.foxCount} × ${r.score.minArea})`);
  console.log(`  TOTAL   ${String(r.score.total).padStart(3)}  — ${rating(variant, r.score.total)}`);
  console.log(
    `  rerolls used ${s.stats.rerollsUsed}, +1 used ${s.stats.plus1Spent}, skips ${s.stats.skips}, bonuses lost ${s.stats.bonusesLost}`,
  );
  process.exit(0);
}

const fmt = (x: number) => x.toFixed(1).padStart(6);

for (const name of names) {
  const strategy = makeStrategy(name);
  const t0 = performance.now();
  const results = simulate(variant, strategy, { games, seed });
  const dt = performance.now() - t0;
  const st = computeStats(variant, results);

  console.log(`\n=== ${strategy.name} — ${games} games, seed ${seed} (${(dt / 1000).toFixed(1)}s, ${(dt / games).toFixed(1)}ms/game)`);
  console.log(
    `mean ${st.mean.toFixed(1)} ± ${st.std.toFixed(1)}   min ${st.min}  p10 ${st.p10}  median ${st.p50}  p90 ${st.p90}  max ${st.max}`,
  );
  console.log(
    `areas: ${variant.areas.map((a) => `${a.label.toLowerCase()} ${fmt(st.meanAreas[a.id])}`).join(' ')}  foxes ${st.meanFoxes.toFixed(1)} (${st.meanFoxPoints.toFixed(1)} pts)`,
  );
  const maxCount = Math.max(...st.histogram.map((h) => h.count));
  for (const h of st.histogram) {
    const bar = '█'.repeat(Math.max(h.count > 0 ? 1 : 0, Math.round((h.count / maxCount) * 40)));
    console.log(`  ${String(h.start).padStart(4)}–${String(h.start + 19).padEnd(4)} ${bar} ${h.count}`);
  }
  for (const r of st.ratingCounts) {
    console.log(`  ${((100 * r.count) / games).toFixed(1).padStart(5)}%  ${r.label}`);
  }
}
