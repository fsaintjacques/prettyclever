/**
 * Automated weight optimizer for the greedy evaluation function.
 *
 *   npx tsx scripts/optimize.ts [--gens=16] [--pop=26] [--games=300] [--seed=101]
 *                               [--confirm-games=1500] [--confirm-seed=777]
 *
 * Method: cross-entropy method (CEM) over the 11-dimensional `Weights` vector.
 * Why CEM over SPSA / coordinate descent:
 *   - the objective (mean score over N seeded games) is noisy and
 *     non-differentiable; SPSA's two-point gradient estimates are fragile at
 *     this noise level and need careful step-size schedules,
 *   - the weights interact (e.g. foxEV vs groupPotential), which coordinate
 *     descent handles poorly,
 *   - CEM's elite averaging is robust to evaluation noise and needs no
 *     hyper-parameters beyond population / elite size.
 *
 * Variance control:
 *   - every candidate in a generation is evaluated on the SAME seed set
 *     (paired comparisons, like scripts/tune.ts),
 *   - the seed base rotates every generation so the distribution does not
 *     overfit a single seed set; incumbents (current CEM mean, best-ever
 *     candidate, default weights) are re-evaluated each generation on the new
 *     seeds so selection stays fair,
 *   - final confirmation runs on a held-out seed never used during tuning.
 *
 * Budget: pop 26 x 300 games x 16 gens ~ 125k games ~ 1.5 min at ~0.7 ms/game.
 */
import { mulberry32, thatsPrettyClever } from '../src/engine';
import { defaultWeights, makeGreedy, type Weights } from '../src/strategies';
import { simulate } from '../src/sim/runner';
import { computeStats } from '../src/sim/stats';

function arg(name: string, dflt: number): number {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  return raw === undefined ? dflt : Number(raw);
}

const GENS = arg('gens', 16);
const POP = arg('pop', 26);
const GAMES = arg('games', 300); // per-candidate games during selection
const TUNE_SEED = arg('seed', 101); // base for the rotating tuning seed sets
const CONFIRM_GAMES = arg('confirm-games', 1500);
const CONFIRM_SEED = arg('confirm-seed', 777); // held out from tuning entirely

const KEYS = Object.keys(defaultWeights) as (keyof Weights)[];

/** Per-weight sampling bounds: everything non-negative, generous upper caps. */
const LO: Weights = {
  reroll: 0, plus1: 0, foxEV: 0, groupPotential: 0, crossEV: 0,
  purpleSlotEV: 0, orangeSlotEVPerMult: 0, blueShaping: 0, greenShaping: 0,
  poolDieEV: 0, rerollGainThreshold: 0,
};
const HI: Weights = {
  reroll: 20, plus1: 30, foxEV: 45, groupPotential: 5, crossEV: 25,
  purpleSlotEV: 20, orangeSlotEVPerMult: 15, blueShaping: 15, greenShaping: 15,
  poolDieEV: 20, rerollGainThreshold: 15,
};

