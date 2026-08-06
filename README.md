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
  variants/          sheet definitions; thats-pretty-clever.ts is the base game
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
import { thatsPrettyClever, newGame, getPending, applyAction, resolveChance, mulberry32 } from './src/engine';

const rng = mulberry32(seed);
let s = newGame(thatsPrettyClever);
for (;;) {
  const node = getPending(s, thatsPrettyClever);
  if (node.kind === 'over') break;
  if (node.kind === 'chance') { s = resolveChance(s, thatsPrettyClever, rng); continue; }
  s = applyAction(s, thatsPrettyClever, choose(node.actions)); // your policy here
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

Register it in `src/strategies/index.ts` and it appears in the CLI and the UI —
variant-agnostic algorithms go in `globalStrategies`, tuned/learned entries go
under their variant's key in `variantStrategies`.

Current leaderboard (seed 11; fast strategies 1000 games, slow ones 100–200;
held-out seeds confirm every tuned/learned entry):

| strategy | mean ± std | p90 | ms/game | idea |
|---|---|---|---|---|
| **td-net** | **250.7 ± 22.5** | 275 | 10 | TD(λ) self-play value network, afterstate argmax, 240k episodes (`scripts/train-td.ts`) |
| td-net-v2 | 249.7 ± 22.4 | 275 | 12 | td-net + phase-gated die-face features; statistical tie with v1 at an equal 240k-episode budget — at this width the face blind spot isn't what binds |
| expectimax-net | ~237 | 269 | ~3300 | depth-3 expectimax with the TD net as leaf — no longer beats raw td-net |
| expectimax-tuned | 183.8 ± 35.2 | 230 | 307 | expectimax with CEM weights as leaf eval |
| planner-tuned | 170.0 ± 36.9 | 222 | 0.9 | joint CEM over planner knobs + eval weights |
| mcts | 169.4 ± 25.5 | 204 | 211 | UCT, open-loop chance sampling, truncated rollouts + eval leaf |
| greedy-tuned | 165.9 ± 36.6 | 224 | 0.8 | greedy with CEM-optimized weights (`scripts/optimize.ts`) |
| expectimax | 165.1 ± 31.1 | 204 | 154 | depth-3, 3 sampled rolls per chance node, top-M pruning |
| planner | 156.4 ± 30.1 | 196 | 0.7 | expert rule layers over the greedy eval |
| mc | ~150 | — | 90 | flat Monte-Carlo, random rollouts |
| greedy | 139.3 ± 22 | 169 | 1 | one-step lookahead over `evaluate(state, weights)` |
| random | 58.7 ± 17 | 83 | 0.1 | floor |

Solo benchmark from the rulebook: 140 "not bad", 200 "hats off", 240 "what a
genius", 280+ "so clever". td-net's median game is 254; its best games clear
290 (max observed 301).

**The ~250 ceiling is the policy class, not the network.** Three
architectures — 128×128 with 163 features, 128×128 with 216 face-aware
features, and 256×256 with 216 features (trained to 384k episodes on the
parallel trainer) — all converge to 250–251 official / 251–253 frozen-eval,
and all resist further training (early-stops fire, late evals degrade).
One-ply afterstate argmax with a TD-learned value function of this family
appears to be worth ~250 points; the remaining distance to perfect play
lives in multi-ply search and/or better training signal, not capacity.

**How much actually remains: ~9%.** `scripts/hindsight.ts` determinizes a
seed into an action-independent face table (a clairvoyant "possible world"),
solves it with TD-net-guided beam search, and replays the same world with a
normal strategy. Over 20 worlds at beam 512, td-net scores 252.4 against a
clairvoyant 278.4 — **90.8% hindsight efficiency**. The beam result is a
lower bound on the true optimum, so real headroom is at least ~26 points.

### Twice as Clever (`--variant twice-as-clever`)

| strategy | mean ± std | p90 | ms/game | notes |
|---|---|---|---|---|
| **td-net** | **274.4 ± 34.2** | 317 | 20 | fox-economy regime: yellow-cap curriculum + fox spotlight (see below) |
| mc | 159.2 ± 23.9 | 193 | ~100 | flat Monte-Carlo |
| greedy | 101.8 ± 23.0 | 132 | ~1 | score-greedy (base-game shaping terms don't apply here) |
| random | 63.6 ± 15.1 | 84 | 0.1 | floor |

Rating table tops out at 320 "Twice as clever!" — the net now clears it in
~10% of games (max observed 394).

**The yellow engine was a ~55-point local optimum.** Plain self-play TD
converged to pouring ~140 points into yellow's convex crossing table
(10 crosses = 165) for a ~220 mean; a yellow-forbidden ablation scored 116 —
below flat Monte-Carlo — i.e. the value function knew nothing outside its
own trajectory distribution. Spotlight episodes alone (+4.5) softened but
never escaped the basin. What escaped it was a **curriculum constraint**:
`--cap-yellow k` limits the *dice* a training game may spend on yellow
(bonus ?s stay free) — retrained at k=4 the net rediscovered the fox
economy (239.5); at k=8 with a fox-targeted spotlight (`--spotlight-areas
...,fox`, β per point of minArea + foxPoints) it reached **277.2 frozen /
274.4 held-out**. The learned regime is exactly the strategy the Doppelt
community folklore describes: balance every area, keep the minimum high
(blue, ~30 — one Reddit player's advice was literally "28 should be your
lowest total"), and multiply it with 3.4 foxes (~86 points, the biggest
"area" on the sheet), funded by trimming yellow to ~38 and silver to its
platter-chain floor. The cap is pure scaffolding: at inference capped and
uncapped play are identical — the net now *chooses* few yellow dice. The
ablation progression tells the health story: 116 → 124 → **172** (mc: 159).
Checkpoint `checkpoints/td-twice-cap8.json`; the curve had still not
plateaued at 500k.

Hindsight efficiency (20 worlds, beam 512): td-net 287.3 vs clairvoyant
327.3 — **88.1%**. Re-running the instrument with the fox-regime net as
beam heuristic exposed how loose the old bound was: the previous
"clairvoyant optimum" of 250.6 (measured with the yellow-max heuristic,
which steered the beam into its own basin) is now beaten by the *policy*
outright. The current optimum plays the same fox economy but keeps more
yellow (57) and green (63) — evidence the blend can still improve.

## Variants

A variant is data: dice colors, round bonuses, and a list of areas built from
the factories in `src/engine/areas.ts` (cross-grids with group bonuses,
threshold tracks, write tracks with multipliers, ascending tracks with a reset
value). See `src/engine/variants/thats-pretty-clever.ts` for the complete base sheet;
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
