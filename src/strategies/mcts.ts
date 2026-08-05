/**
 * MCTS (UCT) over the engine's decision process.
 *
 * Tree policy: UCB1 over decision nodes; one new child is expanded per
 * iteration, then a rollout estimates the leaf value.
 *
 * Chance handling: open-loop. A roll of up to six dice has ~6^6 distinct
 * outcomes (plus platter tie-breaks), so materializing chance children —
 * even with progressive widening — would dilute visit counts to n≈1 per
 * outcome at any feasible budget. Instead the tree is keyed only by the
 * action sequence from the root: every descent replays the path on a clone
 * of the root state and re-samples each chance node with the search RNG, so
 * a node's statistics pool over roll realizations and converge on the
 * *expectation* over rolls. Children are matched to the currently legal
 * actions by a canonical action key, so a child is only ever selected in
 * realizations where its action is legal. Note that the decision burst
 * before the next roll (pending bonus choices, remaining picks of the same
 * roll) is deterministic, so near the root open-loop equals closed-loop;
 * divergence only starts past the next roll, exactly where pooling helps.
 *
 * Rollout policy: uniform random (skipping wasted picks when a real
 * placement exists), truncated after `rolloutDepth` decisions and terminated
 * by the greedy `evaluate` from greedy.ts as a value estimate — full random
 * playouts are noisier and slower than a short lookahead plus a
 * potential-aware evaluation.
 *
 * Rewards are normalized to [0, 1] via fixed score bounds so the UCB
 * exploration constant has a stable meaning across the whole game.
 */
import {
  applyActionMut,
  cloneState,
  forkSeed,
  getPending,
  mulberry32,
  resolveChanceMut,
  scoreState,
  type Action,
  type GameState,
  type RNG,
  type VariantDef,
} from '../engine';
import { defaultWeights, evaluate, type Weights } from './greedy';
import type { Strategy } from './types';

export interface MctsOpts {
  /** Search iterations per decision. */
  iterations: number;
  /** UCB1 exploration constant (rewards are normalized to [0, 1]). */
  exploration: number;
  /** Random-rollout decision steps before falling back to evaluate(). */
  rolloutDepth: number;
  /** Reward normalization bounds (final scores are roughly 40–250). */
  minScore: number;
  maxScore: number;
  weights: Partial<Weights>;
  name?: string;
}

const defaults: MctsOpts = {
  iterations: 300,
  exploration: 0.7,
  rolloutDepth: 24,
  minScore: 40,
  maxScore: 260,
  weights: {},
};

interface TreeNode {
  action: Action;
  n: number; // visits
  w: number; // sum of normalized rewards
  children: Map<string, TreeNode>;
}

/** Canonical key for an action; equal keys imply identical actions. */
function actionKey(a: Action): string {
  switch (a.t) {
    case 'bonus':
      return `b:${a.cell ?? ''}:${a.option ?? ''}`;
    case 'reroll':
      return 'r';
    case 'skip':
      return 's';
    case 'endTurn':
      return 'e';
    case 'passiveSkip':
      return 'ps';
    case 'pick':
    case 'plus1':
    case 'passivePick': {
      const p = a.placement;
      return `${a.t}:${a.die}:${p ? `${p.area}:${p.cell}:${p.value}` : ''}`;
    }
  }
}

export function makeMcts(opts: Partial<MctsOpts> = {}): Strategy {
  const o = { ...defaults, ...opts };
  const w: Weights = { ...defaultWeights, ...o.weights };
  const span = o.maxScore - o.minScore;

  const norm = (raw: number): number => Math.min(1, Math.max(0, (raw - o.minScore) / span));

  /** Truncated uniform-random rollout, terminated by the greedy evaluation. */
  function rollout(s: GameState, v: VariantDef, rng: RNG): number {
    let steps = 0;
    let guard = 0;
    while (guard++ < 5000) {
      const node = getPending(s, v);
      if (node.kind === 'over') return norm(scoreState(s, v).total);
      if (node.kind === 'chance') {
        resolveChanceMut(s, v, rng);
        continue;
      }
      if (steps >= o.rolloutDepth) break;
      let acts = node.actions;
      if (acts.length > 1) {
        // Never waste a pick at random while a real placement exists.
        const placing = acts.filter((a) => !(a.t === 'pick' && !a.placement));
        if (placing.length > 0) acts = placing;
      }
      applyActionMut(s, v, acts[Math.floor(rng() * acts.length)]);
      steps++;
    }
    return norm(evaluate(s, v, w));
  }

  return {
    name: o.name ?? `mcts-${o.iterations}`,
    choose(state, actions, ctx) {
      if (actions.length === 1) return actions[0];
      const v = ctx.variant;
      const rng = mulberry32(forkSeed(ctx.rng));
      const root = new Map<string, TreeNode>();

      for (let it = 0; it < o.iterations; it++) {
        const s = cloneState(state);
        const path: TreeNode[] = [];
        let children = root;
        let acts: Action[] | null = actions;
        let value = 0;
        let guard = 0;

        // Selection / expansion.
        for (;;) {
          if (guard++ > 1000) {
            value = norm(evaluate(s, v, w));
            break;
          }
          if (acts === null) {
            const node = getPending(s, v);
            if (node.kind === 'over') {
              value = norm(scoreState(s, v).total);
              break;
            }
            if (node.kind === 'chance') {
              resolveChanceMut(s, v, rng);
              continue;
            }
            acts = node.actions;
          }

          let untried: Action[] | null = null;
          for (const a of acts) {
            if (!children.has(actionKey(a))) (untried ??= []).push(a);
          }
          if (untried) {
            // Expand one untried child, then estimate it with a rollout.
            const a = untried[Math.floor(rng() * untried.length)];
            const child: TreeNode = { action: a, n: 0, w: 0, children: new Map() };
            children.set(actionKey(a), child);
            path.push(child);
            applyActionMut(s, v, a);
            value = rollout(s, v, rng);
            break;
          }

          // UCB1 over the children legal in this realization.
          let total = 0;
          for (const a of acts) total += children.get(actionKey(a))!.n;
          const logTotal = Math.log(total + 1);
          let best: TreeNode | null = null;
          let bestU = -Infinity;
          for (const a of acts) {
            const c = children.get(actionKey(a))!;
            const u = c.w / c.n + o.exploration * Math.sqrt(logTotal / c.n);
            if (u > bestU) {
              bestU = u;
              best = c;
            }
          }
          path.push(best!);
          applyActionMut(s, v, best!.action);
          children = best!.children;
          acts = null;
        }

        for (const c of path) {
          c.n++;
          c.w += value;
        }
      }

      // Robust child: most visits, mean reward as tie-break.
      let best = actions[0];
      let bestN = -1;
      let bestMean = -Infinity;
      for (const a of actions) {
        const c = root.get(actionKey(a));
        if (!c || c.n === 0) continue;
        const mean = c.w / c.n;
        if (c.n > bestN || (c.n === bestN && mean > bestMean)) {
          best = c.action;
          bestN = c.n;
          bestMean = mean;
        }
      }
      return best;
    },
  };
}
