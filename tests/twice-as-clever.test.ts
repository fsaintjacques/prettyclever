/**
 * Rules tests for the Twice as Clever variant file: the sheet data of
 * src/engine/variants/twice-as-clever.ts checked against docs/RULES-TWICE.md
 * Part 1 — areas, bonus positions, scoring tables, round bonuses, action
 * bars, the rating table — plus seeded full games. The game.ts mechanics
 * (platter chain, return window, bar caps, ...) are covered by
 * tests/game-twice.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  diePlacements,
  getVariant,
  newGame,
  rating,
  scoreState,
  silverGridCell,
  twiceAsClever,
  type AreaDef,
  type Effect,
  type GameState,
} from '../src/engine';
import { makeRandom } from '../src/strategies';
import { playGame } from '../src/sim/runner';

const v = twiceAsClever;
const die = (color: string) => v.colors.indexOf(color as never);
const area = (id: string): AreaDef => {
  const a = v.areas.find((x) => x.id === id);
  if (!a) throw new Error(`no area ${id}`);
  return a;
};

const fox: Effect = { t: 'fox' };
const reroll: Effect = { t: 'reroll' };
const plus1: Effect = { t: 'plus1' };
const ret: Effect = { t: 'return' };
const free = (a: string): Effect => ({ t: 'free', area: a });

/** Fresh round-1 state in the pick phase with chosen faces (order: white yellow blue green pink silver). */
function statePicking(faces: number[]): GameState {
  const s = newGame(v);
  s.faces = faces.slice();
  s.phase = 'pick';
  return s;
}

describe('variant config', () => {
  it('is registered under its id', () => {
    expect(getVariant('twice-as-clever')).toBe(v);
  });

  it('has the Twice dice, wild white, 6 rounds, 3 picks', () => {
    expect(v.colors).toEqual(['white', 'yellow', 'blue', 'green', 'pink', 'silver']);
    expect(v.wild).toBe('white');
    expect(v.rounds).toBe(6);
    expect(v.picksPerTurn).toBe(3);
    expect(v.plus1Scope).toBe('round');
  });

  it('sheet areas are silver, yellow, blue, green, pink', () => {
    expect(v.areas.map((a) => a.id)).toEqual(['silver', 'yellow', 'blue', 'green', 'pink']);
    expect(v.areas.map((a) => a.label)).toEqual(['Silver', 'Yellow', 'Blue', 'Green', 'Pink']);
    for (const a of v.areas.slice(1)) expect(a.colors).toEqual([a.id]);
    expect(area('silver').colors).toEqual(['silver']);
  });

  it('round bonuses: reroll, +1, return, black ?, nothing, nothing', () => {
    expect(v.roundBonuses).toHaveLength(6);
    expect(v.roundBonuses[0]).toEqual(reroll);
    expect(v.roundBonuses[1]).toEqual(plus1);
    expect(v.roundBonuses[2]).toEqual(ret);
    const black = v.roundBonuses[3];
    expect(black?.t).toBe('choice');
    if (black?.t === 'choice') {
      expect(black.options).toEqual([
        free('silver'),
        free('yellow'),
        free('blue'),
        free('green'),
        free('pink'),
      ]);
    }
    expect(v.roundBonuses[4]).toBeNull();
    expect(v.roundBonuses[5]).toBeNull();
  });

  it('three 6-slot bars: reroll → fox, +1 → silver ?, return → pink ?', () => {
    expect(v.bars.reroll).toEqual({ size: 6, endBonus: fox });
    expect(v.bars.plus1).toEqual({ size: 6, endBonus: free('silver') });
    expect(v.bars.return).toEqual({ size: 6, endBonus: free('pink') });
  });

  it('rating: 20-point bands from 140 to the 320 top tier', () => {
    expect(v.rating.map((r) => r.min)).toEqual([
      320, 300, 280, 260, 240, 220, 200, 180, 160, 140, -Infinity,
    ]);
    expect(rating(v, 139)).toBe('Half as clever.');
    expect(rating(v, 140)).not.toBe('Half as clever.');
    expect(rating(v, 319)).toBe(rating(v, 300));
    expect(rating(v, 320)).toBe('Twice as clever!');
  });
});

