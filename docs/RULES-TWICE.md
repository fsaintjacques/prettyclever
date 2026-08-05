# Doppelt so clever ("Twice as Clever") — rules reference & engine design

Source: official Schmidt Spiele English rulebook (88234) + score-sheet scan.
Part 1 is the ground truth the variant will be coded against, in the same
format as `RULES.md`. Part 2 maps the rules onto the engine and lists every
extension the engine, UI and strategies need.

Variant id: `twice-as-clever`.

---

# Part 1 — Rules

## Components

6 dice: **white, yellow, blue, green, pink, silver**. The white die is wild:
it may be used as any color. For the **blue area** the value used is always
**blue + white** (current faces, wherever the dice are), whichever of the two
is placed. Score sheet with five areas (silver, yellow, blue, green, pink), a
round track, and **three** action bars — re-roll, **return**, extra die (+1) —
each with **6** unlock slots and a bonus on the last slot.

## Solo game structure

6 rounds. Each round the player takes an **active turn** then a **passive
turn** — identical structure to the base game:

- **Active turn**: roll all available dice; choose one die, place it on a dice
  field (max 3 picks) and mark its value in the matching colored area; all
  dice showing a *lower* value go to the **silver platter**; repeat until 3
  picks or no dice remain. A roll with no usable die may be forfeited (costs a
  pick, dice are re-rolled next).
- **Passive turn**: roll all six dice; the **three lowest** go to the platter
  (ties broken arbitrarily); choose one of those three and mark it. Re-roll
  actions may **not** be used on the passive turn.
- Game ends after the passive turn of round 6. Extra-die actions may still be
  used at the very end; unused re-rolls (and returns) expire.

### Round track

At the start of rounds 1–4 the player receives a bonus:

| Round | Bonus |
|-------|-------|
| 1 | unlock 1 re-roll |
| 2 | unlock 1 extra die (+1) |
| 3 | unlock 1 return |
| 4 | black **?** (see "? bonuses") |
| 5, 6 | nothing |

## Actions (three bars)

Unlocks circle the next slot of the bar; using an action marks the earliest
circled slot. Unlocked actions keep across turns/rounds. Each bar has **6**
slots; **circling the last slot immediately grants the bar's end bonus**:

| Bar | End-of-bar bonus |
|-----|------------------|
| re-roll | fox |
| return | pink **?** |
| extra die (+1) | silver **?** |

- **Re-roll** (active turn only): re-roll *all* currently rolled dice (no
  keeping some).
- **Return** (active turn only, **new**): take one die from the silver
  platter back into the pool; it is rolled with the next roll. Cannot be used
  once the dice have been rolled — i.e. it is decided *between* a pick and
  the following roll, and the returned die's platter face is never used
  directly.
- **Extra die (+1)**: performed at the **end of a round segment** (after the
  active player has assigned all dice / after the passive platter pick).
  Choose *any* of the six dice at its current face — including dice already
  used regularly this round — and mark it. Any number of extra-die actions
  per round, but **each individual die at most once per round** (not per
  turn, as in the base game).

## The five areas

### Silver (4 rows × 6 columns, mark any matching cell)

Rows top→bottom: **yellow, blue, green, pink**; each row holds the numbers
1–6. Only the **silver** die (or white as silver) is *placed* here; the row
is a free choice among rows where the value is still open.