const rng = mulberry32(0xc1e4e6);
function gaussian(): number {
  // Box-Muller
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clampW(w: Weights): Weights {
  const out = { ...w };
  for (const k of KEYS) out[k] = Math.min(HI[k], Math.max(LO[k], out[k]));
  return out;
}

function sample(mean: Weights, std: Weights): Weights {
  const out = { ...mean };
  for (const k of KEYS) out[k] = mean[k] + std[k] * gaussian();
  return clampW(out);
}

function fmt(w: Weights): string {
  return KEYS.map((k) => `${k}: ${w[k].toFixed(2)}`).join(', ');
}

/** Mean score over `games` paired games starting at seed base. */
function fitness(w: Weights, games: number, seed: number): number {
  const results = simulate(thatsPrettyClever, makeGreedy(w), { games, seed });
  return results.reduce((a, r) => a + r.score.total, 0) / games;
}

// ---------------------------------------------------------------------------

const mean: Weights = { ...defaultWeights };
const std: Weights = { ...defaultWeights };
for (const k of KEYS) std[k] = Math.max(0.4 * Math.abs(defaultWeights[k]), 0.5);
const stdFloor: Weights = { ...std };
for (const k of KEYS) stdFloor[k] = 0.02 * std[k];

const ELITE = Math.max(4, Math.round(POP * 0.25));
let bestEver: { w: Weights; fit: number } = { w: { ...defaultWeights }, fit: -Infinity };

const t0 = Date.now();
let totalGames = 0;

for (let gen = 0; gen < GENS; gen++) {
  // Fresh paired seed set for this generation (held-out confirm seed untouched).
  const genSeed = (TUNE_SEED + gen * 7919) >>> 0;

  // Population: sampled candidates + incumbents re-evaluated on the new seeds.
  const cands: Weights[] = [clampW({ ...mean }), { ...bestEver.w }, { ...defaultWeights }];
  while (cands.length < POP) cands.push(sample(mean, std));

  const scored = cands
    .map((w) => ({ w, fit: fitness(w, GAMES, genSeed) }))
    .sort((a, b) => b.fit - a.fit);
  totalGames += cands.length * GAMES;

  if (scored[0].fit > bestEver.fit || gen === 0) bestEver = { w: scored[0].w, fit: scored[0].fit };
  else bestEver.fit = scored.find((s) => s.w === bestEver.w)?.fit ?? bestEver.fit;

  const elites = scored.slice(0, ELITE);
  const alpha = 0.7; // smoothing toward the elite statistics
  for (const k of KEYS) {
    const em = elites.reduce((a, e) => a + e.w[k], 0) / ELITE;
    const es = Math.sqrt(elites.reduce((a, e) => a + (e.w[k] - em) ** 2, 0) / ELITE);
    mean[k] = alpha * em + (1 - alpha) * mean[k];
    std[k] = Math.max(alpha * es + (1 - alpha) * std[k], stdFloor[k]);
  }

  const defFit = scored.find((s) => s.w === cands[2])?.fit ?? NaN;
  console.log(
    `gen ${String(gen + 1).padStart(2)}/${GENS}  seed ${genSeed}  ` +
      `best ${scored[0].fit.toFixed(1)}  elite-mean ${(elites.reduce((a, e) => a + e.fit, 0) / ELITE).toFixed(1)}  ` +
      `median ${scored[Math.floor(POP / 2)].fit.toFixed(1)}  default ${defFit.toFixed(1)}  ` +
      `[${((Date.now() - t0) / 1000).toFixed(0)}s]`,
  );
  console.log(`   mean: ${fmt(mean)}`);
}

// ---------------------------------------------------------------------------
// Confirmation on held-out seeds (never used during tuning).

console.log(`\ntuning done: ${totalGames} games in ${((Date.now() - t0) / 1000).toFixed(0)}s ` +
  `(${((Date.now() - t0) / totalGames).toFixed(2)} ms/game)`);

const finalists: { name: string; w: Weights }[] = [
  { name: 'cem-mean', w: clampW({ ...mean }) },
  { name: 'best-ever', w: bestEver.w },
  { name: 'default', w: { ...defaultWeights } },
];

console.log(`\nheld-out confirmation: seed ${CONFIRM_SEED}, ${CONFIRM_GAMES} games (paired)`);
let winner = finalists[0];
let winnerStats = { mean: -Infinity, std: 0 };
for (const f of finalists) {
  const st = computeStats(thatsPrettyClever, simulate(thatsPrettyClever, makeGreedy(f.w), { games: CONFIRM_GAMES, seed: CONFIRM_SEED }));
  console.log(`  ${f.name.padEnd(10)} mean ${st.mean.toFixed(1)} ± ${st.std.toFixed(1)}  p50 ${st.p50}  p90 ${st.p90}`);
  if (f.name !== 'default' && st.mean > winnerStats.mean) {
    winner = f;
    winnerStats = { mean: st.mean, std: st.std };
  }
}

console.log(`\nwinner: ${winner.name}  (held-out mean ${winnerStats.mean.toFixed(1)} ± ${winnerStats.std.toFixed(1)})`);
console.log('weights for src/strategies/tuned.ts:');
console.log(JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, Number(winner.w[k].toFixed(3))])), null, 2));