describe('silver area', () => {
  const silver = area('silver');

  it('is 4 rows (yellow, blue, green, pink) × the values 1–6', () => {
    expect(silver.size).toBe(24);
    expect(silver.silverRows).toEqual(['yellow', 'blue', 'green', 'pink']);
    expect(silver.ui.cells.map((c) => c.label)).toEqual(
      Array.from({ length: 24 }, (_, i) => String((i % 6) + 1)),
    );
  });

  it('column bonuses: +1, yellow ?, fox, blue ?, green ?, pink ?', () => {
    const byValue = silver.ui.groups!.map((g) => g.bonus);
    expect(byValue).toEqual([plus1, free('yellow'), fox, free('blue'), free('green'), free('pink')]);
    // Completing column 3 fires the fox.
    const cells = silver.init();
    for (let r = 0; r < 3; r++) cells[silverGridCell(r, 3)] = 1;
    expect(silver.apply(cells, { area: 'silver', cell: silverGridCell(3, 3), value: 1 })).toEqual([
      fox,
    ]);
  });

  it('rows score independently: 1→2 ... 6→22', () => {
    const table = [0, 2, 4, 7, 11, 16, 22];
    const cells = silver.init();
    for (let n = 1; n <= 6; n++) {
      cells[silverGridCell(0, n)] = 1; // yellow row fills up
      expect(silver.score(cells)).toBe(table[n]);
    }
    for (let n = 1; n <= 3; n++) cells[silverGridCell(2, n)] = 1; // green row: 3 marks
    expect(silver.score(cells)).toBe(22 + 7);
  });
});

describe('yellow area', () => {
  const yellow = area('yellow');
  const valueCells = [1, 3, 4, 6, 9, 11, 12, 14, 17, 19];

  it('is the 10-cell lattice: 1 and 6 once, 2–5 twice, holes elsewhere', () => {
    expect(yellow.size).toBe(20);
    const labels = valueCells.map((c) => yellow.ui.cells[c].label);
    expect(labels).toEqual(['3', '6', '1', '2', '4', '3', '2', '5', '5', '4']);
    for (let i = 0; i < 20; i++) {
      expect(yellow.ui.cells[i].void ?? false).toBe(!valueCells.includes(i));
    }
  });

  it('row bonuses: blue ?, return, yellow ?, green ?, pink ?', () => {
    const rows = yellow.ui.groups!.filter((g) => g.kind === 'row');
    expect(rows.map((g) => ({ cells: g.cells, bonus: g.bonus }))).toEqual([
      { cells: [1, 3], bonus: free('blue') },
      { cells: [4, 6], bonus: ret },
      { cells: [9, 11], bonus: free('yellow') },
      { cells: [12, 14], bonus: free('green') },
      { cells: [17, 19], bonus: free('pink') },
    ]);
  });

  it('column bonuses: reroll, +1, silver ?, fox', () => {
    const cols = yellow.ui.groups!.filter((g) => g.kind === 'col');
    expect(cols.map((g) => ({ cells: g.cells, bonus: g.bonus }))).toEqual([
      { cells: [4, 12], bonus: reroll },
      { cells: [1, 9, 17], bonus: plus1 },
      { cells: [6, 14], bonus: free('silver') },
      { cells: [3, 11, 19], bonus: fox },
    ]);
  });

  it('crosses score 3, 10, ... 165; circles alone score nothing', () => {
    const cells = yellow.init();
    for (const c of valueCells) cells[c] = 1;
    expect(yellow.score(cells)).toBe(0);
    const table = [0, 3, 10, 21, 36, 55, 75, 96, 118, 141, 165];
    valueCells.forEach((c, i) => {
      cells[c] = 2;
      expect(yellow.score(cells)).toBe(table[i + 1]);
    });
  });
});

describe('blue area', () => {
  const blue = area('blue');

  it('has 12 slots scoring 1, 3, 6, ... 78 by count', () => {
    expect(blue.size).toBe(12);
    const cells = blue.init();
    const table = [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 66, 78];
    for (let i = 0; i < 12; i++) {
      cells[i] = 12 - i;
      expect(blue.score(cells)).toBe(table[i + 1]);
    }
  });

  it('slot bonuses: 2 return, 3 yellow ?, 5 +1, 6 reroll, 7 pink ?, 9 fox, 10 return, 12 green ?', () => {
    const bonuses = blue.ui.cells.map((c) => c.bonus);
    const expected = new Array<Effect | undefined>(12);
    expected[1] = ret;
    expected[2] = free('yellow');
    expected[4] = plus1;
    expected[5] = reroll;
    expected[6] = free('pink');
    expected[8] = fox;
    expected[9] = ret;
    expected[11] = free('green');
    expect(bonuses).toEqual(expected);
  });

  it('uses blue + white whichever die is placed', () => {
    expect(blue.effectiveValue({ white: 3, blue: 4 }, 'blue')).toBe(7);
    expect(blue.effectiveValue({ white: 3, blue: 4 }, 'white')).toBe(7);
    const s = statePicking([3, 1, 4, 1, 1, 1]); // white 3 + blue 4 = 7
    const fromBlue = diePlacements(s, v, die('blue')).filter((p) => p.area === 'blue');
    expect(fromBlue).toEqual([{ area: 'blue', cell: 0, value: 7 }]);
    const fromWhite = diePlacements(s, v, die('white')).filter((p) => p.area === 'blue');
    expect(fromWhite).toEqual([{ area: 'blue', cell: 0, value: 7 }]);
  });

  it('writes must not increase', () => {
    const cells = blue.init();
    cells[0] = 7;
    expect(blue.placements(cells, 8)).toEqual([]);
    expect(blue.placements(cells, 7)).toEqual([{ area: 'blue', cell: 1, value: 7 }]);
  });
});

