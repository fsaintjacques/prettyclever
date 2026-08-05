# Clever Lab

A local browser version of **That's Pretty Clever** (*Ganz schön clever*, Wolfgang
Warsch) built as a strategy laboratory: a pure TypeScript game engine with
automatic solo play, pluggable bot strategies, headless simulation, and a web UI
to play, watch bots, and run batches.

```
npm install
npm run dev        # web UI: play / watch a bot / simulate
npm test           # engine rules test suite
npm run sim -- --strategy random,greedy,mc --games 200 --seed 1
```

## Layout

```
docs/RULES.md        annotated rules + exact score-sheet data (engine ground truth)
src/engine/          pure game engine, no dependencies
  types.ts           core types; the decision-process contract
  areas.ts           reusable area factories (cross grid, threshold/write/ascend tracks)
  variants/          sheet definitions; standard.ts is the base game
  game.ts            solo state machine: getPending / applyAction / resolveChance
  score.ts           scoring + rating table
src/strategies/      random, greedy (tunable weights), flat Monte-Carlo
src/sim/             headless runner, stats, CLI
src/ui/              React app (Play / Watch / Simulate, worker-backed sims)
scripts/tune.ts      paired-seed weight grid search for the greedy evaluation
tests/               vitest rules suite
```

## The engine as a decision process

The solo game is modeled as an explicit sequential decision process so that any
algorithm can drive it:

```ts
import { standard, newGame, getPending, applyAction, resolveChance, mulberry32 } from './src/engine';

const rng = mulberry32(seed);
let s = newGame(standard);
for (;;) {
  const node = getPending(s, standard);
  if (node.kind === 'over') break;
  if (node.kind === 'chance') { s = resolveChance(s, standard, rng); continue; }
  s = applyAction(s, standard, choose(node.actions)); // your policy here
}
```

- **Decision nodes** enumerate every legal `Action` (die picks with concrete
  placements, re-roll, +1 actions, bonus-choice resolutions, turn ends).
- **Chance nodes** are dice rolls, resolved by an injectable seeded RNG —
  games are fully reproducible from a seed, and search algorithms can sample.
- Bonus cascades (row/column completions, chained bonuses) resolve inside
  `applyAction`; choices they raise (e.g. "cross any yellow cell") surface as
  ordinary decision nodes.
- `applyActionMut` / `resolveChanceMut` / `cloneState` exist for hot loops.

## Strategies

A strategy is one function:

```ts
interface Strategy {
  name: string;
  choose(state: GameState, actions: Action[], ctx: { variant; rng }): Action;
}
```

Register it in `src/strategies/index.ts` and it appears in the CLI and the UI.

Current leaderboard (seed 11; fast strategies 400–1000 games, slow ones 100–200):

| strategy | mean ± std | p90 | ms/game | idea |
|---|---|---|---|---|
| mcts | 169.4 ± 25.5 | 204 | 211 | UCT, open-loop chance sampling, truncated rollouts + eval leaf |
| greedy-tuned | 165.9 ± 36.6 | 224 | 0.8 | greedy with CEM-optimized weights (`scripts/optimize.ts`) |
| expectimax | 165.1 ± 31.1 | 204 | 154 | depth-3, 3 sampled rolls per chance node, top-M pruning |
| planner | 156.4 ± 30.1 | 196 | 0.7 | expert rule layers (purple 6-chains, per-die pool value, dynamic re-roll) over the greedy eval |
| mc | ~150 | — | 90 | flat Monte-Carlo, random rollouts |
| greedy | 139.3 ± 22 | 169 | 1 | one-step lookahead over `evaluate(state, weights)` |
| random | 58.7 ± 17 | 83 | 0.1 | floor |

Solo benchmark from the rulebook: 140 "not bad", 200 "hats off", 280+ "so
clever". There is plenty of headroom — that's the point of the lab. Obvious
next experiments: feed `TUNED_WEIGHTS` into expectimax/mcts/planner (all
three currently search over the *default* eval), re-run the CEM optimizer on
the planner's knobs, and stack MCTS on the tuned eval as its leaf/rollout
value.

## Variants

A variant is data: dice colors, round bonuses, and a list of areas built from
the factories in `src/engine/areas.ts` (cross-grids with group bonuses,
threshold tracks, write tracks with multipliers, ascending tracks with a reset
value). See `src/engine/variants/standard.ts` for the complete standard sheet;
adding *Twice as Clever* / *Clever Cubed* means writing a similar file (plus a
new area factory if a mechanic is genuinely new) and registering it in
`src/engine/variants/index.ts`. The UI renders sheets generically from the
area `ui` metadata.

## Rules notes

`docs/RULES.md` documents the full solo rules, the exact sheet layout
(verified against the official rulebook scan), and the engine's rulings on the
few ambiguous cases (wasted picks, forfeited rolls, platter tie-breaks).

Game design by Wolfgang Warsch, published by Schmidt Spiele. Unofficial
fan-made implementation for personal strategy research.
