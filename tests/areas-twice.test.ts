/**
 * Unit tests for the Twice as Clever area factories (and the freePlacements
 * contract on the existing ones), against the exact sheet data in
 * docs/RULES-TWICE.md. The factories are pure, so each test builds cells via
 * init() and drives placements/apply/score directly.
 */
import { describe, expect, it } from 'vitest';
import {
  descendTrackArea,
  newGame,
  pairsTrackArea,
  silverGridArea,
  silverGridCell,
  thatsPrettyClever,
  writeTrackArea,
  yellowLatticeArea,
  type AreaDef,
  type Effect,
} from '../src/engine';

const fox: Effect = { t: 'fox' };
const reroll: Effect = { t: 'reroll' };
const plus1: Effect = { t: 'plus1' };
const ret: Effect = { t: 'return' };
const free = (area: string): Effect => ({ t: 'free', area });

/** Apply a raw (value, cell) write and return the triggered effects. */
const put = (a: AreaDef, cells: number[], cell: number, value: number) =>
  a.apply(cells, { area: a.id, cell, value });

// ---------------------------------------------------------------------------
// Silver: 4 rows (yellow, blue, green, pink) × values 1–6
// ---------------------------------------------------------------------------

const silver = silverGridArea({
  id: 'silver',
  label: 'Silver',
  colors: ['silver'],
  rows: ['yellow', 'blue', 'green', 'pink'],
  columnBonuses: [plus1, free('yellow'), fox, free('blue'), free('green'), free('pink')],
  points: [0, 2, 4, 7, 11, 16, 22],
});

