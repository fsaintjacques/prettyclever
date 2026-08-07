# Findings

Research notes from building bots for the solo game. The headline results are
summarized in the README; this document keeps the evidence, the negative
results, and the methodology traps that cost real time.

All numbers are means over 500-game held-out batches unless stated otherwise.

## Strategy ladder (That's Pretty Clever)

| strategy | mean ± std | p90 | ms/game | idea |
|---|---|---|---|---|
| **td-net** | **250.7 ± 22.5** | 275 | 10 | TD(λ) self-play value network, afterstate argmax, 240k episodes |
| td-net-v2 | 249.7 ± 22.4 | 275 | 12 | td-net + phase-gated die-face features — a statistical tie at equal budget |
| expectimax-net | ~237 | 269 | ~3300 | depth-3 expectimax with the TD net as leaf |
| expectimax-tuned | 183.8 ± 35.2 | 230 | 307 | expectimax with CEM weights as leaf eval |
| planner-tuned | 170.0 ± 36.9 | 222 | 0.9 | joint CEM over planner knobs + eval weights |
| mcts | 169.4 ± 25.5 | 204 | 211 | UCT, open-loop chance sampling, truncated rollouts |
| greedy-tuned | 165.9 ± 36.6 | 224 | 0.8 | greedy with CEM-optimized weights |
| expectimax | 165.1 ± 31.1 | 204 | 154 | depth-3, 3 sampled rolls per chance node |
| planner | 156.4 ± 30.1 | 196 | 0.7 | expert rule layers over the greedy eval |
| mc | ~150 | — | 90 | flat Monte-Carlo, random rollouts |
| greedy | 139.3 ± 22 | 169 | 1 | one-step lookahead over `evaluate(state, weights)` |
| random | 58.7 ± 17 | 83 | 0.1 | floor |

The single biggest hand-written-eval discovery was `poolDieEV`: picking a high
die locks every lower die onto the platter, so the *cost* of a pick dominates
its face value. Adding that term alone moved greedy from 139 to ~166 under CEM.

## The base game's ~250 is a genuine plateau

Three architectures — 128×128 with 163 features, 128×128 with 216 face-aware
features, and 256×256 with 216 features (384k episodes) — all converge to
250–251 held-out and resist further training. So capacity is not binding.

The sharper objection is that all three shared one *self-play procedure*, so
they could share one exploration basin (as Twice as Clever did, below). Tested
directly:

- A fox-targeted spotlight from the committed net reproduces the incumbent's
  area allocation almost digit for digit (yellow 19.9 vs 19.8, blue 50.8 vs
  49.8, fox 71.0 vs 70.6) and lands at 250.7 / 248.2 — a tie, no reallocation.
- Forcing a reallocation with `--cap blue:5,green:5,orange:5` makes it strictly
  worse: 221 under the cap, 227.9 with the cap lifted, and it does not revert
  to blue-heavy play afterwards.

One thing that *looks* pathological is correct play: the net spends only 0.38
dice per game on yellow, feeding that area almost entirely from bonus crosses.

**Remaining headroom: ~9%.** `scripts/hindsight.ts` scores 252.4 against a
clairvoyant 278.4 over 20 worlds — 90.8% efficiency. Since the solver is a
beam search, that bound is a lower bound on the true optimum.

## Twice as Clever: a 55-point local optimum, and how it broke

Plain self-play TD converged to pouring ~140 points into yellow's convex
crossing table (10 crosses = 165) for a ~220 mean. Two diagnostics showed this
was distribution collapse rather than insight:

- A **yellow-forbidden ablation** scored 116 — *below* flat Monte-Carlo's 159.
  Outside its own trajectory distribution the value function was worse than
  random rollouts, so it could not price the alternatives it was declining.
- Fox points sat at 6.2 (3.4 foxes × a starved ~2 minimum area), versus 70+ in
  the base game.

What did **not** work: spotlight episodes alone (+4.5). Uniform ε-greedy is
worse still — a single random action is immediately undone by the argmax.

What **did** work was a curriculum constraint. `--cap yellow:k` limits the
*dice* a training game may spend on yellow (bonus `?`s stay free):

| stage | held-out | fox pts | ablation |
|---|---|---|---|
| plain self-play | 216.4 | 6.2 | 116 |
| + spotlight | 220.5 | 7.4 | 124 |
| + cap 4 | 239.6 | 49 | — |
| + cap 8 + fox spotlight | 274.4 | 86 | 172 |
| + uncapped continuation | 286.2 | 88 | — |
| + polish (ε 0.08 → 0.01) | **296.5** | 95 | — |

The cap is pure scaffolding: at inference, capped and uncapped play are
identical — the net *chooses* few yellow dice once it knows what balance is
worth. Removing the cap mid-training caused no relapse.

The learned regime matches community folklore for this sheet: balance every
area, hold the minimum near 30 (one forum player's advice was literally "28
should be your lowest total"), and multiply it with ~3.4 foxes — ~95 points,
the largest single contributor on the sheet.

Final polish note: the curve "flattened" at 750k only because ε was pinned at
0.08 from the escape phase. Annealing it to 0.01 with a halved learning rate
added ~10 more points. *A flat curve is a statement about the current
hyperparameters, not about the model.*

Hindsight efficiency: 287.3 vs a clairvoyant 327.3 — 88.1%.

## Methodology traps worth knowing

**The hindsight bound depends on its heuristic.** The beam search is guided by
a value net, so it explores what that net believes. Measured with the old
yellow-max net, the "clairvoyant optimum" for Twice was 250.6 — a number the
*policy* later beat outright. With the fox-regime net it is 327.3. Always
re-measure the bound when the guiding net changes; better, take the per-world
max over several heuristics.

**Best-net selection overfits the eval set.** The trainer ships whichever net
scores best on a fixed evaluation seed, which biases that score upward
(winner's curse). For Twice the frozen best was 300.8 while held-out was 296.5.
Widening the eval from 200 to 400 games shrank the gap; the honest number is
always the held-out batch on unused seeds. Sanity-checked on five never-used
seeds: 292.0 / 300.1 / 300.4 / 300.3 / 299.3 — mean 298.4, so the benchmark
seeds are if anything slightly pessimistic.

**The net cannot memorize dice.** Each episode draws its own stream, and the
features are face-blind with no episode identity, so there is no channel
through which a specific roll sequence could be learned. Seed leakage lives in
*evaluation*, not training.

## Where the time actually goes

Profiled per episode of Twice self-play (afterstate argmax, 1322 forward
passes per game):

| component | ms/game | share |
|---|---|---|
| network (feature extract + forward) | 12.85 | 86% |
| `applyAction` (clone + apply + cascades) | 1.68 | 11% |
| `getPending` (action enumeration) | 0.18 | 1% |
| other | 0.27 | 2% |

The engine is *not* the bottleneck, so a faster simulator buys at most ~1.14×.
The wins available are in evaluation: the input is only 32% dense (81 of 252
features nonzero), so a sparse first layer would cut the forward pass from
~48.8k to ~26.9k MACs, and batching the per-decision candidates would turn many
matrix-vector products into one matrix-matrix product.
