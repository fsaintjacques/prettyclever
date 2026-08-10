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
 *  - --features v1|v2|twice selects the feature set/policy — and with it the
 *    variant, value scale and warm-start teacher (v1/v2: the committed nets on
 *    thats-pretty-clever; twice: the greedy baseline on twice-as-clever).
 *  - --spotlight <p> plays that fraction of episodes with an "area spotlight":
 *    the behavior policy gets +--spotlight-beta per filled cell of one random
 *    area from --spotlight-areas (default: all), generating coherent
 *    trajectories through regions the greedy argmax never visits. Targets
 *    stay unbiased; evals are always spotlight-free.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import {
  applyAction,
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
  makeTdNet,
  netFromParams,
  paramsFromNet,
  TD_FEATURES,
  type EvalCtx,
  type Net,
  type TdNetParams,
} from '../src/strategies/tdnet';
import {
  chooseByValueTwice,
  extractFeaturesTwice,
  makeTdNetTwice,
  TDT_FEATURES,
  TDT_SCALE,
} from '../src/strategies/tdnet-twice';
import { chooseByValue2, extractFeaturesV2, makeTdNetV2, TD2_FEATURES } from '../src/strategies/tdnetv2';
import {
  chooseByValueBonus,
  chooseByValueBonus2,
  chooseByValueBonus3,
  extractFeaturesBonus,
  extractFeaturesBonus2,
  extractFeaturesBonus3,
  TD_BONUS_FEATURES,
  TD_BONUS2_FEATURES,
  TD_BONUS3_FEATURES,
} from '../src/strategies/tdnet-bonus';
import {
  chooseByValueTwiceBonus,
  extractFeaturesTwiceBonus,
  TDTB_FEATURES,
} from '../src/strategies/tdnet-twice-bonus';
import { TDNET_WEIGHTS } from '../src/strategies/tdnet-weights';
import { TDNETV2_WEIGHTS } from '../src/strategies/tdnetv2-weights';
import type { Strategy } from '../src/strategies/types';

// ---------------------------------------------------------------------------
// Feature sets
// ---------------------------------------------------------------------------

interface FeatureSet {
  /** Variant the features are extracted from (and the games are played on). */
  variantId: string;
  n: number;
  /** Value-target scale: V learns score / scale. */
  scale: number;
  /** Exported const name of the generated weights module. */
  constName: string;
  extract: (s: GameState, v: VariantDef, x: Float64Array) => void;
  choose: (ctx: EvalCtx, s: GameState, v: VariantDef, actions: Action[]) => Action;
  /** Warm-start teacher for --fresh runs (committed net where one exists, else a baseline). */
  warmTeacher: () => Strategy;
}