describe('silverGridArea', () => {
  it('lays out rows × values row-major', () => {
    expect(silver.size).toBe(24);
    expect(silverGridCell(0, 1)).toBe(0);
    expect(silverGridCell(2, 5)).toBe(16);
    expect(silverGridCell(3, 6)).toBe(23);
  });

  it('a value may be marked in any row where it is open', () => {
    const cells = silver.init();
    expect(silver.placements(cells, 3).map((p) => p.cell)).toEqual([2, 8, 14, 20]);
    put(silver, cells, 8, 1); // blue row's 3
    expect(silver.placements(cells, 3).map((p) => p.cell)).toEqual([2, 14, 20]);
    expect(silver.placements(cells, 7)).toEqual([]);
  });

  it('completing a column fires its bonus exactly once', () => {
    const cells = silver.init();
    expect(put(silver, cells, silverGridCell(0, 3), 1)).toEqual([]);
    expect(put(silver, cells, silverGridCell(1, 3), 1)).toEqual([]);
    expect(put(silver, cells, silverGridCell(2, 3), 1)).toEqual([]);
    expect(put(silver, cells, silverGridCell(3, 3), 1)).toEqual([fox]); // column 3 = fox
  });

  it('column bonuses match the sheet: 1→+1 ... 6→pink ?', () => {
    const cells = silver.init();
    for (let r = 0; r < 3; r++) {
      put(silver, cells, silverGridCell(r, 1), 1);
      put(silver, cells, silverGridCell(r, 6), 1);
    }
    expect(put(silver, cells, silverGridCell(3, 1), 1)).toEqual([plus1]);
    expect(put(silver, cells, silverGridCell(3, 6), 1)).toEqual([free('pink')]);
  });

  it('scores each row by its own mark count', () => {
    const cells = silver.init();
    // yellow row: 3 marks, blue row: 1, green row: 0, pink row: all 6
    for (const v of [1, 2, 3]) put(silver, cells, silverGridCell(0, v), 1);
    put(silver, cells, silverGridCell(1, 4), 1);
    for (const v of [1, 2, 3, 4, 5, 6]) put(silver, cells, silverGridCell(3, v), 1);
    expect(silver.score(cells)).toBe(7 + 2 + 0 + 22);
  });

  it('freePlacements = every open cell', () => {
    const cells = silver.init();
    expect(silver.freePlacements(cells)).toHaveLength(24);
    expect(silver.openCells(cells)).toHaveLength(24);
    put(silver, cells, 0, 1);
    put(silver, cells, 23, 1);
    const frees = silver.freePlacements(cells);
    expect(frees).toHaveLength(22);
    expect(frees.every((p) => p.value === 1)).toBe(true);
    expect(frees.some((p) => p.cell === 0 || p.cell === 23)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Yellow: 10-cell lattice, circle then cross (padded 4-wide layout with holes)
// ---------------------------------------------------------------------------

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

describe('yellowLatticeArea', () => {
  it('offers circles on empty matching cells only', () => {
    const cells = yellow.init();
    expect(yellow.placements(cells, 5)).toEqual([
      { area: 'yellow', cell: 14, value: 1 },
      { area: 'yellow', cell: 17, value: 1 },
    ]);
    expect(yellow.placements(cells, 1)).toEqual([{ area: 'yellow', cell: 4, value: 1 }]);
  });

  it('offers a cross only once the cell is circled, and nothing when crossed', () => {
    const cells = yellow.init();
    put(yellow, cells, 14, 1); // circle one 5
    expect(yellow.placements(cells, 5)).toEqual([
      { area: 'yellow', cell: 14, value: 2 },
      { area: 'yellow', cell: 17, value: 1 },
    ]);
    put(yellow, cells, 14, 2); // cross it
    expect(yellow.placements(cells, 5)).toEqual([{ area: 'yellow', cell: 17, value: 1 }]);
  });

  it('a fully circled group fires its bonus; crossing does not re-fire it', () => {
    const cells = yellow.init();
    expect(put(yellow, cells, 4, 1)).toEqual([]); // row {1,2} half done
    expect(put(yellow, cells, 6, 1)).toEqual([ret]); // row complete at circles
    expect(put(yellow, cells, 4, 2)).toEqual([]); // crossing is bonus-neutral
    expect(put(yellow, cells, 6, 2)).toEqual([]);
  });

  it('crossed cells count as circled for group completion', () => {
    const cells = yellow.init();
    put(yellow, cells, 4, 1);
    put(yellow, cells, 4, 2); // the 1 is crossed
    expect(put(yellow, cells, 12, 1)).toEqual([reroll]); // column {1,2} complete
  });

  it('a circle can complete a row and a column at once', () => {
    const cells = yellow.init();
    put(yellow, cells, 3, 1); // 6
    put(yellow, cells, 11, 1); // second 3
    expect(put(yellow, cells, 19, 1)).toEqual([fox]); // column {6,3,4} complete
    expect(put(yellow, cells, 1, 1)).toEqual([free('blue')]); // row {3,6} complete
    expect(put(yellow, cells, 17, 1)).toEqual([free('pink')]); // row {5,4} complete
    // the 4 finishes its row {4,3} and its column {3,4,5} together
    expect(put(yellow, cells, 9, 1)).toEqual([free('yellow'), plus1]);
  });

  it('scores crosses only', () => {
    const cells = yellow.init();
    for (const c of [1, 3, 4, 6, 9]) put(yellow, cells, c, 1); // 5 circles
    expect(yellow.score(cells)).toBe(0);
    put(yellow, cells, 1, 2);
    put(yellow, cells, 4, 2);
    expect(yellow.score(cells)).toBe(10); // 2 crosses
    const all = yellow.init().map((_, i) => (yellow.ui.cells[i].void ? 0 : 2));
    expect(yellow.score(all)).toBe(165); // 10 crosses
  });

  it('freePlacements = every legal circle or cross, never a hole', () => {
    const empty = yellow.init();
    expect(yellow.freePlacements(empty)).toHaveLength(10); // all circles
    const cells = yellow.init();
    put(yellow, cells, 4, 1);
    const frees = yellow.freePlacements(cells);
    expect(frees).toHaveLength(10); // 9 circles + 1 cross
    expect(frees.find((p) => p.cell === 4)).toEqual({ area: 'yellow', cell: 4, value: 2 });
    put(yellow, cells, 4, 2);
    expect(yellow.freePlacements(cells)).toHaveLength(9);
    expect(yellow.openCells(cells)).toEqual([]); // crossAny unsupported
  });
});

// ---------------------------------------------------------------------------
// Blue: 12 slots, write blue+white (2–12) left→right, non-increasing
// ---------------------------------------------------------------------------

const blue = descendTrackArea({
  id: 'blue',
  label: 'Blue',
  colors: ['blue'],
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

describe('descendTrackArea', () => {
  it('writes left→right, each value ≤ the previous', () => {
    const cells = blue.init();
    expect(blue.placements(cells, 7)).toEqual([{ area: 'blue', cell: 0, value: 7 }]);
    put(blue, cells, 0, 7);
    expect(blue.placements(cells, 8)).toEqual([]);
    expect(blue.placements(cells, 7)).toEqual([{ area: 'blue', cell: 1, value: 7 }]); // equal ok
    expect(blue.placements(cells, 2)).toEqual([{ area: 'blue', cell: 1, value: 2 }]);
  });

  it('rejects values outside 2–12', () => {
    const cells = blue.init();
    expect(blue.placements(cells, 1)).toEqual([]);
    expect(blue.placements(cells, 13)).toEqual([]);
  });

  it('slot bonuses fire when written', () => {
    const cells = blue.init();
    expect(put(blue, cells, 0, 12)).toEqual([]);
    expect(put(blue, cells, 1, 12)).toEqual([ret]);
    expect(put(blue, cells, 2, 11)).toEqual([free('yellow')]);
  });

  it('scores by filled count', () => {
    const cells = blue.init();
    expect(blue.score(cells)).toBe(0);
    for (let i = 0; i < 5; i++) put(blue, cells, i, 8);
    expect(blue.score(cells)).toBe(15);
    for (let i = 5; i < 12; i++) put(blue, cells, i, 3);
    expect(blue.score(cells)).toBe(78);
  });

  it('freePlacements = every value 2–12 still legal at the next slot', () => {
    const empty = blue.init();
    expect(blue.freePlacements(empty).map((p) => p.value)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    const cells = blue.init();
    put(blue, cells, 0, 5);
    expect(blue.freePlacements(cells).map((p) => p.value)).toEqual([2, 3, 4, 5]);
    expect(blue.bonusPlacement(cells, 'write', 6)).toBeNull();
    expect(blue.bonusPlacement(cells, 'write', 5)).toEqual({ area: 'blue', cell: 1, value: 5 });
  });
});

// ---------------------------------------------------------------------------
// Green: 12 slots in 6 subtraction pairs, write die × multiplier
// ---------------------------------------------------------------------------

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

describe('pairsTrackArea', () => {
  it('writes die × the next slot multiplier', () => {
    const cells = green.init();
    expect(green.placements(cells, 4)).toEqual([{ area: 'green', cell: 0, value: 8 }]);
    put(green, cells, 0, 8);
    expect(green.placements(cells, 6)).toEqual([{ area: 'green', cell: 1, value: 12 }]);
  });

  it('slot bonuses fire when written', () => {
    const cells = green.init();
    expect(put(green, cells, 0, 12)).toEqual([]);
    expect(put(green, cells, 1, 2)).toEqual([reroll]);
  });

  it('a pair scores first − second once complete; incomplete pairs score 0', () => {
    const cells = green.init();
    put(green, cells, 0, 12); // 6 × 2
    expect(green.score(cells)).toBe(0);
    put(green, cells, 1, 4); // 2 × 2
    expect(green.score(cells)).toBe(8);
    put(green, cells, 2, 2); // second pair half-filled
    expect(green.score(cells)).toBe(8);
  });

  it('negative pairs stand and the total can be negative', () => {
    const cells = green.init();
    put(green, cells, 0, 2); // 1 × 2
    put(green, cells, 1, 12); // 6 × 2
    expect(green.score(cells)).toBe(-10);
    put(green, cells, 2, 12); // 6 × 2
    put(green, cells, 3, 6); // 6 × 1
    expect(green.score(cells)).toBe(-10 + 6);
  });

  it('freePlacements = the six faces times the next multiplier', () => {
    const cells = green.init();
    expect(green.freePlacements(cells).map((p) => p.value)).toEqual([2, 4, 6, 8, 10, 12]);
    for (let i = 0; i < 4; i++) put(green, cells, i, 1);
    expect(green.freePlacements(cells).map((p) => p.value)).toEqual([3, 6, 9, 12, 15, 18]);
    const full = green.init().fill(1);
    expect(green.freePlacements(full)).toEqual([]);
    expect(green.placements(full, 3)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pink: 12-slot write track with threshold-gated bonuses
// ---------------------------------------------------------------------------

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

describe('writeTrackArea with bonus gates (pink)', () => {
  it('any value is a legal write', () => {
    const cells = pink.init();
    expect(pink.placements(cells, 1)).toEqual([{ area: 'pink', cell: 0, value: 1 }]);
  });

  it('withholds the bonus below the threshold but still fills the slot', () => {
    const cells = pink.init();
    put(pink, cells, 0, 3);
    put(pink, cells, 1, 3);
    expect(put(pink, cells, 2, 1)).toEqual([]); // slot 3 needs ≥2
    expect(cells[2]).toBe(1);
    expect(put(pink, cells, 3, 2)).toEqual([]); // slot 4 needs ≥3
  });

  it('grants the bonus at or above the threshold', () => {
    const cells = pink.init();
    expect(put(pink, cells, 2, 2)).toEqual([reroll]); // exactly the minimum
    expect(put(pink, cells, 6, 6)).toEqual([free('yellow')]);
    expect(put(pink, cells, 7, 2)).toEqual([fox]);
  });

  it('gates compare the un-multiplied die value', () => {
    const track = writeTrackArea({
      id: 't',
      label: 'T',
      colors: ['pink'],
      multipliers: [2],
      cellBonuses: { 0: fox },
      bonusMinValues: { 0: 3 },
    });
    const cells = track.init();
    // face 2 writes 4 — above 3 numerically, but the gate reads the face
    expect(track.apply(cells, track.placements(cells, 2)[0])).toEqual([]);
    const cells2 = track.init();
    expect(track.apply(cells2, track.placements(cells2, 3)[0])).toEqual([fox]);
  });

  it('scores the sum of written values', () => {
    const cells = pink.init();
    put(pink, cells, 0, 4);
    put(pink, cells, 1, 6);
    put(pink, cells, 2, 1);
    expect(pink.score(cells)).toBe(11);
  });

  it('ungated tracks (base orange) grant bonuses unconditionally', () => {
    const orange = thatsPrettyClever.areas.find((a) => a.id === 'orange')!;
    const cells = orange.init();
    put(orange, cells, 0, 1);
    put(orange, cells, 1, 1);
    expect(put(orange, cells, 2, 1)).toEqual([reroll]);
  });
});

// ---------------------------------------------------------------------------
// freePlacements on the base-game factories
// ---------------------------------------------------------------------------

describe('freePlacements on base areas', () => {
  const area = (id: string) => thatsPrettyClever.areas.find((a) => a.id === id)!;

  it('cross grids: any open cell', () => {
    const yellowBase = area('yellow');
    const cells = yellowBase.init();
    expect(yellowBase.freePlacements(cells)).toHaveLength(12); // 16 − 4 pre-printed
    expect(yellowBase.freePlacements(cells).every((p) => p.value === 1)).toBe(true);
  });

  it('threshold tracks: the next cell, ignoring its threshold', () => {
    const greenBase = area('green');
    const cells = greenBase.init();
    cells[0] = cells[1] = cells[2] = 1; // next needs ≥4, a free mark ignores that
    expect(greenBase.freePlacements(cells)).toEqual([{ area: 'green', cell: 3, value: 1 }]);
  });

  it('write tracks: the six faces at the next slot, multiplied', () => {
    const orange = area('orange');
    const cells = orange.init();
    cells[0] = cells[1] = cells[2] = 1; // next slot is ×2
    expect(orange.freePlacements(cells).map((p) => p.value)).toEqual([2, 4, 6, 8, 10, 12]);
  });

  it('ascend tracks: the faces that still ascend (all six after a reset)', () => {
    const purple = area('purple');
    const cells = purple.init();
    cells[0] = 4;
    expect(purple.freePlacements(cells).map((p) => p.value)).toEqual([5, 6]);
    cells[0] = 6;
    expect(purple.freePlacements(cells)).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Stage-1 state plumbing: new fields exist and start inert
// ---------------------------------------------------------------------------

describe('stage-1 state fields', () => {
  it('newGame initializes returns, barUnlocks and returnsUsed', () => {
    const s = newGame(thatsPrettyClever);
    expect(s.returns).toBe(0);
    expect(s.barUnlocks).toEqual({ reroll: 0, plus1: 0, return: 0 });
    expect(s.stats.returnsUsed).toBe(0);
  });

  it('the base variant declares its bars as data', () => {
    const v = thatsPrettyClever;
    expect(v.bars.reroll).toEqual({ size: 7, endBonus: null });
    expect(v.bars.plus1).toEqual({ size: 7, endBonus: null });
    expect(v.bars.return.size).toBe(0);
    expect(v.plus1Scope).toBe('turn');
  });
});
