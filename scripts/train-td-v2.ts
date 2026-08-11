/**
 * TD(λ) self-play trainer for the tdnetv2 value network (v1 features + the
 * phase-gated die-face block; see src/strategies/tdnetv2.ts).
 *
 *   npx tsx scripts/train-td-v2.ts --minutes 50
 *   npx tsx scripts/train-td-v2.ts --resume td-checkpoint-v2.json --minutes 10
 *
 * Same design as scripts/train-td.ts (kept byte-identical for v1):
 *  - Afterstate learning with forward-view λ-returns, Adam, shuffled
 *    minibatches; frozen-net eval on a fixed seed set; best net shipped.
 *  - All randomness from seeded mulberry32 streams (resume-reproducible).
 * The one deliberate upgrade besides the features: the warm start regresses on
 * games played by the committed td-net v1 policy (~242 mean) instead of
 * planner-tuned (~170), so V starts in a far better ballpark.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  applyActionMut,
  getPending,
  getVariant,
  mulberry32,
  newGame,
  resolveChanceMut,
  scoreState,
  type Action,
  type GameState,
} from '../src/engine';
import { makeTdNet } from '../src/strategies/tdnet';
import {
  createEvalCtx,
  forward,
  initNet,
  netFromParams,
  paramsFromNet,
  type EvalCtx,
  type Net,
  type TdNetParams,
} from '../src/strategies/tdnet';
import { chooseByValue2, extractFeaturesV2, TD2_FEATURES } from '../src/strategies/tdnetv2';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z0-9-]+)(?:=(.*))?$/i);
    if (!m) continue;
    args[m[1]] = m[2] ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const num = (k: string, d: number) => (args[k] !== undefined ? Number(args[k]) : d);

const cfg = {
  minutes: num('minutes', 50),
  episodes: num('episodes', 100000),
  warmGames: num('warm-games', 3000),
  lambda: num('lambda', 0.8),
  epsStart: num('eps-start', 0.15),
  epsEnd: num('eps-end', 0.02),
  /** ε decays linearly over this fraction of the episode budget. */
  epsFrac: num('eps-frac', 0.6),
  batch: num('batch', 32),
  lrWarm: num('lr-warm', 1e-3),
  lr: num('lr', 3e-4),
  hidden: num('hidden', 128),
  evalEvery: num('eval-every', 4000),
  evalGames: num('eval-games', 200),
  evalSeed: num('eval-seed', 90210),
  seed: num('seed', 20260805),
  resume: args.resume,
  checkpoint: args.checkpoint ?? 'td-checkpoint-v2.json',
  out: args.out ?? 'src/strategies/tdnetv2-weights.ts',
};

const v = getVariant('thats-pretty-clever');

// ---------------------------------------------------------------------------
// Adam trainer (MSE on V, backprop through the 2-hidden-layer MLP)
// ---------------------------------------------------------------------------

interface Sparse {
  // Uint16: feature sets above 255 inputs would silently wrap Uint8 indices
  // and corrupt every training sample.
  idx: Uint16Array;
  val: Float32Array;
}

function toSparse(x: Float64Array): Sparse {
  let n = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== 0) n++;
  const idx = new Uint16Array(n);
  const val = new Float32Array(n);
  let j = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== 0) {
      idx[j] = i;
      val[j] = x[i];
      j++;
    }
  }
  return { idx, val };
}

class Trainer {
  net: Net;
  private tensors: Float64Array[];
  private grads: Float64Array[];
  private m: Float64Array[];
  private v2: Float64Array[];
  adamT = 0;
  private x: Float64Array;
  private h1: Float64Array;
  private h2: Float64Array;
  private dh1: Float64Array;
  private dh2: Float64Array;

  constructor(net: Net) {
    this.net = net;
    this.tensors = [net.W1, net.b1, net.W2, net.b2, net.W3, net.b3];
    this.grads = this.tensors.map((t) => new Float64Array(t.length));
    this.m = this.tensors.map((t) => new Float64Array(t.length));
    this.v2 = this.tensors.map((t) => new Float64Array(t.length));
    this.x = new Float64Array(net.nIn);
    this.h1 = new Float64Array(net.nH1);
    this.h2 = new Float64Array(net.nH2);
    this.dh1 = new Float64Array(net.nH1);
    this.dh2 = new Float64Array(net.nH2);
  }

