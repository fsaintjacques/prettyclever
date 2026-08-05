/**
 * Joint CEM optimizer for the planner strategy: base eval weights + planner
 * rule-layer knobs in one vector (adapted from scripts/optimize.ts).
 *
 *   npx tsx scripts/optimize-planner.ts [--gens=14] [--pop=32] [--games=400]
 *                                       [--seed=101] [--confirm-games=1000]
 *
 * Vector (22 dims):
 *   - 9 live base eval weights. `plus1` and `rerollGainThreshold` are dead
 *     inside the planner (roundWeights always overrides plus1 with the
 *     plus1Early/Mid/Late knobs, and the planner has its own reroll rule),
 *     so they are excluded rather than left to wander.
 *   - 13 numeric PlannerOpts knobs.
 *
 * Method: cross-entropy method, same variance controls as optimize.ts:
 *   - every candidate in a generation is scored on the SAME seed set (paired),
 *   - the seed base rotates every generation; incumbents (CEM mean, best-ever,
 *     default planner, TUNED_WEIGHTS + default knobs) are re-scored on the new
 *     seeds each generation so selection stays fair,
 *   - final confirmation runs on held-out seed bases (777, 424242) never used
 *     during tuning, paired against default planner and greedy-tuned.
 *
 * Initialization: the population is seeded from TWO means — (a) the current
 * planner defaults and (b) TUNED_WEIGHTS with default knobs — with an initial
 * std wide enough to bridge them; generation 0 samples half from each.
 *
 * Budget: pop 32 x 400 games x 14 gens ~ 180k games ~ 2-3 min at ~0.7 ms/game.
 */
import { mulberry32, standard } from '../src/engine';
import {
  defaultPlannerOpts,
  defaultWeights,
  makeGreedy,
  makePlanner,
  TUNED_WEIGHTS,
  type PlannerOpts,
  type Weights,
} from '../src/strategies';
import { simulate } from '../src/sim/runner';
import { computeStats } from '../src/sim/stats';

function arg(name: string, dflt: number): number {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  return raw === undefined ? dflt : Number(raw);
}

const GENS = arg('gens', 14);
const POP = arg('pop', 32);
const GAMES = arg('games', 400); // per-candidate games during selection
const TUNE_SEED = arg('seed', 101); // base for the rotating tuning seed sets
const CONFIRM_GAMES = arg('confirm-games', 1000);
const CONFIRM_SEEDS = [777, 424242]; // held out from tuning entirely

// ---------------------------------------------------------------------------
// Joint vector.

const WKEYS = [
  'reroll', 'foxEV', 'groupPotential', 'crossEV', 'purpleSlotEV',
  'orangeSlotEVPerMult', 'blueShaping', 'greenShaping', 'poolDieEV',
] as const;
const KKEYS = [
  'purpleBarW', 'purpleSixBonus', 'orangeMultW', 'earlyShaping',
  'plus1Early', 'plus1Mid', 'plus1Late', 'rerollBase', 'rerollPerDie',
  'rerollLate', 'yellowShapeW', 'poolScale', 'wildBonus',
] as const;
type WKey = (typeof WKEYS)[number];
type KKey = (typeof KKEYS)[number];
type Dim = WKey | KKey;
const DIMS: Dim[] = [...WKEYS, ...KKEYS];
type Vec = Record<Dim, number>;

function toOpts(x: Vec): Partial<PlannerOpts> {
  const weights: Partial<Weights> = {};
  for (const k of WKEYS) weights[k] = x[k];
  const opts: Partial<PlannerOpts> = { weights };
  for (const k of KKEYS) opts[k] = x[k];
  return opts;
}

/** Starting mean (a): the current hand-tuned planner defaults. */
const plannerDefaultVec: Vec = (() => {
  const base: Weights = { ...defaultWeights, ...defaultPlannerOpts.weights };
  const out = {} as Vec;
  for (const k of WKEYS) out[k] = base[k];
  for (const k of KKEYS) out[k] = defaultPlannerOpts[k];
  return out;
})();

