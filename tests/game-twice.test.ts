/**
 * Flow tests for the Twice as Clever game.ts mechanics: platter-chain silver
 * marks, the silver-die pick ban, the preRoll return window, action-bar caps
 * with end-of-bar bonuses, per-round +1 flags, and free (?) resolution.
 *
 * These run against the real variant; the sheet-data checks live in
 * tests/twice-as-clever.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  applyActionMut,
  getPending,
  mulberry32,
  newGame,
  resolveChanceMut,
  silverGridCell,
  thatsPrettyClever,
  twiceAsClever,
  type Action,
  type Effect,
  type GameState,
  type Placement,
} from '../src/engine';
import { makeRandom } from '../src/strategies';
import { playGame } from '../src/sim/runner';

const free = (area: string): Effect => ({ t: 'free', area });
const blackQ: Effect = {
  t: 'choice',
  label: 'Round 4 bonus: any colored ?',
  options: [free('silver'), free('yellow'), free('blue'), free('green'), free('pink')],
};

const tv = twiceAsClever;

// Die ids in tv.colors order.
const W = 0; // white (wild)
const Y = 1; // yellow
const B = 2; // blue
const G = 3; // green
const P = 4; // pink
const S = 5; // silver

/** Fresh round-1 state in the pick phase with chosen faces [W, Y, B, G, P, S]. */
function statePicking(faces: number[]): GameState {
  const s = newGame(tv);
  s.faces = faces.slice();
  s.phase = 'pick';
  return s;
}

/** The decision actions at the current node (throws on chance/over). */
function actions(s: GameState): Action[] {
  const node = getPending(s, tv);
  if (node.kind !== 'decision') throw new Error(`expected decision node, got ${node.kind}`);
  return node.actions;
}

const mark = (area: string, cell: number): Placement => ({ area, cell, value: 1 });