  /** Accumulate the gradient of ½(V(x) − target)² ; returns |TD error|. */
  private accumulate(sp: Sparse, target: number): number {
    const { net, x, h1, h2, dh1, dh2 } = this;
    const [gW1, gb1, gW2, gb2, gW3, gb3] = this.grads;
    x.fill(0);
    for (let i = 0; i < sp.idx.length; i++) x[sp.idx[i]] = sp.val[i];
    const y = forward(net, x, h1, h2);
    const dy = y - target;
    gb3[0] += dy;
    const { nH1, nH2 } = net;
    for (let t = 0; t < nH2; t++) {
      const h = h2[t];
      if (h > 0) {
        gW3[t] += dy * h;
        dh2[t] = dy * net.W3[t];
      } else dh2[t] = 0;
    }
    for (let t = 0; t < nH2; t++) if (dh2[t] !== 0) gb2[t] += dh2[t];
    for (let j = 0; j < nH1; j++) {
      const hj = h1[j];
      if (hj <= 0) {
        dh1[j] = 0;
        continue;
      }
      const off = j * nH2;
      let d = 0;
      for (let t = 0; t < nH2; t++) {
        const dd = dh2[t];
        if (dd !== 0) {
          gW2[off + t] += hj * dd;
          d += net.W2[off + t] * dd;
        }
      }
      dh1[j] = d;
    }
    for (let j = 0; j < nH1; j++) if (dh1[j] !== 0) gb1[j] += dh1[j];
    for (let i = 0; i < sp.idx.length; i++) {
      const off = sp.idx[i] * nH1;
      const xi = sp.val[i];
      for (let j = 0; j < nH1; j++) gW1[off + j] += xi * dh1[j];
    }
    return Math.abs(dy);
  }

  private step(lr: number, batch: number): void {
    this.adamT++;
    const b1 = 0.9;
    const b2 = 0.999;
    const eps = 1e-8;
    const c1 = 1 - Math.pow(b1, this.adamT);
    const c2 = 1 - Math.pow(b2, this.adamT);
    for (let p = 0; p < this.tensors.length; p++) {
      const w = this.tensors[p];
      const g = this.grads[p];
      const m = this.m[p];
      const vv = this.v2[p];
      for (let i = 0; i < w.length; i++) {
        const gi = g[i] / batch;
        m[i] = b1 * m[i] + (1 - b1) * gi;
        vv[i] = b2 * vv[i] + (1 - b2) * gi * gi;
        w[i] -= (lr * (m[i] / c1)) / (Math.sqrt(vv[i] / c2) + eps);
        g[i] = 0;
      }
    }
  }

  /** One shuffled minibatch pass over the samples; returns mean |TD error|. */
  trainPass(states: Sparse[], targets: number[], lr: number, rng: () => number): number {
    const n = states.length;
    if (n === 0) return 0;
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
    let errSum = 0;
    for (let at = 0; at < n; at += cfg.batch) {
      const end = Math.min(n, at + cfg.batch);
      for (let i = at; i < end; i++) errSum += this.accumulate(states[order[i]], targets[order[i]]);
      this.step(lr, end - at);
    }
    return errSum / n;
  }

  snapshot(): { m: number[][]; v: number[][]; t: number } {
    return {
      m: this.m.map((a) => Array.from(a)),
      v: this.v2.map((a) => Array.from(a)),
      t: this.adamT,
    };
  }

  restore(snap: { m: number[][]; v: number[][]; t: number }): void {
    snap.m.forEach((a, i) => this.m[i].set(a));
    snap.v.forEach((a, i) => this.v2[i].set(a));
    this.adamT = snap.t;
  }
}

// ---------------------------------------------------------------------------
// Episode generation
// ---------------------------------------------------------------------------

interface Episode {
  states: Sparse[];
  values: number[];
  score: number;
}

/** Self-play episode with ε-greedy afterstate argmax; records afterstates. */
function playEpisode(ctx: EvalCtx, rng: () => number, epsilon: number): Episode {
  const s = newGame(v);
  const states: Sparse[] = [];
  const values: number[] = [];
  for (;;) {
    const node = getPending(s, v);
    if (node.kind === 'over') break;
    if (node.kind === 'chance') {
      resolveChanceMut(s, v, rng);
      continue;
    }
    let a: Action;
    if (epsilon > 0 && rng() < epsilon) a = node.actions[Math.floor(rng() * node.actions.length)];
    else a = chooseByValue2(ctx, s, v, node.actions);
    applyActionMut(s, v, a);
    if (s.phase !== 'over') {
      extractFeaturesV2(s, v, ctx.x);
      states.push(toSparse(ctx.x));
      values.push(forward(ctx.net, ctx.x, ctx.h1, ctx.h2));
    }
  }
  return { states, values, score: scoreState(s, v).total };
}