describe('green area', () => {
  const green = area('green');

  it('multipliers 2 2 2 1 3 3 3 2 3 1 4 1 in 6 pairs', () => {
    expect(green.ui.cells.map((c) => c.label)).toEqual([
      '×2', '×2', '×2', '×1', '×3', '×3', '×3', '×2', '×3', '×1', '×4', '×1',
    ]);
    expect(green.ui.cells.map((c) => c.pair)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });

  it('slot bonuses: 2 reroll, 4 blue ?, 5 return, 7 fox, 8 silver ?, 9 +1, 11 pink ?, 12 yellow ?', () => {
    const bonuses = green.ui.cells.map((c) => c.bonus);
    const expected = new Array<Effect | undefined>(12);
    expected[1] = reroll;
    expected[3] = free('blue');
    expected[4] = ret;
    expected[6] = fox;
    expected[7] = free('silver');
    expected[8] = plus1;
    expected[10] = free('pink');
    expected[11] = free('yellow');
    expect(bonuses).toEqual(expected);
  });

  it('pairs score first − second and can go negative', () => {
    const cells = green.init();
    cells[0] = 2; // 1 × 2
    expect(green.score(cells)).toBe(0); // incomplete pair
    cells[1] = 12; // 6 × 2
    expect(green.score(cells)).toBe(-10);
    cells[2] = 12;
    cells[3] = 1; // 12 − 1
    expect(green.score(cells)).toBe(1);
  });
});

describe('pink area', () => {
  const pink = area('pink');

  it('slot bonuses with their ≥ thresholds', () => {
    const bonuses = pink.ui.cells.map((c) => c.bonus);
    const expected = new Array<Effect | undefined>(12);
    expected[2] = reroll;
    expected[3] = ret;
    expected[4] = plus1;
    expected[5] = free('green');
    expected[6] = free('yellow');
    expected[7] = fox;
    expected[8] = free('silver');
    expected[9] = reroll;
    expected[10] = free('blue');
    expected[11] = free('yellow');
    expect(bonuses).toEqual(expected);
    expect(pink.ui.cells.map((c) => c.label)).toEqual([
      null, null, '≥2', '≥3', '≥4', '≥5', '≥6', '≥2', '≥3', '≥4', '≥5', '≥6',
    ]);
  });

  it('a write below the threshold fills the slot but withholds the bonus', () => {
    const cells = pink.init();
    cells[0] = cells[1] = cells[2] = cells[3] = 6;
    expect(pink.apply(cells, { area: 'pink', cell: 4, value: 3 })).toEqual([]); // 3 < 4
    expect(pink.apply(cells, { area: 'pink', cell: 5, value: 5 })).toEqual([free('green')]);
  });

  it('scores the sum of written values', () => {
    const cells = pink.init();
    [6, 6, 5, 3, 1, 2].forEach((x, i) => (cells[i] = x));
    expect(pink.score(cells)).toBe(23);
  });
});

describe('scoring', () => {
  it('total = areas + foxes × min area, with negative green pulling foxes down', () => {
    const s = newGame(v);
    for (let n = 1; n <= 4; n++) s.areas.silver[silverGridCell(0, n)] = 1; // 11
    s.areas.yellow[1] = s.areas.yellow[3] = 2; // 2 crosses → 10
    s.areas.blue = [10, 9, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 3 filled → 6
    s.areas.green = [4, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 4 − 6 = −2
    s.areas.pink = [5, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 8
    s.foxes = 2;
    const br = scoreState(s, v);
    expect(br.areas).toEqual({ silver: 11, yellow: 10, blue: 6, green: -2, pink: 8 });
    expect(br.minArea).toBe(-2);
    expect(br.foxPoints).toBe(-4);
    expect(br.total).toBe(11 + 10 + 6 - 2 + 8 - 4);
  });
});

describe('full games', () => {
  it('random games terminate, are deterministic per seed, and stay in bounds', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const a = playGame(v, makeRandom(), seed);
      const b = playGame(v, makeRandom(), seed);
      expect(a.score.total).toBe(b.score.total);
      expect(a.state.round).toBe(6);
      expect(a.state.phase).toBe('over');
      expect(a.score.total).toBeGreaterThan(-200);
      expect(a.score.total).toBeLessThan(600);
    }
  });
});
