/**
 * The "Doppelt so clever" (Twice as Clever) score sheet, transcribed from the
 * official sheet (see docs/RULES-TWICE.md for the annotated layout).
 */
import {
  descendTrackArea,
  pairsTrackArea,
  silverGridArea,
  writeTrackArea,
  yellowLatticeArea,
} from '../areas';
import type { Effect, VariantDef } from '../types';

const fox: Effect = { t: 'fox' };
const reroll: Effect = { t: 'reroll' };
const plus1: Effect = { t: 'plus1' };
const ret: Effect = { t: 'return' };
const free = (area: string): Effect => ({ t: 'free', area });

// 4 rows (yellow, blue, green, pink) × the values 1–6; only the silver die is
// placed here — the other dice arrive via the platter chain (silverMark).
// Completing a column grants the bonus printed above it; each row scores by
// its own mark count.
const silver = silverGridArea({
  id: 'silver',
  label: 'Silver',
  colors: ['silver'],
  rows: ['yellow', 'blue', 'green', 'pink'],
  columnBonuses: [plus1, free('yellow'), fox, free('blue'), free('green'), free('pink')],
  points: [0, 2, 4, 7, 11, 16, 22],
});

// 10 cells on a 4-column staggered lattice (null = hole). A yellow die
// circles a matching cell or crosses a circled one; rows/columns complete —
// firing their bonus — once fully circled, but only crosses score.
const yellow = yellowLatticeArea({
  id: 'yellow',
  label: 'Yellow',
  colors: ['yellow'],
  // prettier-ignore
  values: [
    null, 3, null, 6,
    1, null, 2, null,
    null, 4, null, 3,
    2, null, 5, null,
    null, 5, null, 4,
  ],
  groups: [
    { kind: 'row', cells: [1, 3], bonus: free('blue') },
    { kind: 'row', cells: [4, 6], bonus: ret },
    { kind: 'row', cells: [9, 11], bonus: free('yellow') },
    { kind: 'row', cells: [12, 14], bonus: free('green') },
    { kind: 'row', cells: [17, 19], bonus: free('pink') },
    { kind: 'col', cells: [4, 12], bonus: reroll },
    { kind: 'col', cells: [1, 9, 17], bonus: plus1 },
    { kind: 'col', cells: [6, 14], bonus: free('silver') },
    { kind: 'col', cells: [3, 11, 19], bonus: fox },
  ],
  points: [0, 3, 10, 21, 36, 55, 75, 96, 118, 141, 165],
});

// 12 slots, write blue + white (2–12) left→right, each value ≤ the previous
// one; scores by filled count. Cell bonuses are 0-based (printed slots 2, 3,
// 5, 6, 7, 9, 10, 12).
const blue = descendTrackArea({
  id: 'blue',
  label: 'Blue',
  colors: ['blue'],
  effectiveValue: (faces) => faces.blue + faces.white,
  size: 12,
  minValue: 2,
  maxValue: 12,
  points: [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 66, 78],
  cellBonuses: {
    1: ret,
    2: free('yellow'),
    4: plus1,
    5: reroll,
    6: free('pink'),
    8: fox,
    9: ret,
    11: free('green'),
  },
});

// 12 slots in 6 subtraction pairs, write green × the slot's multiplier
// left→right; each pair scores first − second (can go negative).
const green = pairsTrackArea({
  id: 'green',
  label: 'Green',
  colors: ['green'],
  multipliers: [2, 2, 2, 1, 3, 3, 3, 2, 3, 1, 4, 1],
  cellBonuses: {
    1: reroll,
    3: free('blue'),
    4: ret,
    6: fox,
    7: free('silver'),
    8: plus1,
    10: free('pink'),
    11: free('yellow'),
  },
});

// 12 slots, write the pink value left→right; any value fills a slot, but its
// bonus is granted only when the value meets the printed ≥ threshold.
const pink = writeTrackArea({
  id: 'pink',
  label: 'Pink',
  colors: ['pink'],
  multipliers: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  cellBonuses: {
    2: reroll,
    3: ret,
    4: plus1,
    5: free('green'),
    6: free('yellow'),
    7: fox,
    8: free('silver'),
    9: reroll,
    10: free('blue'),
    11: free('yellow'),
  },
  bonusMinValues: { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 2, 8: 3, 9: 4, 10: 5, 11: 6 },
});

export const twiceAsClever: VariantDef = {
  id: 'twice-as-clever',
  name: 'Twice as Clever (Doppelt so clever)',
  colors: ['white', 'yellow', 'blue', 'green', 'pink', 'silver'],
  wild: 'white',
  rounds: 6,
  picksPerTurn: 3,
  roundBonuses: [
    reroll,
    plus1,
    ret,
    {
      t: 'choice',
      label: 'Round 4 bonus: any colored ?',
      options: [free('silver'), free('yellow'), free('blue'), free('green'), free('pink')],
    },
    null,
    null,
  ],
  bars: {
    reroll: { size: 6, endBonus: fox },
    plus1: { size: 6, endBonus: free('silver') },
    return: { size: 6, endBonus: free('pink') },
  },
  plus1Scope: 'round',
  areas: [silver, yellow, blue, green, pink],
  // The rulebook names only the bottom and top tiers; the seven in between
  // are 20-point bands with labels in the base variant's spirit.
  rating: [
    { min: 320, label: 'Twice as clever!' },
    { min: 300, label: 'Almost twice as clever.' },
    { min: 280, label: 'Are you Einstein?' },
    { min: 260, label: 'What a genius!' },
    { min: 240, label: 'Impressive!' },
    { min: 220, label: 'Hats off to you!' },
    { min: 200, label: 'Great result!' },
    { min: 180, label: 'That was pretty good.' },
    { min: 160, label: 'Not bad at all.' },
    { min: 140, label: 'You could do better.' },
    { min: -Infinity, label: 'Half as clever.' },
  ],
};
