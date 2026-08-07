# Clever Lab

A browser implementation of **That's Pretty Clever** (*Ganz schön clever*,
Wolfgang Warsch) and its sequel **Twice as Clever**, built as a strategy
laboratory: a dependency-free TypeScript game engine, pluggable bots, headless
simulation, and a web UI to play, watch bots, and run batches.

The strongest bots are TD(λ) self-play value networks — **250.7** average on the
base game and **296.5** on Twice as Clever, against rulebook top tiers of 280
and 320.

```bash
npm install
npm run dev     # web UI at localhost:5173 — play, watch a bot, run simulations
npm test        # engine rules suite
```

## Simulating from the command line

```bash
# 1000 games of the trained net
npm run sim -- --strategy td-net --games 1000 --seed 11

# compare strategies on identical dice
npm run sim -- --strategy random,greedy,td-net --games 200

# the sequel
npm run sim -- --variant twice-as-clever --strategy td-net --games 500

# one game, turn-by-turn
npm run sim -- --strategy td-net --games 1 --verbose
```

| flag | default | meaning |
|---|---|---|
| `--variant` | `thats-pretty-clever` | also `twice-as-clever` |
| `--strategy` | `greedy` | comma-separated list to compare |
| `--games` | 200 | batch size |
| `--seed` | 1 | games are fully reproducible from this |
| `--opts` | — | JSON passed to the strategy, e.g. `'{"depth":4}'` |
| `--verbose` | off | single game with a turn log |

Output includes mean/median/p90, a score histogram, per-area means, fox
statistics, and the rulebook rating distribution.

## Using the engine as a library

The solo game is modeled as an explicit sequential decision process, so any
algorithm can drive it:

```ts
import {
  getVariant, newGame, getPending, applyAction, resolveChance, scoreState, mulberry32,
} from './src/engine';

const variant = getVariant('thats-pretty-clever');
const rng = mulberry32(42);
let s = newGame(variant);

for (;;) {
  const node = getPending(s, variant);
  if (node.kind === 'over') break;
  if (node.kind === 'chance') { s = resolveChance(s, variant, rng); continue; }
  s = applyAction(s, variant, node.actions[0]);   // your policy here
}

console.log(scoreState(s, variant).total);
```

- **Decision nodes** enumerate every legal `Action` — die picks with concrete
  placements, re-rolls, +1 actions, returns, bonus resolutions, turn ends.
- **Chance nodes** are dice rolls resolved by an injectable seeded RNG, so games
  replay exactly and search algorithms can sample.
- Bonus cascades resolve inside `applyAction`; any choice they raise (e.g.
  "cross any yellow cell") surfaces as an ordinary decision node.
- `applyActionMut` / `resolveChanceMut` / `cloneState` are the allocation-free
  variants for hot loops.

## Writing a strategy

A strategy is one function:

```ts
interface Strategy {
  name: string;
  choose(state: GameState, actions: Action[], ctx: { variant; rng }): Action;
}
```

Register it in `src/strategies/index.ts` and it appears in both the CLI and the
UI. Variant-agnostic algorithms go in `globalStrategies`; entries whose weights
were tuned or learned for one sheet go under that variant's key in
`variantStrategies`.

Bundled strategies: `random`, `greedy`, `planner`, `mc`, `mc-greedy`,
`expectimax`, `mcts` (all variant-agnostic), plus tuned and learned entries per
variant — see `strategiesFor(variantId)`.

## Adding a variant

A variant is data: dice colors, round bonuses, and a list of areas built from
the factories in `src/engine/areas.ts` (cross grids with group bonuses,
threshold and descend tracks, write tracks with multipliers, ascending tracks,
two-state lattices, subtraction-pair tracks). Write a file like
`src/engine/variants/thats-pretty-clever.ts`, register it in
`variants/index.ts`, and the UI renders the sheet generically from each area's
`ui` metadata — no UI code required.

## Training a value network

The bundled nets are TD(λ) afterstate value functions: `V(state)` only, no
action encoding, policy = argmax over afterstates. Weights ship as generated
modules (`src/strategies/tdnet-weights.ts` and friends), so nothing needs
training to use the bots.