describe('platter chain', () => {
  it('colored dice moved by a silver pick auto-mark their own rows', () => {
    // Pick silver 4: yellow(2) and blue(3) move; white/green/pink (≥4) stay.
    const s = statePicking([6, 2, 3, 5, 6, 4]);
    applyActionMut(s, tv, { t: 'pick', die: S, placement: mark('silver', silverGridCell(0, 4)) });
    expect(s.areas.silver[silverGridCell(0, 2)]).toBe(1); // yellow row, value 2
    expect(s.areas.silver[silverGridCell(1, 3)]).toBe(1); // blue row, value 3
    expect(s.pending).toHaveLength(0);
    expect(s.stats.bonusesLost).toBe(0);
    expect(s.phase).toBe('roll'); // returns = 0 → no window
  });

  it('the moved white die queues a row choice; autos apply first', () => {
    // Pick silver 5: white(2) → row choice, yellow(3)/blue(4) → auto rows.
    const s = statePicking([2, 3, 4, 6, 6, 5]);
    applyActionMut(s, tv, { t: 'pick', die: S, placement: mark('silver', silverGridCell(2, 5)) });
    expect(s.areas.silver[silverGridCell(0, 3)]).toBe(1); // yellow auto
    expect(s.areas.silver[silverGridCell(1, 4)]).toBe(1); // blue auto
    expect(s.pending).toEqual([{ t: 'silverMark', value: 2, row: null }]);
    const acts = actions(s);
    expect(acts.map((a) => (a.t === 'bonus' ? a.placement?.cell : -1)).sort((a, b) => a! - b!)).toEqual(
      [1, 7, 13, 19], // value 2 open in all four rows
    );
    applyActionMut(s, tv, acts[2]);
    expect(s.areas.silver[silverGridCell(2, 2)]).toBe(1);
    expect(s.pending).toHaveLength(0);
  });

  it('the moved silver die (picked white) marks any row of its value', () => {
    // White placed as silver 4; silver die (2) moves → row-less mark.
    const s = statePicking([4, 6, 6, 6, 6, 2]);
    applyActionMut(s, tv, { t: 'pick', die: W, placement: mark('silver', silverGridCell(0, 4)) });
    expect(s.pending).toEqual([{ t: 'silverMark', value: 2, row: null }]);
  });

  it('a chain mark whose row cell is taken is lost, never queued', () => {
    const s = statePicking([5, 2, 5, 5, 5, 4]);
    s.areas.silver[silverGridCell(0, 2)] = 1; // yellow row's 2 already marked
    applyActionMut(s, tv, { t: 'pick', die: S, placement: mark('silver', silverGridCell(1, 4)) });
    expect(s.stats.bonusesLost).toBe(1);
    expect(s.pending).toHaveLength(0);
  });

  it('only dice moved by THIS pick are marked', () => {
    const s = statePicking([6, 2, 3, 1, 6, 4]);
    s.loc[G] = 'platter'; // green (1) was already on the platter
    applyActionMut(s, tv, { t: 'pick', die: S, placement: mark('silver', silverGridCell(3, 4)) });
    expect(s.areas.silver[silverGridCell(0, 2)]).toBe(1); // yellow moved now
    expect(s.areas.silver[silverGridCell(1, 3)]).toBe(1); // blue moved now
    expect(s.areas.silver[silverGridCell(2, 1)]).toBe(0); // green: no mark
    expect(s.pending).toHaveLength(0);
  });

  it('row choices resolve before other effects queued by the same pick', () => {
    // The silver placement completes column 4 → free('blue') queued; the
    // moved silver die's row choice must still come first.
    const s = statePicking([4, 6, 6, 6, 6, 2]);
    for (let r = 0; r < 3; r++) s.areas.silver[silverGridCell(r, 4)] = 1;
    applyActionMut(s, tv, { t: 'pick', die: W, placement: mark('silver', silverGridCell(3, 4)) });
    expect(s.pending.map((e) => e.t)).toEqual(['silverMark', 'free']);
    applyActionMut(s, tv, actions(s)[0]); // resolve the mark
    expect(s.pending.map((e) => e.t)).toEqual(['free']);
  });

  it('no chain from picks into other areas', () => {
    const s = statePicking([1, 3, 6, 6, 6, 2]);
    applyActionMut(s, tv, { t: 'pick', die: Y, placement: mark('yellow', 1) });
    expect(s.loc[W]).toBe('platter');
    expect(s.loc[S]).toBe('platter');
    expect(s.pending).toHaveLength(0);
    expect(s.areas.silver.every((c) => c === 0)).toBe(true);
  });

  it('no chain from a passive pick into silver', () => {
    const s = newGame(tv);
    s.faces = [3, 2, 6, 6, 6, 4];
    s.loc = ['platter', 'platter', 'pool', 'pool', 'pool', 'platter'];
    s.phase = 'passivePick';
    applyActionMut(s, tv, {
      t: 'passivePick',
      die: S,
      placement: mark('silver', silverGridCell(0, 4)),
    });
    expect(s.phase).toBe('passiveEndTurn');
    expect(s.pending).toHaveLength(0);
    expect(s.areas.silver.reduce((a, b) => a + b, 0)).toBe(1); // only the pick itself
  });

  it('no chain from a +1 placement into silver', () => {
    const s = newGame(tv);
    s.faces = [3, 2, 6, 6, 6, 4];
    s.loc = ['platter', 'platter', 'pool', 'pool', 'pool', 'platter'];
    s.phase = 'endTurn';
    s.plus1 = 1;
    applyActionMut(s, tv, { t: 'plus1', die: S, placement: mark('silver', silverGridCell(1, 4)) });
    expect(s.pending).toHaveLength(0);
    expect(s.areas.silver.reduce((a, b) => a + b, 0)).toBe(1);
    expect(s.plus1Used[S]).toBe(true);
  });
});