/** Episode driven by an external policy (warm start); no V predictions needed. */
function playPolicyEpisode(
  choose: (s: GameState, actions: Action[]) => Action,
  scratch: Float64Array,
  rng: () => number,
): Episode {
  const s = newGame(v);
  const states: Sparse[] = [];
  for (;;) {
    const node = getPending(s, v);
    if (node.kind === 'over') break;
    if (node.kind === 'chance') {
      resolveChanceMut(s, v, rng);
      continue;
    }
    applyActionMut(s, v, choose(s, node.actions));
    if (s.phase !== 'over') {
      extractFeaturesV2(s, v, scratch);
      states.push(toSparse(scratch));
    }
  }
  return { states, values: [], score: scoreState(s, v).total };
}

/** Forward-view λ-returns: G_t = (1−λ)·V(s_{t+1}) + λ·G_{t+1}, terminal = z. */
function lambdaReturns(values: number[], z: number, lambda: number): number[] {
  const T = values.length;
  const targets = new Array<number>(T);
  let G = z;
  for (let t = T - 1; t >= 0; t--) {
    targets[t] = G;
    G = (1 - lambda) * values[t] + lambda * G;
  }
  return targets;
}

/** Frozen-net evaluation: pure argmax on a fixed seed set. */
function evalNet(net: Net, games: number, seedBase: number): { mean: number; std: number } {
  const ctx = createEvalCtx(net);
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < games; i++) {
    const rng = mulberry32((seedBase + i * 2654435761) >>> 0);
    const s = newGame(v);
    for (;;) {
      const node = getPending(s, v);
      if (node.kind === 'over') break;
      if (node.kind === 'chance') {
        resolveChanceMut(s, v, rng);
        continue;
      }
      applyActionMut(s, v, chooseByValue2(ctx, s, v, node.actions));
    }
    const sc = scoreState(s, v).total;
    sum += sc;
    sq += sc * sc;
  }
  const mean = sum / games;
  return { mean, std: Math.sqrt(Math.max(0, sq / games - mean * mean)) };
}

// ---------------------------------------------------------------------------
// Checkpointing
// ---------------------------------------------------------------------------

interface Checkpoint {
  episode: number;
  warmDone: boolean;
  params: TdNetParams;
  adam: { m: number[][]; v: number[][]; t: number };
  bestMean: number;
  bestParams: TdNetParams | null;
  curve: { ep: number; mean: number; std: number; tdErr: number; sec: number }[];
}

function fullParams(net: Net): TdNetParams {
  return {
    nIn: net.nIn,
    nH1: net.nH1,
    nH2: net.nH2,
    W1: Array.from(net.W1),
    b1: Array.from(net.b1),
    W2: Array.from(net.W2),
    b2: Array.from(net.b2),
    W3: Array.from(net.W3),
    b3: net.b3[0],
  };
}

