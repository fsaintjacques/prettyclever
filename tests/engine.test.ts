import { describe, expect, it } from 'vitest';
import {
  applyAction,
  applyActionMut,
  diePlacements,
  getPending,
  mulberry32,
  newGame,
  resolveChanceMut,
  scoreState,
  thatsPrettyClever,
  type Action,
  type GameState,
} from '../src/engine';
import { makeRandom } from '../src/strategies';
import { playGame } from '../src/sim/runner';

const v = thatsPrettyClever;
const die = (color: string) => v.colors.indexOf(color as never);

/** Fresh round-1 state in the pick phase with chosen faces (order: white yellow blue green orange purple). */
function statePicking(faces: number[]): GameState {
  const s = newGame(v);
  s.faces = faces.slice();
  s.phase = 'pick';
  return s;
}

describe('setup', () => {
  it('round 1 grants a reroll', () => {
    const s = newGame(v);
    expect(s.rerolls).toBe(1);
    expect(s.plus1).toBe(0);
    expect(s.phase).toBe('roll');
  });

  it('yellow starts with the 4 printed crosses', () => {
    const s = newGame(v);
    expect(s.areas.yellow.filter((c) => c === 1)).toHaveLength(4);
    expect(scoreState(s, v).total).toBe(0);
  });
});

