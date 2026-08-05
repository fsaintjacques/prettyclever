/**
 * The standard "Ganz schön clever" score sheet, transcribed from the official
 * sheet (see docs/RULES.md for the annotated layout).
 */
import { ascendTrackArea, crossGridArea, thresholdTrackArea, writeTrackArea } from '../areas';
import type { Effect, VariantDef } from '../types';

const fox: Effect = { t: 'fox' };
const reroll: Effect = { t: 'reroll' };
const plus1: Effect = { t: 'plus1' };
const crossAny = (area: string): Effect => ({ t: 'crossAny', area });
const crossNext = (area: string): Effect => ({ t: 'crossNext', area });
const writeNext = (area: string, value: number): Effect => ({ t: 'writeNext', area, value });

// 4×4 grid, row-major. null = pre-printed cross.
const yellow = crossGridArea({
  id: 'yellow',
  label: 'Yellow',
  colors: ['yellow'],
  values: [3, 6, 5, null, 2, 1, null, 5, 1, null, 2, 4, null, 3, 4, 6],
  groups: [
    { kind: 'row', cells: [0, 1, 2, 3], bonus: crossAny('blue') },
    { kind: 'row', cells: [4, 5, 6, 7], bonus: writeNext('orange', 4) },
    { kind: 'row', cells: [8, 9, 10, 11], bonus: crossNext('green') },
    { kind: 'row', cells: [12, 13, 14, 15], bonus: fox },
    { kind: 'col', cells: [0, 4, 8, 12], points: 10 },
    { kind: 'col', cells: [1, 5, 9, 13], points: 14 },
    { kind: 'col', cells: [2, 6, 10, 14], points: 16 },
    { kind: 'col', cells: [3, 7, 11, 15], points: 20 },
    { kind: 'diag', cells: [0, 5, 10, 15], bonus: plus1 },
  ],
  scoring: { kind: 'groupPoints' },
});

// 11 cells: 2 3 4 / 5 6 7 8 / 9 10 11 12 (top-left of the 3×4 layout is a hole).
// The value marked is always blue + white.
const blue = crossGridArea({
  id: 'blue',
  label: 'Blue',
  colors: ['blue'],
  effectiveValue: (faces) => faces.blue + faces.white,
  values: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  groups: [
    { kind: 'row', cells: [0, 1, 2], bonus: writeNext('orange', 5) },
    { kind: 'row', cells: [3, 4, 5, 6], bonus: crossAny('yellow') },
    { kind: 'row', cells: [7, 8, 9, 10], bonus: fox },
    { kind: 'col', cells: [3, 7], bonus: reroll },
    { kind: 'col', cells: [0, 4, 8], bonus: crossNext('green') },
    { kind: 'col', cells: [1, 5, 9], bonus: writeNext('purple', 6) },
    { kind: 'col', cells: [2, 6, 10], bonus: plus1 },
  ],
  scoring: { kind: 'countTable', table: [0, 1, 2, 4, 7, 11, 16, 22, 29, 37, 46, 56] },
  // The printed sheet has a hole at the top-left: row 1 is "· 2 3 4", so the
  // columns line up as {5,9} {2,6,10} {3,7,11} {4,8,12}.
  ui: {
    columns: 4,
    cells: [
      { label: null, void: true },
      ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((v) => ({ label: String(v) })),
    ],
  },
});

const green = thresholdTrackArea({
  id: 'green',
  label: 'Green',
  colors: ['green'],
  thresholds: [1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 6],
  points: [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 66],
  cellBonuses: {
    3: plus1,
    5: crossAny('blue'),
    6: fox,
    8: writeNext('purple', 6),
    9: reroll,
  },
});

const orange = writeTrackArea({
  id: 'orange',
  label: 'Orange',
  colors: ['orange'],
  multipliers: [1, 1, 1, 2, 1, 1, 2, 1, 2, 1, 3],
  cellBonuses: {
    2: reroll,
    4: crossAny('yellow'),
    5: plus1,
    7: fox,
    9: writeNext('purple', 6),
  },
});

const purple = ascendTrackArea({
  id: 'purple',
  label: 'Purple',
  colors: ['purple'],
  size: 11,
  resetValue: 6,
  cellBonuses: {
    2: reroll,
    3: crossAny('blue'),
    4: plus1,
    5: crossAny('yellow'),
    6: fox,
    7: reroll,
    8: crossNext('green'),
    9: writeNext('orange', 6),
    10: plus1,
  },
});

export const thatsPrettyClever: VariantDef = {
  id: 'thats-pretty-clever',
  name: "That's Pretty Clever (Ganz schön clever)",
  colors: ['white', 'yellow', 'blue', 'green', 'orange', 'purple'],
  wild: 'white',
  rounds: 6,
  picksPerTurn: 3,
  roundBonuses: [
    reroll,
    plus1,
    reroll,
    {
      t: 'choice',
      label: 'Round 4 bonus: black X or black 6',
      options: [
        crossAny('yellow'),
        crossAny('blue'),
        crossNext('green'),
        writeNext('orange', 6),
        writeNext('purple', 6),
      ],
    },
    null,
    null,
  ],
  bars: {
    reroll: { size: 7, endBonus: null },
    plus1: { size: 7, endBonus: null },
    return: { size: 0, endBonus: null }, // this sheet has no return bar
  },
  plus1Scope: 'turn',
  areas: [yellow, blue, green, orange, purple],
  rating: [
    { min: 281, label: "You're so clever!" },
    { min: 260, label: 'Are you Einstein?' },
    { min: 240, label: 'What a genius!' },
    { min: 220, label: 'Impressive!' },
    { min: 200, label: 'Hats off to you!' },
    { min: 180, label: 'Great result!' },
    { min: 160, label: 'That was pretty good.' },
    { min: 140, label: 'Not bad… you could do better.' },
    { min: -Infinity, label: 'Try harder!' },
  ],
};