const FEATURE_SETS: Record<string, FeatureSet> = {
  v1: {
    variantId: 'thats-pretty-clever',
    n: TD_FEATURES,
    scale: 300,
    constName: 'TDNET_WEIGHTS',
    extract: extractFeatures,
    choose: chooseByValue,
    warmTeacher: () => makeTdNet({ params: TDNET_WEIGHTS }),
  },
  v2: {
    variantId: 'thats-pretty-clever',
    n: TD2_FEATURES,
    scale: 300,
    constName: 'TDNET_V2_WEIGHTS',
    extract: extractFeaturesV2,
    choose: chooseByValue2,
    warmTeacher: () => makeTdNetV2({ params: TDNETV2_WEIGHTS }),
  },
  twice: {
    variantId: 'twice-as-clever',
    n: TDT_FEATURES,
    scale: TDT_SCALE,
    constName: 'TDNET_TWICE_WEIGHTS',
    extract: extractFeaturesTwice,
    choose: chooseByValueTwice,
    warmTeacher: () => makeTdNetTwice(),
  },
  // v1 + explicit bonus-economy block ("reward chasing"): banked unlocks,
  // one-away bonus groups per kind, track pull toward bonus slots. Warm-starts
  // from the committed v1 net's play (the teacher only generates games — its
  // features need not match).
  v1bonus: {
    variantId: 'thats-pretty-clever',
    n: TD_BONUS_FEATURES,
    scale: 300,
    constName: 'TDNET_BONUS_WEIGHTS',
    extract: extractFeaturesBonus,
    choose: chooseByValueBonus,
    warmTeacher: () => makeTdNet({ params: TDNET_WEIGHTS }),
  },
  // Twice net + the bonus-economy chase block (one-away per kind, track
  // pull, completed-group count); transplant from the committed Twice net.
  twicebonus: {
    variantId: 'twice-as-clever',
    n: TDTB_FEATURES,
    scale: TDT_SCALE,
    constName: 'TDNET_TWICE_BONUS_WEIGHTS',
    extract: extractFeaturesTwiceBonus,
    choose: chooseByValueTwiceBonus,
    warmTeacher: () => makeTdNetTwice(),
  },
  // v1bonus + landing-value features from the bonus-graph analysis:
  // write-landing potentials, orange multiplier timing, depth-2 cascade
  // fuses, fox-value fuse.
  v1bonus3: {
    variantId: 'thats-pretty-clever',
    n: TD_BONUS3_FEATURES,
    scale: 300,
    constName: 'TDNET_BONUS3_WEIGHTS',
    extract: extractFeaturesBonus3,
    choose: chooseByValueBonus3,
    warmTeacher: () => makeTdNet({ params: TDNET_WEIGHTS }),
  },
  // v1bonus + reachability-gated track bonuses and time-bucketed chase
  // signals (late green/orange/purple bonuses go dark when unreachable).
  v1bonus2: {
    variantId: 'thats-pretty-clever',
    n: TD_BONUS2_FEATURES,
    scale: 300,
    constName: 'TDNET_BONUS2_WEIGHTS',
    extract: extractFeaturesBonus2,
    choose: chooseByValueBonus2,
    warmTeacher: () => makeTdNet({ params: TDNET_WEIGHTS }),
  },
};

// ---------------------------------------------------------------------------
// Shared: sparse samples, λ-returns, episode generation
// ---------------------------------------------------------------------------

interface Sparse {
  // Uint16: feature sets above 255 inputs (e.g. twicebonus at 271) would
  // silently wrap Uint8 indices and corrupt every training sample.
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

/**
 * Spotlight exploration: in a fraction of episodes the *behavior* policy gets
 * a temporary bonus of `beta` (value-scale units) per filled cell in one
 * randomly chosen area, producing coherent whole-game trajectories that
 * develop regions the greedy argmax abandons (uniform ε only ever deviates
 * for a single step, which argmax immediately undoes). TD targets stay the
 * unbiased V of the states actually visited — the same no-importance-sampling
 * regime as ε-greedy.
 */
interface Spot {
  area: string;
  beta: number;
}

function filledCells(s: GameState, area: string): number {
  const cells = s.areas[area];
  let n = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i] !== 0) n++;
  return n;
}

/**
 * Spotlight bonus for a state. Real areas reward filled cells; the 'fox'
 * pseudo-area rewards the fox economy directly (raise the minimum area,
 * collect foxes) — β applies per point of minArea + foxPoints.
 */
function spotBonus(s: GameState, v: VariantDef, spot: Spot): number {
  if (spot.area === 'fox') {
    const br = scoreState(s, v);
    return spot.beta * (br.minArea + br.foxPoints);
  }
  return spot.beta * filledCells(s, spot.area);
}

function rawValue(fs: FeatureSet, ctx: EvalCtx, s: GameState, v: VariantDef): number {
  if (s.phase === 'over') return scoreState(s, v).total / fs.scale;
  fs.extract(s, v, ctx.x);
  return forward(ctx.net, ctx.x, ctx.h1, ctx.h2);
}