describe('silver-die pick ban', () => {
  it('a silver die with no open cell of its value is not offered at all', () => {
    const s = statePicking([6, 1, 6, 6, 6, 3]);
    s.loc = ['field', 'pool', 'field', 'field', 'field', 'pool']; // pool: yellow, silver
    for (let r = 0; r < 4; r++) s.areas.silver[silverGridCell(r, 3)] = 1; // all 3s marked
    const acts = actions(s);
    expect(acts.some((a) => a.t === 'pick' && a.die === S)).toBe(false);
    expect(acts.some((a) => a.t === 'pick' && a.die === Y && a.placement)).toBe(true);
    expect(acts.some((a) => a.t === 'skip')).toBe(false); // yellow still has a placement
  });

  it('other dice keep the wasted-pick fallback', () => {
    const s = statePicking([6, 1, 6, 6, 6, 3]);
    s.loc = ['field', 'pool', 'field', 'field', 'field', 'pool'];
    for (let r = 0; r < 4; r++) s.areas.silver[silverGridCell(r, 3)] = 1;
    s.areas.yellow[4] = 2; // the lattice's only 1 is crossed → yellow has nothing
    const acts = actions(s);
    expect(acts.some((a) => a.t === 'pick' && a.die === Y && !a.placement)).toBe(true);
    expect(acts.some((a) => a.t === 'pick' && a.die === S)).toBe(false);
    expect(acts.some((a) => a.t === 'skip')).toBe(true);
  });
});

describe('return window (preRoll)', () => {
  it('opens after a pick when a return is unlocked and the platter is non-empty', () => {
    const s = statePicking([1, 3, 6, 6, 6, 6]);
    s.returns = 1;
    applyActionMut(s, tv, { t: 'pick', die: Y, placement: mark('yellow', 1) });
    expect(s.phase).toBe('preRoll');
    expect(actions(s)).toEqual([{ t: 'return', die: W }, { t: 'proceed' }]);
    applyActionMut(s, tv, { t: 'return', die: W });
    expect(s.loc[W]).toBe('pool');
    expect(s.returns).toBe(0);
    expect(s.stats.returnsUsed).toBe(1);
    expect(s.phase).toBe('roll'); // no returns left → window closes
  });

  it('stays open while returns and platter dice remain; proceed rolls', () => {
    const s = statePicking([1, 3, 2, 6, 6, 6]);
    s.returns = 2;
    applyActionMut(s, tv, { t: 'pick', die: Y, placement: mark('yellow', 1) });
    expect(s.phase).toBe('preRoll');
    expect(actions(s)).toEqual([
      { t: 'return', die: W },
      { t: 'return', die: B },
      { t: 'proceed' },
    ]);
    applyActionMut(s, tv, { t: 'return', die: W });
    expect(s.phase).toBe('preRoll'); // 1 return and the blue die remain
    applyActionMut(s, tv, { t: 'proceed' });
    expect(s.phase).toBe('roll');
    expect(s.returns).toBe(1);
  });

  it('opens before a reroll, so a returned die joins it', () => {
    const s = statePicking([4, 4, 4, 4, 4, 4]);
    s.returns = 1;
    s.loc[W] = 'platter';
    applyActionMut(s, tv, { t: 'reroll' });
    expect(s.phase).toBe('preRoll');
    applyActionMut(s, tv, { t: 'return', die: W });
    expect(s.loc[W]).toBe('pool'); // white is rolled with the reroll
    expect(s.phase).toBe('roll');
  });

  it('does not open when the platter is empty', () => {
    const s = statePicking([6, 1, 6, 6, 6, 6]);
    s.returns = 1;
    applyActionMut(s, tv, { t: 'pick', die: Y, placement: mark('yellow', 4) });
    expect(s.phase).toBe('roll'); // nothing moved
  });

  it('never opens on the passive turn', () => {
    const s = statePicking([1, 2, 3, 4, 5, 6]);
    s.returns = 3;
    s.phase = 'endTurn';
    applyActionMut(s, tv, { t: 'endTurn' });
    expect(s.phase).toBe('passiveRoll');
    resolveChanceMut(s, tv, mulberry32(7));
    expect(s.phase).toBe('passivePick');
    applyActionMut(s, tv, { t: 'passiveSkip' });
    expect(s.phase).toBe('passiveEndTurn');
    applyActionMut(s, tv, { t: 'endTurn' });
    expect(s.round).toBe(2);
    expect(s.phase).toBe('roll'); // round start clears the platter
  });
});