describe('placements', () => {
  it('yellow die can cross both open cells with its value', () => {
    const s = statePicking([2, 4, 2, 2, 2, 2]);
    const ps = diePlacements(s, v, die('yellow'));
    // value 4 appears at cells 11 and 14
    expect(ps.map((p) => p.cell).sort()).toEqual([11, 14]);
  });

  it('blue area uses blue + white regardless of which die is placed', () => {
    const s = statePicking([3, 1, 4, 1, 1, 1]); // white 3, blue 4 → 7 (cell 5)
    const blue = diePlacements(s, v, die('blue')).filter((p) => p.area === 'blue');
    expect(blue).toEqual([{ area: 'blue', cell: 5, value: 1 }]);
    const white = diePlacements(s, v, die('white')).filter((p) => p.area === 'blue');
    expect(white).toEqual([{ area: 'blue', cell: 5, value: 1 }]);
  });

  it('white is wild for the four color areas', () => {
    const s = statePicking([5, 1, 1, 1, 1, 1]);
    const areas = new Set(diePlacements(s, v, die('white')).map((p) => p.area));
    expect(areas).toEqual(new Set(['yellow', 'blue', 'green', 'orange', 'purple']));
  });

  it('green requires meeting the threshold', () => {
    const s = statePicking([1, 1, 1, 2, 1, 1]);
    expect(diePlacements(s, v, die('green'))).toHaveLength(1); // ≥1 ok
    s.areas.green = [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]; // next needs ≥4
    expect(diePlacements(s, v, die('green'))).toHaveLength(0);
    s.faces[die('green')] = 4;
    expect(diePlacements(s, v, die('green'))).toEqual([{ area: 'green', cell: 3, value: 1 }]);
  });

  it('orange multiplies on ×2/×3 slots', () => {
    const s = statePicking([1, 1, 1, 1, 5, 1]);
    s.areas.orange = [3, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0]; // next slot is ×2
    expect(diePlacements(s, v, die('orange'))).toEqual([{ area: 'orange', cell: 3, value: 10 }]);
  });

  it('purple must ascend and resets after a 6', () => {
    const s = statePicking([1, 1, 1, 1, 1, 3]);
    s.areas.purple = [4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(diePlacements(s, v, die('purple'))).toHaveLength(0); // 3 not > 4
    s.faces[die('purple')] = 5;
    expect(diePlacements(s, v, die('purple'))).toEqual([{ area: 'purple', cell: 1, value: 5 }]);
    s.areas.purple = [6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    s.faces[die('purple')] = 1; // anything after a 6
    expect(diePlacements(s, v, die('purple'))).toEqual([{ area: 'purple', cell: 1, value: 1 }]);
  });
});

describe('silver platter', () => {
  it('picking a die sends strictly lower dice to the platter', () => {
    const s = statePicking([2, 4, 3, 4, 1, 6]);
    // pick yellow 4 → white(2), blue(3), orange(1) to platter; green(4), purple(6) stay
    const a: Action = { t: 'pick', die: die('yellow'), placement: { area: 'yellow', cell: 11, value: 1 } };
    const ns = applyAction(s, v, a);
    expect(ns.loc[die('white')]).toBe('platter');
    expect(ns.loc[die('blue')]).toBe('platter');
    expect(ns.loc[die('orange')]).toBe('platter');
    expect(ns.loc[die('green')]).toBe('pool');
    expect(ns.loc[die('purple')]).toBe('pool');
    expect(ns.loc[die('yellow')]).toBe('field');
    expect(ns.phase).toBe('roll');
  });

  it('turn ends early when no dice remain', () => {
    const s = statePicking([1, 1, 1, 1, 1, 6]);
    const a: Action = { t: 'pick', die: die('purple'), placement: { area: 'purple', cell: 0, value: 6 } };
    const ns = applyAction(s, v, a);
    expect(ns.phase).toBe('endTurn'); // everything else was lower
  });
});

describe('bonus cascades', () => {
  it('completing yellow row 2 writes an orange 4', () => {
    const s = statePicking([1, 2, 1, 1, 1, 1]);
    s.areas.yellow = [0, 0, 0, 1, 0, 1, 1, 1, 0, 1, 0, 0, 1, 0, 0, 0]; // row2: cells 5,6,7 done, 4 open (value 2)
    const a: Action = { t: 'pick', die: die('yellow'), placement: { area: 'yellow', cell: 4, value: 1 } };
    const ns = applyAction(s, v, a);
    expect(ns.areas.orange[0]).toBe(4);
  });

  it('completing the yellow diagonal grants a +1', () => {
    const s = statePicking([1, 6, 1, 1, 1, 1]);
    s.areas.yellow = [1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 0]; // diag 0,5,10 done; 15 open (value 6)
    const ns = applyAction(s, v, {
      t: 'pick',
      die: die('yellow'),
      placement: { area: 'yellow', cell: 15, value: 1 },
    });
    expect(ns.plus1).toBe(1);
    // row 4 (12,13,14,15) not complete → no fox
    expect(ns.foxes).toBe(0);
  });

  it('yellow X bonus queues a choice among open yellow cells', () => {
    const s = statePicking([1, 1, 4, 1, 1, 1]); // blue+white = 5 → blue cell 3
    s.areas.blue = [0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0]; // blue row2 cells 4,5,6 done, 3 open
    const ns = applyAction(s, v, {
      t: 'pick',
      die: die('blue'),
      placement: { area: 'blue', cell: 3, value: 1 },
    });
    expect(ns.pending).toHaveLength(1);
    const node = getPending(ns, v);
    expect(node.kind).toBe('decision');
    if (node.kind === 'decision') {
      expect(node.actions.every((a) => a.t === 'bonus')).toBe(true);
      expect(node.actions).toHaveLength(12); // 12 open yellow cells
      const done = applyAction(ns, v, node.actions[0]);
      expect(done.pending).toHaveLength(0);
      expect(done.areas.yellow.filter((c) => c === 1)).toHaveLength(5);
    }
  });

  it('blue column {5,9} completion grants a reroll', () => {
    const s = statePicking([4, 1, 5, 1, 1, 1]); // blue+white = 9 → cell 7
    s.areas.blue = [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]; // cell 3 (the 5) done
    const ns = applyAction(s, v, {
      t: 'pick',
      die: die('blue'),
      placement: { area: 'blue', cell: 7, value: 1 },
    });
    expect(ns.rerolls).toBe(2); // 1 from round 1 + 1 from column
  });

  it('chains: green cell 7 (fox) via green X from blue column', () => {
    const s = statePicking([2, 1, 4, 1, 1, 1]); // blue+white 6 → blue cell 4
    s.areas.blue = [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]; // col {0,4,8}: 0 and 8 done
    s.areas.green = [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]; // next green is cell 6 = fox
    const ns = applyAction(s, v, {
      t: 'pick',
      die: die('blue'),
      placement: { area: 'blue', cell: 4, value: 1 },
    });
    expect(ns.areas.green[6]).toBe(1);
    expect(ns.foxes).toBe(1);
  });

  it('bonuses that cannot be applied are lost', () => {
    const s = statePicking([1, 1, 1, 1, 6, 1]);
    s.areas.purple = [1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5]; // purple full
    s.areas.orange = [1, 1, 1, 2, 1, 1, 2, 1, 2, 0, 0]; // next orange slot 9 = purple-6 bonus
    const ns = applyAction(s, v, {
      t: 'pick',
      die: die('orange'),
      placement: { area: 'orange', cell: 9, value: 6 },
    });
    expect(ns.stats.bonusesLost).toBe(1);
  });
});

describe('round flow', () => {
  it('active → passive → next round with bonuses', () => {
    const rng = mulberry32(42);
    const s = newGame(v);
    resolveChanceMut(s, v, rng);
    expect(s.phase).toBe('pick');
    // burn three picks via skip-equivalent wasted picks or skips
    const node = getPending(s, v);
    expect(node.kind).toBe('decision');
    applyActionMut(s, v, { t: 'skip' });
    applyActionMut(s, v, { t: 'skip' });
    applyActionMut(s, v, { t: 'skip' });
    expect(s.phase).toBe('endTurn');
    applyActionMut(s, v, { t: 'endTurn' });
    expect(s.phase).toBe('passiveRoll');
    resolveChanceMut(s, v, rng);
    expect(s.phase).toBe('passivePick');
    expect(s.loc.filter((l) => l === 'platter')).toHaveLength(3);
    // platter dice are the three lowest
    const platterMax = Math.max(...s.loc.map((l, i) => (l === 'platter' ? s.faces[i] : -1)));
    const poolMin = Math.min(...s.loc.map((l, i) => (l === 'pool' ? s.faces[i] : 7)));
    expect(platterMax).toBeLessThanOrEqual(poolMin);
    applyActionMut(s, v, { t: 'passiveSkip' });
    expect(s.phase).toBe('passiveEndTurn');
    applyActionMut(s, v, { t: 'endTurn' });
    expect(s.round).toBe(2);
    expect(s.plus1).toBe(1); // round 2 bonus
  });

  it('round 4 grants the black X|6 choice', () => {
    const s = newGame(v);
    s.round = 3;
    s.phase = 'passiveEndTurn';
    applyActionMut(s, v, { t: 'endTurn' });
    expect(s.round).toBe(4);
    const node = getPending(s, v);
    expect(node.kind).toBe('decision');
    if (node.kind === 'decision') {
      expect(node.actions).toHaveLength(5);
      // take option 4: purple 6
      applyActionMut(s, v, { t: 'bonus', option: 4 });
      expect(s.areas.purple[0]).toBe(6);
    }
  });

  it('reroll rerolls the pool and spends the action', () => {
    const s = statePicking([1, 1, 1, 1, 1, 1]);
    applyActionMut(s, v, { t: 'reroll' });
    expect(s.rerolls).toBe(0);
    expect(s.phase).toBe('roll');
  });
});

describe('scoring', () => {
  it('matches the rulebook tables', () => {
    const s = newGame(v);
    s.areas.yellow = s.areas.yellow.map(() => 1); // all columns → 10+14+16+20
    s.areas.blue = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]; // 5 crossed → 11
    s.areas.green = [1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0]; // 7 → 28
    s.areas.orange = [3, 5, 2, 8, 0, 0, 0, 0, 0, 0, 0]; // 18
    s.areas.purple = [2, 4, 6, 1, 0, 0, 0, 0, 0, 0, 0]; // 13
    s.foxes = 3;
    const br = scoreState(s, v);
    expect(br.areas.yellow).toBe(60);
    expect(br.areas.blue).toBe(11);
    expect(br.areas.green).toBe(28);
    expect(br.areas.orange).toBe(18);
    expect(br.areas.purple).toBe(13);
    expect(br.minArea).toBe(11);
    expect(br.foxPoints).toBe(33);
    expect(br.total).toBe(60 + 11 + 28 + 18 + 13 + 33);
  });

  it('foxes are worthless when an area is empty', () => {
    const s = newGame(v);
    s.foxes = 5;
    expect(scoreState(s, v).foxPoints).toBe(0);
  });
});

describe('full games', () => {
  it('random games terminate, are deterministic per seed, and stay in bounds', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const a = playGame(v, makeRandom(), seed);
      const b = playGame(v, makeRandom(), seed);
      expect(a.score.total).toBe(b.score.total);
      expect(a.score.total).toBeGreaterThanOrEqual(0);
      expect(a.score.total).toBeLessThan(400);
      expect(a.state.round).toBe(6);
    }
  });
});