**Platter chain** (the variant's signature rule): when the active player's
regular pick places a die in the silver area, every die that is moved onto
the platter *by that pick* is also marked in the silver area — a colored die
in **its own color's row** (lost if that number is already marked there), the
white or silver die in **any** row of its value. Dice already on the platter
from earlier picks are not marked. When the silver die is taken by the
passive pick or an extra-die action, it marks any row — no chain (nothing
moves to the platter).

If the silver die's value is marked in all four rows, the silver die
**cannot be chosen** at all (explicit rule — no wasted pick with it).

Column complete (all 4 rows of one number) → bonus above the column:

| Column | 1 | 2 | 3 | 4 | 5 | 6 |
|--------|---|---|---|---|---|---|
| bonus | +1 | yellow ? | fox | blue ? | green ? | pink ? |

Scoring, **per row** by number of marks: 1→2, 2→4, 3→7, 4→11, 5→16, 6→22.
Silver area score = sum over the four rows.

### Yellow (10-cell lattice, circle then cross)

A yellow die of value *n* either **circles** an uncircled cell showing *n*,
or **crosses** a cell showing *n* that is already circled. Layout (4 columns,
staggered rows; `·` = hole):

```
row\col  c0  c1  c2  c3     row bonus
r0        ·   3   ·   6  →  blue ?
r1        1   ·   2   ·  →  return
r2        ·   4   ·   3  →  yellow ?
r3        2   ·   5   ·  →  green ?
r4        ·   5   ·   4  →  pink ?

column bonus:  c0 {1,2} → re-roll   c1 {3,4,5} → +1
               c2 {2,5} → silver ?  c3 {6,3,4} → fox
```

Values 1 and 6 appear once, 2/3/4/5 twice. **Bonuses fire when a row or
column is completely *circled*** (crosses count as circled; crossing is not
required). Points count **crosses only**:

count 1..10 → 3, 10, 21, 36, 55, 75, 96, 118, 141, 165.

### Blue (12 slots, write blue+white left→right, non-increasing)

Write the sum **blue + white** (2–12) in the leftmost open slot; each number
must be **≤ the previous** one. Score by the printed value above the last
filled slot, i.e. by count filled:

count 1..12 → 1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 66, 78.

Bonuses under slots (1-based): 2 → return, 3 → yellow ?, 5 → +1,
6 → re-roll, 7 → pink ?, 9 → fox, 10 → return, 12 → green ?.

### Green (12 slots in 6 subtraction pairs, write die × multiplier)

Write **green die × the open slot's multiplier** in the leftmost open slot.
Pairs (star above each pair): pair score = first − second, awarded once both
slots are filled (an incomplete pair scores 0; negative results stand).
Green area score = sum of the six stars — **can be negative**.

| slot | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|------|---|---|---|---|---|---|---|---|---|----|----|----|
| mult | ×2 | ×2 | ×2 | ×1 | ×3 | ×3 | ×3 | ×2 | ×3 | ×1 | ×4 | ×1 |
| pair | 1 | 1 | 2 | 2 | 3 | 3 | 4 | 4 | 5 | 5 | 6 | 6 |
| bonus | | re-roll | | blue ? | return | | fox | silver ? | +1 | | pink ? | yellow ? |

(High × first slot, low × second: write big numbers first, small second.)

### Pink (12 slots, write die value left→right, threshold-gated bonuses)

Write the **pink die's value** in the leftmost open slot — any value is
legal, but the bonus under a slot is granted **only if the written value ≥
the slot's printed threshold**. Score = sum of written values.

| slot | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|------|---|---|---|---|---|---|---|---|---|----|----|----|
| ≥ | – | – | 2 | 3 | 4 | 5 | 6 | 2 | 3 | 4 | 5 | 6 |
| bonus | | | re-roll | return | +1 | green ? | yellow ? | fox | silver ? | re-roll | blue ? | yellow ? |

## ? bonuses

A **colored ?** is redeemed immediately (chained bonuses apply; lost if the
area can't take it):

- **silver ?** — mark any open silver cell (any row, any number).
- **yellow ?** — circle any uncircled cell **or** cross any circled cell.
- **blue ?** — write any number 2–12 in the next blue slot (the
  non-increasing constraint still applies).
- **green ?** — choose a value 1–6, write value × multiplier in the next
  green slot.
- **pink ?** — choose a value 1–6, write it in the next pink slot (the
  slot's threshold gates its bonus as usual).

The **black ?** (round-4 bonus, silver column 2 is yellow ?, etc.) is a free
choice of *one* of the five colored ?s.

## Foxes

6 obtainable: silver column 3, yellow column c3, blue slot 9, green slot 7,
pink slot 8, re-roll bar completion. Each fox scores the value of the
**lowest-scoring area** (0 if any area scores 0).

## Scoring & rating

Total = silver + yellow + blue + green + pink + foxes × min(area scores).

Solo rating: <140 "Half as clever", 140–159, 160–179, 180–199, 200–219,
220–239, 240–259, 260–279, 280–299, 300–319, ≥320 "Twice as clever!".

## Modeling decisions (rule ambiguities)

- **Return timing**: modeled as a decision point *before each active-turn
  roll* (including before a re-roll — returning first means the returned die
  is included). Only offered when a return is unlocked and the platter is
  non-empty; otherwise the roll proceeds directly.
- **Platter-chain marks are applied automatically** for colored dice (pure
  gain, no choice); white/silver chain marks queue a row-choice decision.
  Declining a chain mark is never useful and is not offered.
- **Silver die with fully-marked value**: not pickable (explicit rule). The
  base game's "wasted pick" allowance does not apply to the silver die; it
  stays for the other dice.
- **Blue ? respects the non-increasing constraint** (the ? frees the value,
  not the placement rule). Writing equal to the previous value is the
  natural "safe" choice.
- **Negative green / fox interaction**: fox = literal min over the five area
  scores, so a negative green makes foxes negative. (The rulebook only calls
  out the 0 case; literal min is the straightforward reading.)
- **Wasted pick / forfeited roll / optional passive pick / platter ties**:
  same modeling as the base game (`RULES.md`).
- **Extra-die usage flags reset at round start**, not between the active and
  passive segment (per-round, unlike the base game's per-turn).

---

# Part 2 — Engine mapping

What exists already maps cleanly: the solo phase machine (roll → pick ×3 →
endTurn → passiveRoll → passivePick → passiveEndTurn), the platter rule, the
pending-effect queue with chaining and loss-on-unresolvable, wild-die
handling, blue = blue + white via `effectiveValue`, fox counting and
`scoreState`. The gaps:

## types.ts

- `DieColor` += `'pink' | 'silver'`.
- New `Phase`: `'preRoll'` (active turn, return-action window).
- New `Action`s: `{ t: 'return'; die }`, `{ t: 'proceed' }` (leave preRoll).
- `Effect` extensions:
  - `{ t: 'return' }` — unlock one return action.
  - `{ t: 'free'; area }` — colored **?**; resolved against a new
    `AreaDef.freePlacements(cells): Placement[]` (silver: open cells;
    yellow: circles + crossable circles; blue: 2–12 at the next legal slot;
    green: 6 multiplied writes; pink: values 1–6). Black ? =
    `{ t: 'choice', options: five frees }`.
  - `{ t: 'silverMark'; value; row: DieColor | null }` — platter-chain mark;
    fixed `row` auto-applies (lost if taken), `row: null` (white/silver)
    queues a cell choice restricted to that value's open cells.
- `GameState` += `returns` counter, per-bar cumulative unlock counters (to
  cap at 6 and fire end-of-bar bonuses), `stats.returnsUsed`.
- `VariantDef` += action-bar config `{ size, endBonus }` per bar and a
  `plus1Scope: 'turn' | 'round'` knob (base: 7/7, no end bonuses, `'turn'`;
  twice: 6/6/6 with the bonuses above, `'round'`), so base-game behavior is
  preserved by data, not branching on variant id.

## areas.ts — new factories

- `silverGridArea`: 4×6 cross grid — reuses the crossGrid shape (values
  `[1..6] × 4` rows, 6 column groups with bonuses) but scores **per-row** by
  count table [2,4,7,11,16,22]. `colors: ['silver']` (+wild); other dice
  reach it only through `silverMark`.
- `yellowLatticeArea`: two-state cells (0 empty → 1 circled → 2 crossed);
  `placements(value)` offers circles on empty matches and crosses on circled
  matches; groups complete at state ≥ 1; score = crossed-count table.
- `descendTrackArea`: left→right writes, `next ≤ previous`, count-table
  scoring, per-cell bonuses (blue).
- `pairsTrackArea`: left→right multiplied writes, pair-subtraction scoring,
  per-cell bonuses (green).
- `writeTrackArea` extension: per-cell bonus with optional `minValue` gate
  (pink); pink itself is then a plain write track.
- `AreaDef.freePlacements` added with a default derived from `openCells` /
  `bonusPlacement` so existing areas don't change.

## game.ts

- **Pick into silver**: after moving lower dice to the platter, enqueue one
  `silverMark` per die moved *by this pick* (its face as value; own color as
  row, `null` for white/silver). Ordering: marks resolve before other queued
  effects of the same pick, matching the physical "mark them now" flow.
- **Silver-die legality**: in `legalActions`, the silver die gets no
  wasted-pick fallback; if `diePlacements` is empty it is simply absent.
- **preRoll**: `afterPick` (and the re-roll action) route to `'preRoll'`
  instead of `'roll'` when `returns > 0` and the platter is non-empty;
  actions there are `return`(die) — which moves the die to the pool and
  stays in preRoll — and `proceed`.
- **Action bars**: unlocks increment both the available counter and the
  cumulative counter, clamp at the bar size (overflow → `bonusesLost`), and
  fire the end bonus exactly when the cumulative counter reaches it.
- **plus1Scope 'round'**: `endTurnMut` keeps `plus1Used` across the
  active→passive transition and resets it on round advance.

## Variant file

`src/engine/variants/twice-as-clever.ts`: colors
`['white','yellow','blue','green','pink','silver']`, wild white, 6 rounds, 3
picks, round bonuses `[reroll, plus1, return, black ?, null, null]`, the five
areas above, rating table. Register in `variants/index.ts` — the UI's
variant selector appears automatically (previous step's work).

## UI

- `AreaUi` additions: circled-state rendering (yellow, and circle-vs-mark
  glyphs), lattice holes (already exists as `void`), pair separators with
  the star slot (green), threshold labels (pink), per-row point scale
  (silver).
- Third action bar (return) + end-of-bar bonus icons; round track shows the
  new bonus set.
- Color maps: add `pink` and `silver` swatches (Dice, ScorePanel,
  DiceHistogram, SimPanel chart order — the cosmetic items deferred from the
  namespace step).
- `describe.ts`: return/free-bonus action descriptions.

## Strategies

- Truly variant-generic: `random`, `mc` (random rollouts).
- `greedy`'s eval — and everything built on it (`planner`, `expectimax`,
  `mcts`, `mc-greedy`) — has shaping terms keyed to standard area ids
  (blue/green sum shaping, purple/orange slot EV). On this sheet those terms
  vanish silently: the strategies *run* but degrade to score-greedy. That is
  acceptable as a baseline; a twice-specific eval (silver-row/column
  potential, pair-ordering for green, descent budget for blue, circle-vs-
  cross tempo for yellow) is its own follow-up, as is a twice td-net
  (feature extractor is sheet-specific by design).
- `strategiesFor('twice-as-clever')` initially returns just the globals —
  the namespace work from the previous step makes this automatic.

## Test plan

Per-area unit tests (placement legality, bonus triggers, scoring tables —
including green negatives and the pink threshold gate), flow tests (platter
chain marks incl. white-row choice and lost marks; silver-die pick ban;
return window incl. return-before-reroll; per-round extra-die flags; bar
caps and end-of-bar bonuses; black ? expansion), and a seeded full-game
determinism test mirroring the existing suite.

## Implementation order

1. `types.ts` + `areas.ts` factories (pure, unit-testable).
2. `game.ts` flow changes gated by variant config; base-game suite must stay
   green untouched.
3. Variant file + registration + rules tests.
4. UI rendering.
5. Baseline sims (`random`, `mc`) to sanity-check score ranges; then a
   twice-specific greedy eval as the first real baseline.