describe('action bars', () => {
  it('an unlock past the bar size is lost', () => {
    const s = statePicking([3, 3, 3, 3, 5, 3]);
    s.areas.pink[0] = s.areas.pink[1] = 5;
    s.barUnlocks.reroll = 6;
    const rerollsBefore = s.rerolls;
    // Pink slot 2 (≥2) grants a reroll — the bar is already full.
    applyActionMut(s, tv, { t: 'pick', die: P, placement: { area: 'pink', cell: 2, value: 5 } });
    expect(s.stats.bonusesLost).toBe(1);
    expect(s.rerolls).toBe(rerollsBefore);
    expect(s.barUnlocks.reroll).toBe(6);
    expect(s.foxes).toBe(0); // the end bonus does not re-fire
  });

  it('circling the last slot fires the end bonus exactly then', () => {
    const s = statePicking([3, 3, 3, 3, 5, 3]);
    s.areas.pink[0] = s.areas.pink[1] = 5;
    s.barUnlocks.reroll = 5;
    s.rerolls = 0;
    applyActionMut(s, tv, { t: 'pick', die: P, placement: { area: 'pink', cell: 2, value: 5 } });
    expect(s.barUnlocks.reroll).toBe(6);
    expect(s.rerolls).toBe(1); // the capping unlock itself still counts
    expect(s.foxes).toBe(1); // reroll bar's end bonus
    expect(s.stats.bonusesLost).toBe(0);
  });

  it('the return bar unlocks returns and ends in a pink ?', () => {
    const s = statePicking([3, 3, 3, 3, 3, 3]);
    s.areas.pink[0] = s.areas.pink[1] = s.areas.pink[2] = 5;
    s.barUnlocks.return = 5;
    // Pink slot 3 (≥3) grants a return — the sixth: end bonus free('pink').
    applyActionMut(s, tv, { t: 'pick', die: P, placement: { area: 'pink', cell: 3, value: 3 } });
    expect(s.returns).toBe(1);
    expect(s.barUnlocks.return).toBe(6);
    expect(s.pending).toEqual([{ t: 'free', area: 'pink' }]);
    const acts = actions(s);
    expect(acts).toHaveLength(6); // values 1–6 at pink slot 4
    applyActionMut(s, tv, { t: 'bonus', placement: { area: 'pink', cell: 4, value: 1 } });
    expect(s.areas.pink[4]).toBe(1); // below the ≥4 gate → no chained +1
    expect(s.plus1).toBe(0);
  });
});

describe('plus1Scope round', () => {
  it('keeps +1 usage across active → passive and resets at round start', () => {
    const s = statePicking([1, 1, 1, 1, 1, 1]);
    s.plus1Used[G] = true;
    s.phase = 'endTurn';
    applyActionMut(s, tv, { t: 'endTurn' });
    expect(s.phase).toBe('passiveRoll');
    expect(s.plus1Used[G]).toBe(true); // persists into the passive segment
    s.phase = 'passiveEndTurn';
    applyActionMut(s, tv, { t: 'endTurn' });
    expect(s.round).toBe(2);
    expect(s.plus1Used[G]).toBe(false); // reset with the new round
  });

  it("the base variant's per-turn reset is unchanged", () => {
    const s = newGame(thatsPrettyClever);
    s.plus1Used[2] = true;
    s.phase = 'endTurn';
    applyActionMut(s, thatsPrettyClever, { t: 'endTurn' });
    expect(s.plus1Used[2]).toBe(false);
  });
});