To train your own:

```bash
# fresh net, warm-started from the committed teacher, then self-play
npx tsx scripts/train-td-parallel.ts --features twice --fresh \
  --checkpoint checkpoints/mine.json --out checkpoints/mine-weights.ts \
  --episodes 500000 --workers 5 --chunk 64

# resume; ship a checkpoint's best net without stopping training
npx tsx scripts/train-td-parallel.ts --features twice --resume checkpoints/mine.json ...
npx tsx scripts/export-weights.ts checkpoints/mine.json \
  src/strategies/tdnet-twice-weights.ts TDNET_TWICE_WEIGHTS
```

Useful flags: `--features v1|v2|twice`, `--episodes`, `--patience` (early stop),
`--workers`/`--chunk` (parallelism and weight-refresh granularity), `--lr`,
`--eps-start`/`--eps-end`, `--eval-games`/`--eval-seed`, `--hidden`.

Two exploration controls exist because plain self-play can collapse onto one
scoring engine and stay there (see [findings](docs/FINDINGS.md)):

- `--spotlight <p>` plays a fraction of episodes with the behavior policy biased
  toward one random area from `--spotlight-areas` (the pseudo-area `fox` biases
  toward `minArea + foxPoints`). Targets stay unbiased; evals are never biased.
- `--cap area:k[,area:k]` limits how many *dice* a training game may spend on an
  area, as a curriculum. Bonus placements are never capped.

Other tools: `scripts/train-td.ts` (serial reference implementation),
`scripts/optimize.ts` and `optimize-planner.ts` (CEM weight search),
`scripts/tune.ts` (paired-seed grid search), `scripts/hindsight.ts` (clairvoyant
upper bound and efficiency metric).

## Benchmarks

That's Pretty Clever — rulebook tiers: 140 "not bad", 200 "hats off",
240 "what a genius", 280+ "so clever".

| strategy | mean ± std | p90 | ms/game |
|---|---|---|---|
| **td-net** | **250.7 ± 22.5** | 275 | 10 |
| expectimax-tuned | 183.8 ± 35.2 | 230 | 307 |
| planner-tuned | 170.0 ± 36.9 | 222 | 0.9 |
| greedy-tuned | 165.9 ± 36.6 | 224 | 0.8 |
| greedy | 139.3 ± 22.0 | 169 | 1 |
| random | 58.7 ± 17.0 | 83 | 0.1 |

Twice as Clever — rating tops out at 320 "Twice as clever!".

| strategy | mean ± std | p90 | ms/game |
|---|---|---|---|
| **td-net** | **296.5 ± 35.9** | 340 | 20 |
| mc | 159.2 ± 23.9 | 193 | ~100 |
| greedy | 101.8 ± 23.0 | 132 | ~1 |
| random | 63.6 ± 15.1 | 84 | 0.1 |

Held-out seeds confirm every learned entry. The full ladder, the ceiling
analysis, and the negative results are in [docs/FINDINGS.md](docs/FINDINGS.md).

## Layout

```
docs/RULES.md          annotated solo rules + exact sheet data (engine ground truth)
docs/RULES-TWICE.md    the same for Twice as Clever
docs/FINDINGS.md       research notes: results, negative results, methodology
src/engine/            pure game engine, no dependencies
  types.ts             core types; the decision-process contract
  areas.ts             reusable area factories
  variants/            sheet definitions
  game.ts              solo state machine: getPending / applyAction / resolveChance
  score.ts             scoring + rating tables
src/strategies/        bots, tuned weights, trained networks
src/sim/               headless runner, stats, CLI
src/ui/                React app (Play / Watch / Simulate, worker-backed sims)
scripts/               training, tuning, and analysis tools
tests/                 vitest rules suite
```

## Rules

`docs/RULES.md` and `docs/RULES-TWICE.md` document the full solo rules, exact
sheet layouts verified against the official rulebooks, and the engine's rulings
on ambiguous cases (wasted picks, forfeited rolls, platter tie-breaks, return
timing).

---

Game design by Wolfgang Warsch, published by Schmidt Spiele. Unofficial
fan-made implementation for personal strategy research; not affiliated with or
endorsed by the publisher.