describe('mulberry32 state save/restore', () => {
  it('setState resumes the exact stream mid-way', () => {
    const rng = mulberry32(1234);
    rng();
    rng();
    const saved = rng.getState();
    const ahead = [rng(), rng(), rng()];

    const resumed = mulberry32(1234);
    resumed.setState(saved);
    expect([resumed(), resumed(), resumed()]).toEqual(ahead);
  });

  it('a JSON round-tripped state plus restored rng replays the same continuation', () => {
    // The uninterrupted game: roll, skip, roll again.
    const control = mulberry32(77);
    const c = newGame(thatsPrettyClever);
    resolveChanceMut(c, thatsPrettyClever, control);
    const c2 = applyAction(c, thatsPrettyClever, { t: 'skip' });
    resolveChanceMut(c2, thatsPrettyClever, control);

    // The same game snapshotted after the first roll (as the browser would
    // persist it) and resumed with a fresh rng set to the saved state.
    const rng = mulberry32(77);
    const s = newGame(thatsPrettyClever);
    resolveChanceMut(s, thatsPrettyClever, rng);
    const frozen = JSON.parse(JSON.stringify(s)) as GameState;
    const restored = mulberry32(77);
    restored.setState(rng.getState());
    const s2 = applyAction(frozen, thatsPrettyClever, { t: 'skip' });
    resolveChanceMut(s2, thatsPrettyClever, restored);

    expect(s2.faces).toEqual(c2.faces);
  });
});
