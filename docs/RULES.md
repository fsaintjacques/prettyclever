# Ganz schön clever ("That's Pretty Clever") — engine rules reference

Source: official Schmidt Spiele English rulebook (88198) + score-sheet scan.
This document is the ground truth the engine in `src/engine/` is coded against.

## Components

6 dice: **white, yellow, blue, green, orange, purple**. The white die is wild:
it may be used as any color. Score sheet with five colored areas, a round
track, and two action tracks (re-roll, +1 extra die), each with 7 unlock slots.

## Solo game structure (what the engine implements)

6 rounds. Each round the player takes an **active turn** then a **passive
turn**.

### Round start

At the start of rounds 1–4 the player receives a bonus from the round track:

| Round | Bonus |
|-------|-------|
| 1 | unlock 1 re-roll |
| 2 | unlock 1 extra-die (+1) |
| 3 | unlock 1 re-roll |
| 4 | choice: black **X** (cross any yellow cell, any blue cell, or the next green cell) **or** black **6** (write a 6 in the next orange or purple slot) |
| 5, 6 | nothing |

### Active turn

1. Roll all available dice (initially all 6).
2. Choose one die, put it on a dice field (max 3), and mark its value in the
   matching colored area. All dice showing a **lower** value than the chosen
   die go to the **silver platter** and are no longer available this turn.
3. Repeat (roll remaining → choose) until 3 dice are placed or no dice remain.
4. If no die of a roll can be used, the roll is forfeited (it still consumes
   one of the 3 picks; the dice stay and are re-rolled next).
5. **Re-roll action** (active turn only): before picking, spend an unlocked
   re-roll to re-roll *all* currently rolled dice.
6. **End of turn**: any number of unlocked **+1** actions may be spent. Each
   +1 selects *any* of the six dice (wherever it is — dice field, platter),
   at its current face value, and marks it. Each individual die may be chosen
   at most once per turn via +1.

### Passive turn (solo rule)

Roll all six dice; the **three lowest** go to the silver platter (ties broken
arbitrarily — the engine breaks them randomly). Choose **one** of those three
and mark it. Re-roll actions may **not** be used; +1 actions may (choosing
among all six dice). The engine allows declining the passive pick.

### Game end

After the passive turn of round 6. +1 actions may still be used on the final
turn; unused re-rolls expire.

## The five areas

The **white** die may be played into any area. For the **blue area**, the
value used is always **blue + white** (current faces, regardless of where
either die is), whether the placed die is the blue or the white one.

### Yellow (4×4 grid, cross matching value, any order)

```
row\col   c0  c1  c2  c3     row bonus
r0         3   6   5   ■  →  blue X (any open blue cell)
r1         2   1   ■   5  →  orange 4 (write in next orange slot)
r2         1   ■   2   4  →  green X (cross next green cell)
r3         ■   3   4   6  →  fox
points    10  14  16  20     (column complete → circled points)
diagonal r0c0,r1c1,r2c2,r3c3 (3,1,2,6) → +1
```
■ = pre-printed cross. Each value appears twice; one cross per die.

### Blue (cross the sum blue+white, any order)

Points by number of crossed cells:
count 1..11 → 1, 2, 4, 7, 11, 16, 22, 29, 37, 46, 56.

```
      c0   c1   c2   c3     row bonus
r0          2    3    4  →  orange 5
r1     5    6    7    8  →  yellow X (any open yellow cell)
r2     9   10   11   12  →  fox
col bonus:
c0 {5,9}     → re-roll
c1 {2,6,10}  → green X
c2 {3,7,11}  → purple 6
c3 {4,8,12}  → +1
```

### Green (cross left→right if die ≥ threshold)

Position (1-based), threshold, cumulative points, bonus on crossing that cell:

| pos | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
|-----|---|---|---|---|---|---|---|---|---|----|----|
| ≥   | 1 | 2 | 3 | 4 | 5 | 1 | 2 | 3 | 4 | 5  | 6  |
| pts | 1 | 3 | 6 | 10| 15| 21| 28| 36| 45| 55 | 66 |
| bonus | | | | +1 | | blue X | fox | | purple 6 | re-roll | |

A green X bonus crosses the next cell *ignoring* the threshold.

### Orange (write die value left→right, multipliers)

| pos | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
|-----|---|---|---|---|---|---|---|---|---|----|----|
| mult| 1 | 1 | 1 | ×2| 1 | 1 | ×2| 1 | ×2| 1  | ×3 |
| bonus | | | re-roll | | yellow X | +1 | | fox | | purple 6 | |

Score = sum of written (multiplied) values. Number bonuses (orange 4/5/6)
are written in the next slot and multiplied by that slot's multiplier.

### Purple (write die value left→right, strictly ascending; a 6 resets)

Each entry must exceed the previous one, except after a 6 anything may follow.

| pos | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
|-----|---|---|---|---|---|---|---|---|---|----|----|
| bonus | | | re-roll | blue X | +1 | yellow X | fox | re-roll | green X | orange 6 | +1 |

Score = sum of written values.

## Bonuses

- Bonus **under a cell**: redeemed immediately when that cell is filled.
- Bonus **at the end of a row/column/diagonal**: redeemed when the group is
  complete (pre-printed crosses count).
- Bonuses **must** be applied immediately and chain (a bonus that fills a cell
  triggers that cell's bonus, etc.). If a bonus cannot be applied (target area
  full), it is lost. Re-roll/+1 unlocks are actions, saved for later use.
- **Fox**: each earned fox scores, at game end, as many points as the
  *lowest-scoring* of the five areas (0 if any area scores 0).

## Scoring

yellow (circled column points) + blue (count table) + green (position table)
+ orange (sum) + purple (sum) + foxes × min(area scores).

Solo rating table: <140 "Try harder!", 140–159, 160–179, 180–199, 200–219,
220–239, 240–259, 260–280, >280 "You're so clever!".

## Modeling decisions (rule ambiguities)

- **Wasted pick**: the active player may pick a die that has no legal
  placement (it occupies a dice field, marks nothing, and still pushes lower
  dice to the platter). The rulebook neither allows nor forbids this
  explicitly; it is strategically meaningful in multiplayer, near-useless in
  solo. Allowed only for dice with no legal placement.
- **Forfeited roll**: when *no* rolled die can be placed, the engine offers
  `skip` (consume a pick, keep all dice, re-roll them next), per the rulebook.
- **Passive pick is optional** in the engine (rulebook says passive players
  "may" use a platter die).
- **Platter ties** on the passive turn are broken uniformly at random (the
  physical rule — "die closer to the platter" — is positional noise).
- The multiplayer "take a die from the active player's sheet" fallback does
  not exist in solo and is not implemented.