function writeWeightsModule(path: string, params: TdNetParams, header: string): void {
  const arr = (a: number[]) => `[${a.map((x) => Number(x.toPrecision(5))).join(',')}]`;
  const src = `/**
 * Trained TD(λ) v2 value-network weights — GENERATED by scripts/train-td-v2.ts.
 * ${header}
 */
import type { TdNetParams } from './tdnet';

export const TDNETV2_WEIGHTS: TdNetParams = {
  nIn: ${params.nIn},
  nH1: ${params.nH1},
  nH2: ${params.nH2},
  W1: ${arr(params.W1)},
  b1: ${arr(params.b1)},
  W2: ${arr(params.W2)},
  b2: ${arr(params.b2)},
  W3: ${arr(params.W3)},
  b3: ${Number(params.b3.toPrecision(5))},
};
`;
  writeFileSync(path, src);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const t0 = performance.now();
const elapsedSec = () => (performance.now() - t0) / 1000;
const budgetSec = cfg.minutes * 60;

let net: Net;
let trainer: Trainer;
let startEpisode = 0;
let warmDone = false;
let bestMean = -Infinity;
let bestParams: TdNetParams | null = null;
let curve: Checkpoint['curve'] = [];

if (cfg.resume && existsSync(cfg.resume)) {
  const ck = JSON.parse(readFileSync(cfg.resume, 'utf8')) as Checkpoint;
  net = netFromParams(ck.params);
  trainer = new Trainer(net);
  trainer.restore(ck.adam);
  startEpisode = ck.episode;
  warmDone = ck.warmDone;
  bestMean = ck.bestMean;
  bestParams = ck.bestParams;
  curve = ck.curve;
  console.log(`resumed from ${cfg.resume} @ episode ${startEpisode} (best eval ${bestMean.toFixed(1)})`);
} else {
  net = initNet(TD2_FEATURES, cfg.hidden, cfg.hidden, mulberry32((cfg.seed ^ 0x5eed) >>> 0));
  trainer = new Trainer(net);
}

function saveCheckpoint(episode: number): void {
  const ck: Checkpoint = {
    episode,
    warmDone,
    params: fullParams(net),
    adam: trainer.snapshot(),
    bestMean,
    bestParams,
    curve,
  };
  writeFileSync(cfg.checkpoint, JSON.stringify(ck));
}

function runEval(episode: number, tdErr: number): void {
  const { mean, std } = evalNet(net, cfg.evalGames, cfg.evalSeed);
  const sec = elapsedSec();
  curve.push({ ep: episode, mean, std, tdErr, sec });
  const star = mean > bestMean ? '  ← best' : '';
  console.log(
    `ep ${String(episode).padStart(6)}  eval ${mean.toFixed(1)} ± ${std.toFixed(1)}  tdErr ${tdErr.toFixed(4)}  ${sec.toFixed(0)}s${star}`,
  );
  if (mean > bestMean) {
    bestMean = mean;
    bestParams = paramsFromNet(net);
  }
  saveCheckpoint(episode);
}

// --- Warm start: regress V on td-net v1 Monte-Carlo returns (streaming).
if (!warmDone) {
  const teacher = makeTdNet(); // committed v1 weights, ~242 mean
  const warmRng = mulberry32((cfg.seed ^ 0x9e3779b9) >>> 0);
  const scratch = new Float64Array(net.nIn);
  let scoreSum = 0;
  let err = 0;
  console.log(`warm start: ${cfg.warmGames} td-net v1 games (MC regression)...`);
  for (let g = 0; g < cfg.warmGames; g++) {
    const gameRng = mulberry32((cfg.seed + 101 + g * 2654435761) >>> 0);
    const ep = playPolicyEpisode(
      (s, actions) => teacher.choose(s, actions, { variant: v, rng: gameRng }),
      scratch,
      gameRng,
    );
    scoreSum += ep.score;
    const z = ep.score / 300;
    err = trainer.trainPass(ep.states, ep.states.map(() => z), cfg.lrWarm, warmRng);
    if ((g + 1) % 500 === 0) {
      console.log(
        `  warm ${g + 1}/${cfg.warmGames}  v1 mean ${(scoreSum / (g + 1)).toFixed(1)}  tdErr ${err.toFixed(4)}  ${elapsedSec().toFixed(0)}s`,
      );
    }
  }
  warmDone = true;
  runEval(0, err);
}

// --- Self-play TD(λ).
const trainRng = mulberry32((cfg.seed ^ 0x517cc1b7) >>> 0);
const ctx = createEvalCtx(net);
let tdErrAvg = 0;
let episode = startEpisode;
const epsAt = (ep: number) => {
  const f = Math.min(1, ep / Math.max(1, cfg.episodes * cfg.epsFrac));
  return cfg.epsStart + (cfg.epsEnd - cfg.epsStart) * f;
};
const lrAt = (ep: number) => (ep < cfg.episodes * 0.6 ? cfg.lr : ep < cfg.episodes * 0.85 ? cfg.lr / 2 : cfg.lr / 4);

console.log(`self-play: up to ${cfg.episodes} episodes / ${cfg.minutes} min (λ=${cfg.lambda})`);
while (episode < cfg.episodes && elapsedSec() < budgetSec) {
  const epRng = mulberry32((cfg.seed ^ (episode * 2654435761 + 7)) >>> 0);
  const ep = playEpisode(ctx, epRng, epsAt(episode));
  const targets = lambdaReturns(ep.values, ep.score / 300, cfg.lambda);
  const err = trainer.trainPass(ep.states, targets, lrAt(episode), trainRng);
  tdErrAvg = tdErrAvg === 0 ? err : tdErrAvg * 0.995 + err * 0.005;
  episode++;
  if (episode % cfg.evalEvery === 0) runEval(episode, tdErrAvg);
}
if (episode % cfg.evalEvery !== 0) runEval(episode, tdErrAvg);

// --- Ship the best net seen.
const final = bestParams ?? paramsFromNet(net);
writeWeightsModule(
  cfg.out,
  final,
  `${episode} self-play episodes (λ=${cfg.lambda}, seed ${cfg.seed}), warm start on ${cfg.warmGames} td-net v1 games, ` +
    `best frozen eval ${bestMean.toFixed(1)} on ${cfg.evalGames} games @ seed ${cfg.evalSeed}.`,
);
console.log(`\nwrote ${cfg.out} (best eval ${bestMean.toFixed(1)}), checkpoint ${cfg.checkpoint}`);
console.log('curve:', curve.map((c) => `${c.ep}:${c.mean.toFixed(1)}`).join(' '));