/** Biased afterstate value: resolve pending decisions by the same biased argmax. */
function spotValue(fs: FeatureSet, ctx: EvalCtx, s: GameState, v: VariantDef, spot: Spot): number {
  let cur = s;
  let guard = 0;
  while (cur.pending.length > 0 && guard++ < 64) {
    const node = getPending(cur, v);
    if (node.kind !== 'decision') break;
    let best: GameState | null = null;
    let bestVal = -Infinity;
    for (const a of node.actions) {
      const ns = applyAction(cur, v, a);
      const val = rawValue(fs, ctx, ns, v) + spotBonus(ns, v, spot);
      if (val > bestVal) {
        bestVal = val;
        best = ns;
      }
    }
    if (!best) break;
    cur = best;
  }
  return rawValue(fs, ctx, cur, v) + spotBonus(cur, v, spot);
}

function chooseSpot(
  fs: FeatureSet,
  ctx: EvalCtx,
  s: GameState,
  v: VariantDef,
  actions: Action[],
  spot: Spot,
): Action {
  let best = actions[0];
  let bestVal = -Infinity;
  for (const a of actions) {
    const val = spotValue(fs, ctx, applyAction(s, v, a), v, spot);
    if (val > bestVal) {
      bestVal = val;
      best = a;
    }
  }
  return best;
}

/**
 * The area a die action spends its die on (picks, passive picks, +1s), or null
 * for everything else. Bonus placements (free ?s, crossAny, platter chains) are
 * not dice and are never capped — the cap constrains dice, not points.
 */
function dieArea(a: Action): string | null {
  if (a.t !== 'pick' && a.t !== 'passivePick' && a.t !== 'plus1') return null;
  return a.placement?.area ?? null;
}

/** Per-area dice budget for a training game: area id → max dice (absent = unlimited). */
type Caps = Record<string, number>;

/** Drop die actions whose area budget is exhausted, when alternatives remain. */
function capActions(actions: Action[], caps: Caps, used: Record<string, number>): Action[] {
  if (Object.keys(caps).length === 0) return actions;
  const filtered = actions.filter((a) => {
    const area = dieArea(a);
    return area === null || caps[area] === undefined || (used[area] ?? 0) < caps[area];
  });
  return filtered.length > 0 ? filtered : actions;
}

function countDie(a: Action, used: Record<string, number>): void {
  const area = dieArea(a);
  if (area !== null) used[area] = (used[area] ?? 0) + 1;
}

function playEpisode(
  fs: FeatureSet,
  v: VariantDef,
  ctx: EvalCtx,
  rng: () => number,
  epsilon: number,
  lambda: number,
  spot: Spot | null,
  caps: Caps,
): EpisodeSamples {
  const s = newGame(v);
  const states: Sparse[] = [];
  const values: number[] = [];
  const used: Record<string, number> = {};
  for (;;) {
    const node = getPending(s, v);
    if (node.kind === 'over') break;
    if (node.kind === 'chance') {
      resolveChanceMut(s, v, rng);
      continue;
    }
    const acts = capActions(node.actions, caps, used);
    let a: Action;
    if (epsilon > 0 && rng() < epsilon) a = acts[Math.floor(rng() * acts.length)];
    else if (spot) a = chooseSpot(fs, ctx, s, v, acts, spot);
    else a = fs.choose(ctx, s, v, acts);
    countDie(a, used);
    applyActionMut(s, v, a);
    if (s.phase !== 'over') {
      fs.extract(s, v, ctx.x);
      states.push(toSparse(ctx.x));
      values.push(forward(ctx.net, ctx.x, ctx.h1, ctx.h2));
    }
  }
  const score = scoreState(s, v).total;
  return { states, targets: lambdaReturns(values, score / fs.scale, lambda), score };
}

// ---------------------------------------------------------------------------
// Worker side: play a chunk of episodes with a weight snapshot
// ---------------------------------------------------------------------------

