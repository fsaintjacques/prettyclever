# Findings

Research notes from building bots for the solo game. The headline results are
summarized in the README; this document keeps the evidence, the negative
results, and the methodology traps that cost real time.

All numbers are means over 500-game held-out batches unless stated otherwise.

## Strategy ladder (That's Pretty Clever)

| strategy | mean ± std | p90 | ms/game | idea |
|---|---|---|---|---|
| **td-net-bonus** | **260.0 ± 22.1** | 283 | 13 | td-net + an explicit bonus-economy block, transplant-refined |
| td-net | 250.7 ± 22.5 | 275 | 10 | TD(λ) self-play value network, afterstate argmax, 240k episodes |
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
| bonusman | 117.1 ± 18.2 | 141 | 0.7 | chases printed bonuses instead of points — the objective, minus the balance |
| random | 58.7 ± 17 | 83 | 0.1 | floor |

The single biggest hand-written-eval discovery was `poolDieEV`: picking a high
die locks every lower die onto the platter, so the *cost* of a pick dominates
its face value. Adding that term alone moved greedy from 139 to ~166 under CEM.

## The base game's ~250 was not a plateau

**This section previously concluded that it was.** The reasoning is preserved
because the *evidence* was sound and the *inference* was not, which is the
instructive part.

What was actually established: three architectures — 128×128 with 163 features,
128×128 with 216 face-aware features, and 256×256 with 216 features (384k
episodes) — all converge to 250–251 held-out and resist further training, so
**capacity is not binding**. And the exploration-collapse story that explained
Twice as Clever (below) does not apply here:

- A fox-targeted spotlight from the committed net reproduces the incumbent's
  area allocation almost digit for digit (yellow 19.9 vs 19.8, blue 50.8 vs
  49.8, fox 71.0 vs 70.6) and lands at 250.7 / 248.2 — a tie, no reallocation.
- Forcing a reallocation with `--cap blue:5,green:5,orange:5` makes it strictly
  worse: 221 under the cap, 227.9 with the cap lifted, and it does not revert
  to blue-heavy play afterwards.

What did *not* follow is that 250 was the ceiling. "Not capacity, not
exploration" left two candidates unexamined, and both turned out to hold points:

**The training schedule (~+6).** Every run peaks and then decays — `td-main`
best 253.4 at ep 172k of 240k; its own continuation `td-parallel` spent 164k
more episodes and fell to ~244; `td-256` best at 336k of 384k; `td-twice-300`
best at 1564k of 2074k. `lrAt` is keyed to `cfg.episodes`, the *declared budget*,
so decay timing is an artifact of what was typed on the command line rather than
of convergence, and ε sat on its 0.02 floor throughout. A schedule-matched
control on plain v1 features — nothing new learned, only ε annealed toward zero
with a reduced learning rate — reaches **256.4**. The same fix on Twice was worth
+10 (below); it is not variant-specific and it applies to every net here.

**The features (~+4).** On top of that schedule, the bonus-economy block reaches
**260.0 ± 22.1** (seed 11, 1000 games; 260.2 over 7 held-out seeds × 500, worst
seed 257.4), positive on every shared seed. See the next section.

A third mechanism is real but now unusable: **averaging independent nets.** A
value-level ensemble of the three ~251 base nets (average V, then the same
afterstate argmax) scored **255.3 vs 252.0 paired, +3.3 ± 0.7** over 1400
held-out games — beating every member, which means their argmax errors were
substantially uncorrelated. So part of the old plateau was estimator *variance*.
But averaging only helps among equal-strength peers: adding those same nets to
`td-net-bonus` now **costs** 5–6 points (−6.1 ± 1.0 for bonus+v1, −5.2 ± 0.9
adding the 256 net), because averaging a strong net with 10-point-weaker ones is
dilution. The surviving version of the idea is to ensemble *peers* — several
`td-net-bonus` nets from different seeds — which is untested, and less attractive
now that the ε→0 schedule appears to capture much of the same variance reduction
inside a single net.

One thing that *looks* pathological is correct play: the net spends only 0.38
dice per game on yellow, feeding that area almost entirely from bonus crosses.

**Headroom is unmeasured.** `scripts/hindsight.ts` scored the old net at 252.4
against a clairvoyant 278.4 over 20 worlds (90.8%), but that bound was computed
with the old net as the beam heuristic, and per the trap below it must be
re-measured whenever the guiding net changes. Naively 260.0/278.4 = 93.4%, which
is exactly the kind of arithmetic that section warns against. Note also that the
clairvoyant number is not a reachable target for any honest policy, so the
*achievable* ceiling remains unknown; bracketing it would need a
partial-clairvoyance ladder (a solver that knows the next 1, 2, 3 rolls).

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
| + polish (ε 0.08 → 0.01) | 296.5 | 95 | — |
| + bonus-economy features (transplant) | **301.6** | 98 | — |

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

Hindsight efficiency: 287.3 vs a clairvoyant 327.3 — 88.1% (measured before the
bonus-features net; see the re-measurement trap below).

## Chasing bonuses, not points

The hypothesis: v1's features carry group *completion fractions*, but the net has
to derive the cascade structure itself — which bonus a group grants, how close
each printed bonus is to firing, how productive the engine has been so far.
Spelling that out makes it linearly visible.

`bonusman` (`src/strategies/bonusman.ts`) demonstrates the objective in a
hand-written eval: banked unlocks and foxes over points, convex progress toward
open bonus groups, pull toward bonus-carrying track slots. Over 1000 games on
seed 11 it collects **65% more foxes** (2.43 vs 1.47) and **29% more action-bar
unlocks** (9.47 vs 7.36) than greedy, at a deliberate cost: 117.1 against greedy's
138.7 on the base game — but 105.1 against 101.8 on Twice, where the bonus economy
is worth more.

