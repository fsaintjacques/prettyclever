/**
 * Parallel TD(λ) self-play trainer: worker threads generate episodes, the
 * main thread owns the net + Adam and trains on the returned samples.
 *
 *   npx tsx scripts/train-td-parallel.ts --resume checkpoints/td-main.json \
 *     --checkpoint checkpoints/td-parallel.json --out checkpoints/tdnet-weights-500k.ts \
 *     --episodes 500000 --patience 48000 --workers 6
 *
 * Same math as scripts/train-td.ts (forward-view λ-returns, Adam, shuffled
 * minibatches, frozen-net eval, best-net shipping; checkpoint format is
 * compatible). Differences:
 *  - Episode generation fans out over --workers worker_threads. Each task is a
 *    chunk of episodes played with a snapshot of the current weights; weights
 *    refresh on every dispatch, so behavior-policy staleness is bounded by
 *    (workers × chunk) episodes.
 *  - Per-episode RNG seeding matches the serial trainer, but the *training
 *    order* of episodes depends on worker completion order, so runs are not
 *    bit-reproducible (per-episode dice streams still are).
 *  - Early stopping: training stops once no new best frozen-eval has been
 *    seen for --patience episodes.
 *  - --features v1|v2 selects the tdnet or tdnetv2 feature set/policy.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
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
  type VariantDef,
} from '../src/engine';
import {
  chooseByValue,
  createEvalCtx,
  extractFeatures,
  forward,
  initNet,
  netFromParams,
  paramsFromNet,
  TD_FEATURES,
  type EvalCtx,
  type Net,
  type TdNetParams,
} from '../src/strategies/tdnet';
import { chooseByValue2, extractFeaturesV2, TD2_FEATURES } from '../src/strategies/tdnetv2';
import { TDNET_WEIGHTS } from '../src/strategies/tdnet-weights';
import { TDNETV2_WEIGHTS } from '../src/strategies/tdnetv2-weights';

// ---------------------------------------------------------------------------
// Feature sets
// ---------------------------------------------------------------------------

interface FeatureSet {
  n: number;
  extract: (s: GameState, v: VariantDef, x: Float64Array) => void;
  choose: (ctx: EvalCtx, s: GameState, v: VariantDef, actions: Action[]) => Action;
  /** Committed same-feature-set net used as the warm-start teacher for --fresh runs. */
  teacher: TdNetParams;
}

const FEATURE_SETS: Record<string, FeatureSet> = {
  v1: { n: TD_FEATURES, extract: extractFeatures, choose: chooseByValue, teacher: TDNET_WEIGHTS },
  v2: { n: TD2_FEATURES, extract: extractFeaturesV2, choose: chooseByValue2, teacher: TDNETV2_WEIGHTS },
};

// ---------------------------------------------------------------------------
// Shared: sparse samples, λ-returns, episode generation
// ---------------------------------------------------------------------------

interface Sparse {
  idx: Uint8Array;
  val: Float32Array;
}

function toSparse(x: Float64Array): Sparse {
  let n = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== 0) n++;
  const idx = new Uint8Array(n);
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

interface EpisodeSamples {
  states: Sparse[];
  targets: number[];
  score: number;
}

function playEpisode(
  fs: FeatureSet,
  v: VariantDef,
  ctx: EvalCtx,
  rng: () => number,
  epsilon: number,
  lambda: number,
): EpisodeSamples {
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
    else a = fs.choose(ctx, s, v, node.actions);
    applyActionMut(s, v, a);
    if (s.phase !== 'over') {
      fs.extract(s, v, ctx.x);
      states.push(toSparse(ctx.x));
      values.push(forward(ctx.net, ctx.x, ctx.h1, ctx.h2));
    }
  }
  const score = scoreState(s, v).total;
  return { states, targets: lambdaReturns(values, score / 300, lambda), score };
}

// ---------------------------------------------------------------------------
// Worker side: play a chunk of episodes with a weight snapshot
// ---------------------------------------------------------------------------

interface WorkerInit {
  features: string;
  seed: number;
  lambda: number;
}

interface TaskMsg {
  type: 'task';
  tensors: Float64Array[]; // W1 b1 W2 b2 W3 b3
  dims: { nIn: number; nH1: number; nH2: number };
  epStart: number;
  count: number;
  epsilon: number;
}

/** Warm-start task: play `count` games with the committed teacher net, return MC-target samples. */
interface WarmTaskMsg {
  type: 'warm';
  gameStart: number;
  count: number;
}