interface WorkerInit {
  features: string;
  seed: number;
  lambda: number;
  /** Fraction of self-play episodes played with an area spotlight (0 = off). */
  spotProb: number;
  /** Behavior-policy bonus per filled spotlight-area cell, in value-scale units. */
  spotBeta: number;
  /** Areas the spotlight may land on. */
  spotAreas: string[];
  /** Per-area dice budgets for a training game (empty = uncapped). */
  caps: Caps;
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
  const v = getVariant(fs.variantId);
  let teacher: Strategy | null = null;
  parentPort!.on('message', (msg: TaskMsg | WarmTaskMsg | { type: 'exit' }) => {
    if (msg.type === 'exit') process.exit(0);
    const episodes: EpisodeSamples[] = [];
    if (msg.type === 'warm') {
      teacher ??= fs.warmTeacher();
      const scratch = new Float64Array(fs.n);
      for (let i = 0; i < msg.count; i++) {
        const rng = mulberry32((init.seed + 101 + (msg.gameStart + i) * 2654435761) >>> 0);
        const s = newGame(v);
        const states: Sparse[] = [];
        const sctx = { variant: v, rng };
        for (;;) {
          const node = getPending(s, v);
          if (node.kind === 'over') break;
          if (node.kind === 'chance') {
            resolveChanceMut(s, v, rng);
            continue;
          }
          applyActionMut(s, v, teacher.choose(s, node.actions, sctx));
          if (s.phase !== 'over') {
            fs.extract(s, v, scratch);
            states.push(toSparse(scratch));
          }
        }
        const score = scoreState(s, v).total;
        episodes.push({ states, targets: states.map(() => score / fs.scale), score });
      }
    } else {
      const [W1, b1, W2, b2, W3, b3] = msg.tensors;
      const net: Net = { ...msg.dims, W1, b1, W2, b2, W3, b3 };
      const ctx = createEvalCtx(net);
      for (let i = 0; i < msg.count; i++) {
        const ep = msg.epStart + i;
        const rng = mulberry32((init.seed ^ (ep * 2654435761 + 7)) >>> 0);
        const spot: Spot | null =
          init.spotProb > 0 && rng() < init.spotProb
            ? { area: init.spotAreas[Math.floor(rng() * init.spotAreas.length)], beta: init.spotBeta }
            : null;
        episodes.push(playEpisode(fs, v, ctx, rng, msg.epsilon, init.lambda, spot, init.caps));
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
  curve: {
    ep: number;
    mean: number;
    std: number;
    tdErr: number;
    sec: number;
    areas?: Record<string, number>;
  }[];
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
    spotlight: num('spotlight', 0),
    spotlightBeta: num('spotlight-beta', 0.01),
    spotlightAreas: args['spotlight-areas'],
    cap: args.cap,
    capYellow: num('cap-yellow', 0),
    resume: args.resume,
    checkpoint: args.checkpoint ?? 'checkpoints/td-parallel.json',
    out: args.out ?? 'checkpoints/tdnet-weights-parallel.ts',
  };
  const fs = FEATURE_SETS[cfg.features];
  if (!fs) throw new Error(`unknown feature set '${cfg.features}' (${Object.keys(FEATURE_SETS).join(' | ')})`);
  const v = getVariant(fs.variantId);
  const spotAreas = cfg.spotlightAreas ? cfg.spotlightAreas.split(',') : v.areas.map((a) => a.id);
  for (const id of spotAreas) {
    if (id !== 'fox' && !v.areas.some((a) => a.id === id)) {
      throw new Error(`--spotlight-areas: unknown area '${id}'`);
    }
  }

  // --cap area:k[,area:k...]; --cap-yellow k is the legacy single-area form.
  const caps: Caps = {};
  if (cfg.capYellow > 0) caps.yellow = cfg.capYellow;
  for (const part of (cfg.cap ?? '').split(',').filter(Boolean)) {
    const [area, k] = part.split(':');
    if (!v.areas.some((a) => a.id === area)) throw new Error(`--cap: unknown area '${area}'`);
    if (!Number.isFinite(Number(k))) throw new Error(`--cap: bad budget in '${part}'`);
    caps[area] = Number(k);
  }

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
    `${cfg.workers} workers × chunk ${cfg.chunk}, features ${cfg.features}, target ${cfg.episodes}, patience ${cfg.patience}` +
      (cfg.spotlight > 0
        ? `, spotlight ${cfg.spotlight} × β${cfg.spotlightBeta} on [${spotAreas.join(',')}]`
        : '') +
      (Object.keys(caps).length > 0
        ? `, dice caps ${Object.entries(caps).map(([a, k]) => `${a}:${k}`).join(',')}`
        : ''),
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

  const evalNet = (): { mean: number; std: number; areas: Record<string, number> } => {
    const ctx = createEvalCtx(net);
    let sum = 0;
    let sq = 0;
    const areaSum: Record<string, number> = { fox: 0 };
    for (const a of v.areas) areaSum[a.id] = 0;
    for (let i = 0; i < cfg.evalGames; i++) {
      const rng = mulberry32((cfg.evalSeed + i * 2654435761) >>> 0);
      const s = newGame(v);
      const used: Record<string, number> = {};
      for (;;) {
        const node = getPending(s, v);
        if (node.kind === 'over') break;
        if (node.kind === 'chance') {
          resolveChanceMut(s, v, rng);
          continue;
        }
        const a = fs.choose(ctx, s, v, capActions(node.actions, caps, used));
        countDie(a, used);
        applyActionMut(s, v, a);
      }
      const br = scoreState(s, v);
      sum += br.total;
      sq += br.total * br.total;
      for (const a of v.areas) areaSum[a.id] += br.areas[a.id];
      areaSum.fox += br.foxPoints;
    }
    const mean = sum / cfg.evalGames;
    const areas = Object.fromEntries(Object.entries(areaSum).map(([k, x]) => [k, x / cfg.evalGames]));
    return { mean, std: Math.sqrt(Math.max(0, sq / cfg.evalGames - mean * mean)), areas };
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
    const { mean, std, areas } = evalNet();
    const sec = elapsedSec();
    curve.push({ ep: episode, mean, std, tdErr: tdErrAvg, sec, areas });
    const star = mean > bestMean ? '  ← best' : '';
    const areaStr = Object.entries(areas)
      .map(([k, x]) => `${k.slice(0, 2)} ${x.toFixed(1)}`)
      .join(' ');
    console.log(
      `ep ${String(episode).padStart(6)}  eval ${mean.toFixed(1)} ± ${std.toFixed(1)}  [${areaStr}]  tdErr ${tdErrAvg.toFixed(4)}  ${sec.toFixed(0)}s  (${rate().toFixed(0)} eps/s)${star}`,
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

  // Worker threads do not reliably inherit the tsx loader across Node
  // versions, so boot each worker through a data-URL shim that registers tsx
  // in-thread before importing this .ts file.
  const tsxApi = import.meta.resolve('tsx/esm/api');
  const workerBootstrap = new URL(
    `data:text/javascript,${encodeURIComponent(
      `import { register } from ${JSON.stringify(tsxApi)}; register(); await import(${JSON.stringify(
        import.meta.url,
      )});`,
    )}`,
  );
  const workers = Array.from(
    { length: cfg.workers },
    () =>
      new Worker(workerBootstrap, {
        workerData: {
          features: cfg.features,
          seed: cfg.seed,
          lambda: cfg.lambda,
          spotProb: cfg.spotlight,
          spotBeta: cfg.spotlightBeta,
          spotAreas,
          caps,
        } satisfies WorkerInit,
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
  const constName = fs.constName;
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
