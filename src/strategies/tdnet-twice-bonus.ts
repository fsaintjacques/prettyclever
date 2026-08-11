/**
 * Twice-as-Clever TD net + the bonus-economy block that broke the base game's
 * plateau (see tdnet-bonus.ts). The Twice encoding already carries banked
 * action-bar thermometers, so this appends only the chase signals:
 *
 *  - 9: "one-away" counts per bonus kind — groups (silver columns, yellow
 *    lattice rows/cols) exactly one cell from firing (capped 2, /2). Kinds:
 *    reroll, +1, return, fox, free-silver, free-yellow, free-blue,
 *    free-green, free-pink.
 *  - 9: write-track pull per kind — Σ 1/(1+d) over bonus-carrying slots at
 *    distance d from each track's next fill (capped 1).
 *  - 1: completed bonus-carrying groups, /12.
 *
 * 19 extra features, 271 total. Weights are trained by
 * scripts/train-td-parallel.ts --features twicebonus (transplant recipe:
 * start from the committed Twice net with new rows zero-initialized).
 */
import {
  applyAction,
  getPending,
  scoreState,
  type Action,
  type Effect,
  type GameState,
  type VariantDef,
} from '../engine';
import type { Strategy } from './types';
import {
  createEvalCtx,
  forward,
  netFromParams,
  type EvalCtx,
  type TdNetParams,
} from './tdnet';
import { extractFeaturesTwice, TDT_FEATURES, TDT_SCALE } from './tdnet-twice';
import { TDNET_TWICE_BONUS_WEIGHTS } from './tdnet-twice-bonus-weights';

export const TDTB_FEATURES = TDT_FEATURES + 19;

const FREE_CHANNEL: Record<string, number> = {
  silver: 4,
  yellow: 5,
  blue: 6,
  green: 7,
  pink: 8,
};

/** Bonus-kind channel of an effect, or -1 if untracked. */
function kindOf(e: Effect): number {
  switch (e.t) {
    case 'reroll':
      return 0;
    case 'plus1':
      return 1;
    case 'return':
      return 2;
    case 'fox':
      return 3;
    case 'free':
      return FREE_CHANNEL[e.area] ?? -1;
    case 'silverMark':
      return 4;
    default:
      return -1;
  }
}

export function extractFeaturesTwiceBonus(s: GameState, v: VariantDef, x: Float64Array): void {
  extractFeaturesTwice(s, v, x); // zero-fills, writes [0, TDT_FEATURES)
  const k = TDT_FEATURES;
  const oneAway = k;
  const pull = k + 9;
  let completed = 0;
  for (const area of v.areas) {
    const cells = s.areas[area.id];
    const ui = area.ui;

    if (ui.groups) {
      for (const g of ui.groups) {
        if (!g.bonus) continue;
        const kind = kindOf(g.bonus);
        if (kind < 0) continue;
        let done = 0;
        for (const c of g.cells) if (cells[c] !== 0) done++;
        if (done === g.cells.length) completed++;
        else if (done === g.cells.length - 1) x[oneAway + kind] = Math.min(1, x[oneAway + kind] + 0.5);
      }
    }

    if (ui.kind === 'track') {
      const next = cells.findIndex((c) => c === 0);
      if (next < 0) continue;
      for (let i = next; i < ui.cells.length; i++) {
        const b = ui.cells[i].bonus;
        if (!b) continue;
        const kind = kindOf(b);
        if (kind < 0) continue;
        x[pull + kind] = Math.min(1, x[pull + kind] + 1 / (1 + (i - next)));
      }
    }
  }
  x[k + 18] = Math.min(12, completed) / 12;
}

/** V/resolve/choose over the Twice bonus encoding. */
export function stateValueTwiceBonus(ctx: EvalCtx, s: GameState, v: VariantDef): number {
  if (s.phase === 'over') return scoreState(s, v).total / TDT_SCALE;
  extractFeaturesTwiceBonus(s, v, ctx.x);
  return forward(ctx.net, ctx.x, ctx.h1, ctx.h2);
}

export function resolvePendingByValueTwiceBonus(
  ctx: EvalCtx,
  s: GameState,
  v: VariantDef,
): GameState {
  let cur = s;
  let guard = 0;
  while (cur.pending.length > 0 && guard++ < 64) {
    const node = getPending(cur, v);
    if (node.kind !== 'decision') break;
    let best: GameState | null = null;
    let bestVal = -Infinity;
    for (const a of node.actions) {
      const ns = applyAction(cur, v, a);
      const val = stateValueTwiceBonus(ctx, ns, v);
      if (val > bestVal) {
        bestVal = val;
        best = ns;
      }
    }
    if (!best) break;
    cur = best;
  }
  return cur;
}

export function chooseByValueTwiceBonus(
  ctx: EvalCtx,
  s: GameState,
  v: VariantDef,
  actions: Action[],
): Action {
  let best = actions[0];
  let bestVal = -Infinity;
  for (const a of actions) {
    const ns = resolvePendingByValueTwiceBonus(ctx, applyAction(s, v, a), v);
    const val = stateValueTwiceBonus(ctx, ns, v);
    if (val > bestVal) {
      bestVal = val;
      best = a;
    }
  }
  return best;
}

export interface TdNetTwiceBonusOpts {
  params?: TdNetParams;
  name?: string;
}

export function makeTdNetTwiceBonus(opts: TdNetTwiceBonusOpts = {}): Strategy {
  const ctx = createEvalCtx(netFromParams(opts.params ?? TDNET_TWICE_BONUS_WEIGHTS));
  return {
    name: opts.name ?? 'td-net-bonus',
    choose(state, actions, c) {
      if (actions.length === 1) return actions[0];
      return chooseByValueTwiceBonus(ctx, state, c.variant, actions);
    },
  };
}