It also shows why the objective is insufficient on its own: 2.43 foxes earning
only 5.0 fox points, versus greedy's 1.47 foxes for 11.9, because it starves its
minimum area (green 6.8). Foxes multiply `minArea` — the same pathology the
collapsed Twice net had.

`td-net-bonus` gives the net the same signals as 19 extra features (182 total):
lifetime action-bar unlocks, completed bonus-carrying groups, "one-away" counts
per bonus kind (the cascade trigger), and write-track pull per kind. Held out it
reaches **260.0** on the base game and **301.6** on Twice — the repo's first 300+.
Worth ~+4 over the schedule-matched control on both sheets.

### The transplant recipe mattered more than the features

Training the wider feature set from scratch stalls at ~243 — 17 points *below*
the net it was meant to extend, because it has to relearn all of the old
competence before it can use any of the new signals. What works is
`--transplant`: copy the narrower net's weights and leave the input rows for the
new features at **exactly zero**. Zero rows contribute nothing to any hidden
pre-activation, so the widened net's values are bit-identical to its source and
the transplanted policy starts out indistinguishable from it — verified over
real afterstates in `tests/tdnet-transplant.test.ts`, and visible as an ep-0 eval
that reproduces the source's score to the decimal.

Seeding those rows with anything nonzero forfeits the property, and the penalty
lands *before training starts* — the widened net simply plays worse than the net
it was built from. Measured on 500 games at the eval seed, varying only the
initialization of the 19 new rows:

| new rows | starting policy |
|---|---|
| exactly 0 | **252.4** (identical to the source) |
| ~N(0, 0.01) | 251.9 |
| ~N(0, 0.05) | 249.2 |
| ~N(0, 0.1) | 245.6 |
| ~N(0, 0.2) | 230.2 |

He-normal — the natural default, and what `initNet` would use — is sd = √(2/182)
≈ 0.105 for this layer, so simply reaching for the standard initializer throws
away ~7 points before the first episode. That is why `widenNet` has no scale
parameter. (The campaign reported ~10 points; the larger figure is about where a
noisy start *ends up* after refinement, which is not reproduced here — as a
starting-policy effect, 0.01-scale noise costs only ~0.5.)

Refine from the transplant at low ε.

One instructive asymmetry between the two sheets: the gentle ε-0.04 refinement
that lifted the base net *degraded* the curriculum-trained Twice optimum. Only a
strict micro-polish (ε pinned at 0.01, lr 3e-5) improved it. A net that reached
its regime through a curriculum is more fragile to exploration than one that
found it by ordinary self-play.

### Negative results from the same campaign

Both are registered in the trainer's feature registry so they can be re-run, and
neither ships as a default:

- **`v1bonus2`** — reachability-gated track bonuses (late green/orange/purple
  bonuses go dark once unreachable) plus time-bucketed chase signals: **256.7**,
  a regression against the 260 champion.
- **`v1bonus3`** — write-landing values, orange-multiplier timing, depth-2
  cascade fuses: **260.0**, a tie. Instrumentation explains why: champion and
  control produce identical cascade *volume* (~9.7 bonus marks/game), so the win
  is cascade *selection*, which the net already learns without being told.

## Methodology traps worth knowing

**Sparse feature indices must be `Uint16`.** `toSparse` stored them in a
`Uint8Array`, so any feature set above 255 inputs silently wrapped and corrupted
every training sample — the first 271-feature Twice run diverged to eval 78 with
no error. Every committed net (163 / 216 / 252 features) sits under the limit, so
no shipped result was ever affected, but the trap is invisible when you hit it.
Fixed in all three trainers.

**The hindsight bound depends on its heuristic.** The beam search is guided by
a value net, so it explores what that net believes. Measured with the old
yellow-max net, the "clairvoyant optimum" for Twice was 250.6 — a number the
*policy* later beat outright. With the fox-regime net it is 327.3. Always
re-measure the bound when the guiding net changes; better, take the per-world
max over several heuristics. **Both bounds are currently stale** — they predate
`td-net-bonus`, so the efficiency percentages quoted above should not be updated
by dividing the new policy score into the old bound.

**Best-net selection overfits the eval set.** The trainer ships whichever net
scores best on a fixed evaluation seed, which biases that score upward
(winner's curse). For Twice the frozen best was 300.8 while held-out was 296.5.
Widening the eval from 200 to 400 games shrank the gap; the honest number is
always the held-out batch on unused seeds. Sanity-checked on five never-used
seeds: 292.0 / 300.1 / 300.4 / 300.3 / 299.3 — mean 298.4, so the benchmark
seeds are if anything slightly pessimistic.

**The default eval cannot see the differences worth chasing.** At `--eval-games
200` and a score std of ~22, the standard error is 1.6, so the minimum difference
resolvable between two checkpoints is ~4.4 points — larger than most of the gains
documented on this page. Every late-training decision made against that
instrument was partly noise, and the ensemble result above (+3.3) would have been
invisible to it. Evaluation costs ~11 ms/game: 1400 games is 15 seconds. Widen it
before tuning anything, and prefer a moving average of recent evals over the
single argmax when selecting what to ship.

**Serialized weights lose ~0.1 point.** `paramsFromNet` rounds to 5 significant
digits, so a checkpoint's `bestParams` and the generated weights module are both
slightly weaker than the live net whose eval got recorded: `td-main`'s header
reads 253.4, and both its stored best net and the shipped module measure 253.3 on
that same eval set. Harmless, but it means a re-measured checkpoint is expected to
come in a hair under its logged score.

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