/** Starting mean (b): CEM-tuned greedy weights with the default knobs. */
const tunedWeightsVec: Vec = (() => {
  const out = {} as Vec;
  for (const k of WKEYS) out[k] = TUNED_WEIGHTS[k];
  for (const k of KKEYS) out[k] = defaultPlannerOpts[k];
  return out;
})();

/** Sampling bounds: everything non-negative, generous upper caps. */
const LO: Vec = Object.fromEntries(DIMS.map((k) => [k, 0])) as Vec;
const HI: Vec = {
  reroll: 20, foxEV: 45, groupPotential: 5, crossEV: 25, purpleSlotEV: 20,
  orangeSlotEVPerMult: 15, blueShaping: 15, greenShaping: 15, poolDieEV: 20,
  purpleBarW: 5, purpleSixBonus: 20, orangeMultW: 5, earlyShaping: 8,
  plus1Early: 30, plus1Mid: 30, plus1Late: 30, rerollBase: 12,
  rerollPerDie: 3, rerollLate: 8, yellowShapeW: 6, poolScale: 3, wildBonus: 8,
};

const rng = mulberry32(0x91a44e4);
function gaussian(): number {
  // Box-Muller
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clampV(x: Vec): Vec {
  const out = { ...x };
  for (const k of DIMS) out[k] = Math.min(HI[k], Math.max(LO[k], out[k]));
  return out;
}

function sample(mean: Vec, std: Vec): Vec {
  const out = { ...mean };
  for (const k of DIMS) out[k] = mean[k] + std[k] * gaussian();
  return clampV(out);
}

function fmt(x: Vec): string {
  return DIMS.map((k) => `${k}: ${x[k].toFixed(2)}`).join(', ');
}

/** Mean score over `games` paired games starting at seed base. */
function fitness(x: Vec, games: number, seed: number): number {
  const results = simulate(standard, makePlanner(toOpts(x)), { games, seed });
  return results.reduce((a, r) => a + r.score.total, 0) / games;
}

// ---------------------------------------------------------------------------

// Initial distribution bridges both starting means.
const mean: Vec = { ...plannerDefaultVec };
for (const k of DIMS) mean[k] = (plannerDefaultVec[k] + tunedWeightsVec[k]) / 2;
const std: Vec = { ...mean };
for (const k of DIMS) {
  std[k] = Math.max(
    0.4 * Math.max(Math.abs(plannerDefaultVec[k]), Math.abs(tunedWeightsVec[k])),
    0.6 * Math.abs(plannerDefaultVec[k] - tunedWeightsVec[k]),
    0.5,
  );
}
const stdFloor: Vec = { ...std };
for (const k of DIMS) stdFloor[k] = 0.02 * std[k];

const ELITE = Math.max(5, Math.round(POP * 0.25));
let bestEver: { x: Vec; fit: number } = { x: { ...plannerDefaultVec }, fit: -Infinity };

const t0 = Date.now();
let totalGames = 0;

for (let gen = 0; gen < GENS; gen++) {
  // Fresh paired seed set for this generation (held-out confirm seeds untouched).
  const genSeed = (TUNE_SEED + gen * 7919) >>> 0;

  // Population: incumbents re-evaluated on the new seeds + sampled candidates.
  const cands: Vec[] = [
    clampV({ ...mean }),
    { ...bestEver.x },
    { ...plannerDefaultVec },
    { ...tunedWeightsVec },
  ];
  while (cands.length < POP) {
    // Gen 0 samples half around each starting mean; later gens use the CEM mean.
    const center = gen === 0 ? (cands.length % 2 === 0 ? plannerDefaultVec : tunedWeightsVec) : mean;
    cands.push(sample(center, std));
  }

  const scored = cands
    .map((x) => ({ x, fit: fitness(x, GAMES, genSeed) }))
    .sort((a, b) => b.fit - a.fit);
  totalGames += cands.length * GAMES;

  // Refresh best-ever's fitness on this generation's seeds, then challenge it.
  const refreshed = scored.find((s) => s.x === cands[1]);
  if (refreshed) bestEver.fit = refreshed.fit;
  if (scored[0].fit > bestEver.fit || gen === 0) bestEver = { x: scored[0].x, fit: scored[0].fit };

  const elites = scored.slice(0, ELITE);
  const alpha = 0.7; // smoothing toward the elite statistics
  for (const k of DIMS) {
    const em = elites.reduce((a, e) => a + e.x[k], 0) / ELITE;
    const es = Math.sqrt(elites.reduce((a, e) => a + (e.x[k] - em) ** 2, 0) / ELITE);
    mean[k] = alpha * em + (1 - alpha) * mean[k];
    std[k] = Math.max(alpha * es + (1 - alpha) * std[k], stdFloor[k]);
  }

  const defFit = scored.find((s) => s.x === cands[2])?.fit ?? NaN;
  const tunedFit = scored.find((s) => s.x === cands[3])?.fit ?? NaN;
  console.log(
    `gen ${String(gen + 1).padStart(2)}/${GENS}  seed ${genSeed}  ` +
      `best ${scored[0].fit.toFixed(1)}  elite-mean ${(elites.reduce((a, e) => a + e.fit, 0) / ELITE).toFixed(1)}  ` +
      `median ${scored[Math.floor(POP / 2)].fit.toFixed(1)}  ` +
      `planner-default ${defFit.toFixed(1)}  tuned-w ${tunedFit.toFixed(1)}  ` +
      `[${((Date.now() - t0) / 1000).toFixed(0)}s]`,
  );
  console.log(`   mean: ${fmt(mean)}`);
}

// ---------------------------------------------------------------------------
// Confirmation on held-out seeds (never used during tuning), paired against
// both the default planner and greedy-tuned on the same seed sets.

console.log(`\ntuning done: ${totalGames} games in ${((Date.now() - t0) / 1000).toFixed(0)}s ` +
  `(${((Date.now() - t0) / totalGames).toFixed(2)} ms/game)`);

const finalists = [
  { name: 'cem-mean', s: makePlanner(toOpts(clampV({ ...mean }))), x: clampV({ ...mean }) as Vec | null },
  { name: 'best-ever', s: makePlanner(toOpts(bestEver.x)), x: bestEver.x as Vec | null },
  { name: 'planner-default', s: makePlanner(), x: null },
  { name: 'greedy-tuned', s: makeGreedy(TUNED_WEIGHTS, 'greedy-tuned'), x: null },
];

let winner = finalists[0];
let winnerFit = -Infinity;
for (const f of finalists) {
  const parts: string[] = [];
  let sum = 0;
  let ms = 0;
  for (const seed of CONFIRM_SEEDS) {
    const tc0 = Date.now();
    const st = computeStats(standard, simulate(standard, f.s, { games: CONFIRM_GAMES, seed }));
    ms += Date.now() - tc0;
    sum += st.mean;
    parts.push(`seed ${seed}: ${st.mean.toFixed(1)} ± ${st.std.toFixed(1)} (p50 ${st.p50}, p90 ${st.p90})`);
  }
  console.log(
    `  ${f.name.padEnd(16)} ${parts.join('   ')}   avg ${(sum / CONFIRM_SEEDS.length).toFixed(1)}  ` +
      `${(ms / (CONFIRM_GAMES * CONFIRM_SEEDS.length)).toFixed(2)} ms/game`,
  );
  if (f.x && sum > winnerFit) {
    winner = f;
    winnerFit = sum;
  }
}

console.log(`\nwinner: ${winner.name}  (held-out avg mean ${(winnerFit / CONFIRM_SEEDS.length).toFixed(1)})`);
console.log('values for planner-tuned in src/strategies/index.ts:');
const wx = winner.x!;
console.log('weights:', JSON.stringify(Object.fromEntries(WKEYS.map((k) => [k, Number(wx[k].toFixed(3))]))));
console.log('knobs:  ', JSON.stringify(Object.fromEntries(KKEYS.map((k) => [k, Number(wx[k].toFixed(3))]))));