interface ResultMsg {
  type: 'result';
  warm: boolean;
  episodes: EpisodeSamples[];
}

if (!isMainThread) {
  const init = workerData as WorkerInit;
  const fs = FEATURE_SETS[init.features];
  const v = getVariant('thats-pretty-clever');
  let teacherCtx: EvalCtx | null = null;
  parentPort!.on('message', (msg: TaskMsg | WarmTaskMsg | { type: 'exit' }) => {
    if (msg.type === 'exit') process.exit(0);
    const episodes: EpisodeSamples[] = [];
    if (msg.type === 'warm') {
      teacherCtx ??= createEvalCtx(netFromParams(fs.teacher));
      const scratch = new Float64Array(fs.n);
      for (let i = 0; i < msg.count; i++) {
        const rng = mulberry32((init.seed + 101 + (msg.gameStart + i) * 2654435761) >>> 0);
        const s = newGame(v);
        const states: Sparse[] = [];
        for (;;) {
          const node = getPending(s, v);
          if (node.kind === 'over') break;
          if (node.kind === 'chance') {
            resolveChanceMut(s, v, rng);
            continue;
          }
          applyActionMut(s, v, fs.choose(teacherCtx, s, v, node.actions));
          if (s.phase !== 'over') {
            fs.extract(s, v, scratch);
            states.push(toSparse(scratch));
          }
        }
        const score = scoreState(s, v).total;
        episodes.push({ states, targets: states.map(() => score / 300), score });
      }
    } else {
      const [W1, b1, W2, b2, W3, b3] = msg.tensors;
      const net: Net = { ...msg.dims, W1, b1, W2, b2, W3, b3 };
      const ctx = createEvalCtx(net);
      for (let i = 0; i < msg.count; i++) {
        const ep = msg.epStart + i;
        const rng = mulberry32((init.seed ^ (ep * 2654435761 + 7)) >>> 0);
        episodes.push(playEpisode(fs, v, ctx, rng, msg.epsilon, init.lambda));
      }
    }
    parentPort!.postMessage({ type: 'result', warm: msg.type === 'warm', episodes } satisfies ResultMsg);
  });
}