describe('free (?) bonuses', () => {
  it('yellow free offers circles and crosses via placement-carrying actions', () => {
    const s = statePicking([1, 1, 1, 1, 1, 1]);
    s.pending.push(free('yellow'));
    expect(actions(s)).toHaveLength(10); // all ten circles
    applyActionMut(s, tv, { t: 'bonus', placement: { area: 'yellow', cell: 4, value: 1 } });
    expect(s.areas.yellow[4]).toBe(1); // circled
    s.pending.push(free('yellow'));
    const acts = actions(s);
    expect(acts).toHaveLength(10); // nine circles + the cross on cell 4
    expect(
      acts.some((a) => a.t === 'bonus' && a.placement?.cell === 4 && a.placement.value === 2),
    ).toBe(true);
    applyActionMut(s, tv, { t: 'bonus', placement: { area: 'yellow', cell: 4, value: 2 } });
    expect(s.areas.yellow[4]).toBe(2); // crossed
  });

  it('blue free respects the descend constraint and chains cell bonuses', () => {
    const s = statePicking([1, 1, 1, 1, 1, 1]);
    s.areas.blue[0] = 5;
    s.pending.push(free('blue'));
    const acts = actions(s);
    expect(acts.map((a) => (a.t === 'bonus' ? a.placement?.value : 0))).toEqual([2, 3, 4, 5]);
    applyActionMut(s, tv, { t: 'bonus', placement: { area: 'blue', cell: 1, value: 5 } });
    expect(s.areas.blue[1]).toBe(5);
    expect(s.returns).toBe(1); // blue slot 2's return bonus chained
    expect(s.barUnlocks.return).toBe(1);
  });

  it('a black-? style choice expands into the chosen free', () => {
    const s = statePicking([1, 1, 1, 1, 1, 1]);
    s.areas.green = s.areas.green.map(() => 1); // green full → that option gone
    s.pending.push(blackQ);
    const acts = actions(s);
    expect(acts.map((a) => (a.t === 'bonus' ? a.option : -1))).toEqual([0, 1, 2, 4]);
    applyActionMut(s, tv, { t: 'bonus', option: 2 }); // free('blue')
    expect(s.pending).toEqual([free('blue')]);
    applyActionMut(s, tv, { t: 'bonus', placement: { area: 'blue', cell: 0, value: 12 } });
    expect(s.areas.blue[0]).toBe(12);
    expect(s.pending).toHaveLength(0);
  });

  it('a queued free that becomes unresolvable is dropped by normalizePending', () => {
    const s = statePicking([1, 1, 1, 1, 1, 1]);
    for (let i = 0; i < 11; i++) s.areas.pink[i] = 5; // one slot left
    s.pending.push(free('pink'), free('pink'));
    applyActionMut(s, tv, { t: 'bonus', placement: { area: 'pink', cell: 11, value: 1 } });
    expect(s.pending).toHaveLength(0); // second free dropped: pink is full
    expect(s.stats.bonusesLost).toBe(1);
  });

  it('a queued silverMark that becomes unresolvable is dropped too', () => {
    const s = statePicking([1, 1, 1, 1, 1, 1]);
    for (let r = 0; r < 3; r++) s.areas.silver[silverGridCell(r, 3)] = 1; // one 3 left
    s.pending.push({ t: 'silverMark', value: 3, row: null }, { t: 'silverMark', value: 3, row: null });
    expect(actions(s)).toHaveLength(1);
    applyActionMut(s, tv, { t: 'bonus', placement: mark('silver', silverGridCell(3, 3)) });
    expect(s.pending).toHaveLength(0); // second mark dropped: value 3 exhausted
    expect(s.stats.bonusesLost).toBe(1);
    expect(s.foxes).toBe(1); // column 3 completed → fox
  });
});

describe('full games', () => {
  it('random games terminate, are deterministic per seed, and reach round 6', () => {
    for (let seed = 1; seed <= 15; seed++) {
      const a = playGame(tv, makeRandom(), seed);
      const b = playGame(tv, makeRandom(), seed);
      expect(a.score.total).toBe(b.score.total);
      expect(a.state.round).toBe(6);
      expect(a.score.total).toBeGreaterThan(-200);
      expect(a.score.total).toBeLessThan(600);
    }
  });
});