// ---------------------------------------------------------------------------
// Adam trainer (identical math to scripts/train-td.ts)
// ---------------------------------------------------------------------------

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
  batch: number;

  constructor(net: Net, batch: number) {
    this.net = net;
    this.batch = batch;
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
    for (let at = 0; at < n; at += this.batch) {
      const end = Math.min(n, at + this.batch);
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
// Main side
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

async function main(): Promise<void> {
  const parseArgs = (argv: string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
      const m = argv[i].match(/^--([a-z0-9-]+)(?:=(.*))?$/i);
      if (!m) continue;
      out[m[1]] = m[2] ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    }
    return out;
  };
  const args = parseArgs(process.argv.slice(2));
  const num = (k: string, d: number) => (args[k] !== undefined ? Number(args[k]) : d);

  const cfg = {
    features: args.features ?? 'v1',
    minutes: num('minutes', 120),
    episodes: num('episodes', 500000),
    patience: num('patience', 48000),
    lambda: num('lambda', 0.8),
    epsStart: num('eps-start', 0.15),
    epsEnd: num('eps-end', 0.02),
    epsFrac: num('eps-frac', 0.6),
    batch: num('batch', 32),
    lr: num('lr', 3e-4),
    workers: num('workers', Math.max(1, Math.min(8, availableParallelism() - 2))),
    chunk: num('chunk', 16),
    evalEvery: num('eval-every', 4000),
    evalGames: num('eval-games', 200),
    evalSeed: num('eval-seed', 90210),
    seed: num('seed', 20260805),
    fresh: args.fresh === 'true',
    hidden: num('hidden', 128),
    warmGames: num('warm-games', 4000),
    lrWarm: num('lr-warm', 1e-3),
    resume: args.resume,
    checkpoint: args.checkpoint ?? 'checkpoints/td-parallel.json',
    out: args.out ?? 'checkpoints/tdnet-weights-parallel.ts',
  };
  const fs = FEATURE_SETS[cfg.features];
  if (!fs) throw new Error(`unknown feature set '${cfg.features}' (v1 | v2)`);
  const v = getVariant('thats-pretty-clever');

  let net: Net;
  let trainer: Trainer;
  let episode = 0;
  let bestMean = -Infinity;
  let bestParams: TdNetParams | null = null;
  let warmDone = false;
  let curve: Checkpoint['curve'] = [];
  if (cfg.fresh) {
    net = initNet(fs.n, cfg.hidden, cfg.hidden, mulberry32((cfg.seed ^ 0x5eed) >>> 0));
    trainer = new Trainer(net, cfg.batch);
    console.log(
      `fresh ${fs.n}→${cfg.hidden}→${cfg.hidden}→1 net — warm start: ${cfg.warmGames} games ` +
        `from the committed ${cfg.features} teacher, then self-play`,
    );
  } else {
    if (!cfg.resume || !existsSync(cfg.resume)) {
      throw new Error('pass --resume <checkpoint> (or --fresh to initialize a new net)');
    }
    const ck = JSON.parse(readFileSync(cfg.resume, 'utf8')) as Checkpoint;
    if (ck.params.nIn !== fs.n) {
      throw new Error(`checkpoint nIn ${ck.params.nIn} does not match --features ${cfg.features} (${fs.n})`);
    }
    net = netFromParams(ck.params);
    trainer = new Trainer(net, cfg.batch);
    trainer.restore(ck.adam);
    episode = ck.episode;
    bestMean = ck.bestMean;
    bestParams = ck.bestParams;
    warmDone = ck.warmDone;
    curve = ck.curve;
    console.log(`resumed ${cfg.resume} @ ep ${episode} (best ${bestMean.toFixed(1)})`);
  }
  let bestEpisode = episode;
  console.log(
    `${cfg.workers} workers × chunk ${cfg.chunk}, features ${cfg.features}, target ${cfg.episodes}, patience ${cfg.patience}`,
  );

  const t0 = performance.now();
  const elapsedSec = () => (performance.now() - t0) / 1000;
  const trainRng = mulberry32((cfg.seed ^ 0x517cc1b7) >>> 0);
  const epsAt = (ep: number) => {
    const f = Math.min(1, ep / Math.max(1, cfg.episodes * cfg.epsFrac));
    return cfg.epsStart + (cfg.epsEnd - cfg.epsStart) * f;
  };
  const lrAt = (ep: number) =>
    ep < cfg.episodes * 0.6 ? cfg.lr : ep < cfg.episodes * 0.85 ? cfg.lr / 2 : cfg.lr / 4;

  const evalNet = (): { mean: number; std: number } => {
    const ctx = createEvalCtx(net);
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < cfg.evalGames; i++) {
      const rng = mulberry32((cfg.evalSeed + i * 2654435761) >>> 0);
      const s = newGame(v);
      for (;;) {
        const node = getPending(s, v);
        if (node.kind === 'over') break;
        if (node.kind === 'chance') {
          resolveChanceMut(s, v, rng);
          continue;
        }
        applyActionMut(s, v, fs.choose(ctx, s, v, node.actions));
      }
      const sc = scoreState(s, v).total;
      sum += sc;
      sq += sc * sc;
    }
    const mean = sum / cfg.evalGames;
    return { mean, std: Math.sqrt(Math.max(0, sq / cfg.evalGames - mean * mean)) };
  };

  const fullParams = (): TdNetParams => ({
    nIn: net.nIn,
    nH1: net.nH1,
    nH2: net.nH2,
    W1: Array.from(net.W1),
    b1: Array.from(net.b1),
    W2: Array.from(net.W2),
    b2: Array.from(net.b2),
    W3: Array.from(net.W3),
    b3: net.b3[0],
  });

  const saveCheckpoint = () => {
    const out: Checkpoint = {
      episode,
      warmDone,
      params: fullParams(),
      adam: trainer.snapshot(),
      bestMean,
      bestParams,
      curve,
    };
    writeFileSync(cfg.checkpoint, JSON.stringify(out));
  };

  let tdErrAvg = 0;
  let stop = false;
  let lastEvalAt = episode;

  const runEval = () => {
    const { mean, std } = evalNet();
    const sec = elapsedSec();
    curve.push({ ep: episode, mean, std, tdErr: tdErrAvg, sec });
    const star = mean > bestMean ? '  ← best' : '';
    console.log(
      `ep ${String(episode).padStart(6)}  eval ${mean.toFixed(1)} ± ${std.toFixed(1)}  tdErr ${tdErrAvg.toFixed(4)}  ${sec.toFixed(0)}s  (${rate().toFixed(0)} eps/s)${star}`,
    );
    if (mean > bestMean) {
      bestMean = mean;
      bestParams = paramsFromNet(net);
      bestEpisode = episode;
    }
    saveCheckpoint();
    if (episode - bestEpisode >= cfg.patience) {
      console.log(`no improvement in ${episode - bestEpisode} episodes — early stop`);
      stop = true;
    }
  };

  const startEp = episode;
  const rate = () => (episode - startEp) / Math.max(1, elapsedSec());

  const workerFile = fileURLToPath(import.meta.url);
  const workers = Array.from(
    { length: cfg.workers },
    () =>
      new Worker(workerFile, {
        workerData: { features: cfg.features, seed: cfg.seed, lambda: cfg.lambda } satisfies WorkerInit,
        execArgv: ['--import', 'tsx'],
      }),
  );

  let dispatched = episode; // next self-play episode index to hand out
  let warmDispatched = 0;
  let warmTrained = 0;
  const dispatch = (w: Worker) => {
    if (!warmDone) {
      const msg: WarmTaskMsg = { type: 'warm', gameStart: warmDispatched, count: cfg.chunk };
      warmDispatched += cfg.chunk;
      w.postMessage(msg);
      return;
    }
    const msg: TaskMsg = {
      type: 'task',
      tensors: [net.W1, net.b1, net.W2, net.b2, net.W3, net.b3].map((t) => t.slice()),
      dims: { nIn: net.nIn, nH1: net.nH1, nH2: net.nH2 },
      epStart: dispatched,
      count: cfg.chunk,
      epsilon: epsAt(dispatched),
    };
    dispatched += cfg.chunk;
    w.postMessage(msg);
  };

  await new Promise<void>((resolve) => {
    let idle = 0;
    const done = () => {
      idle++;
      if (idle === workers.length) resolve();
    };
    for (const w of workers) {
      w.on('message', (msg: ResultMsg) => {
        for (const ep of msg.episodes) {
          if (msg.warm) {
            const err = trainer.trainPass(ep.states, ep.targets, cfg.lrWarm, trainRng);
            tdErrAvg = tdErrAvg === 0 ? err : tdErrAvg * 0.98 + err * 0.02;
            warmTrained++;
          } else {
            const err = trainer.trainPass(ep.states, ep.targets, lrAt(episode), trainRng);
            tdErrAvg = tdErrAvg === 0 ? err : tdErrAvg * 0.995 + err * 0.005;
            episode++;
          }
        }
        if (msg.warm) {
          if (warmTrained % 512 < cfg.chunk) {
            console.log(`  warm ${warmTrained}/${cfg.warmGames}  tdErr ${tdErrAvg.toFixed(4)}  ${elapsedSec().toFixed(0)}s`);
          }
          if (!warmDone && warmTrained >= cfg.warmGames) {
            warmDone = true;
            runEval();
          }
        }
        if (warmDone && episode - lastEvalAt >= cfg.evalEvery) {
          lastEvalAt = episode;
          runEval();
        }
        if (stop || episode >= cfg.episodes || elapsedSec() > cfg.minutes * 60) {
          done();
        } else {
          dispatch(w);
        }
      });
      w.on('error', (e) => {
        console.error('worker error:', e);
        done();
      });
      dispatch(w);
    }
  });

  for (const w of workers) void w.terminate();
  runEval();

  const final = bestParams ?? paramsFromNet(net);
  const arr = (a: number[]) => `[${a.map((x) => Number(x.toPrecision(5))).join(',')}]`;
  const constName = cfg.features === 'v2' ? 'TDNET_V2_WEIGHTS' : 'TDNET_WEIGHTS';
  writeFileSync(
    cfg.out,
    `/**
 * Trained TD(λ) value-network weights — GENERATED by scripts/train-td-parallel.ts.
 * ${episode} episodes (features ${cfg.features}, λ=${cfg.lambda}, seed ${cfg.seed}), best frozen eval ${bestMean.toFixed(1)} on ${cfg.evalGames} games @ seed ${cfg.evalSeed}.
 */
import type { TdNetParams } from './tdnet';

export const ${constName}: TdNetParams = {
  nIn: ${final.nIn},
  nH1: ${final.nH1},
  nH2: ${final.nH2},
  W1: ${arr(final.W1)},
  b1: ${arr(final.b1)},
  W2: ${arr(final.W2)},
  b2: ${arr(final.b2)},
  W3: ${arr(final.W3)},
  b3: ${Number(final.b3.toPrecision(5))},
};
`,
  );
  console.log(`\nwrote ${cfg.out} (best eval ${bestMean.toFixed(1)}), checkpoint ${cfg.checkpoint}`);
  console.log('curve:', curve.map((c) => `${c.ep}:${c.mean.toFixed(1)}`).join(' '));
}

if (isMainThread) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
