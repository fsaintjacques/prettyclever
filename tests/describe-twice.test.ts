/**
 * UI description coverage for the Twice as Clever variant: every new action
 * and effect shape (return window, free ? placements, platter-chain silver
 * marks, two-state yellow, the write tracks) plus base-variant phrasing
 * invariance and a full random-game sweep over both variants (the Watch tab
 * runs describeAction on every logged action).
 */
import { describe, expect, it } from 'vitest';
import {
  applyActionMut,
  getPending,
  mulberry32,
  newGame,
  resolveChanceMut,
  thatsPrettyClever,
  twiceAsClever,
  type Action,
  type Effect,
  type GameState,
  type VariantDef,
} from '../src/engine';
import { makeRandom } from '../src/strategies';
import { describeAction, describeEffect } from '../src/ui/describe';

const tv = twiceAsClever;

// Die ids in tv.colors order: white, yellow, blue, green, pink, silver.
const P = 4;

/** Fresh round-1 twice state in the pick phase with the given faces. */
function statePicking(faces: number[]): GameState {
  const s = newGame(tv);
  s.pending = []; // drop the round-1 bonus; these tests craft their own heads
  s.faces = faces.slice();
  s.phase = 'pick';
  return s;
}

function actionTexts(s: GameState, v: VariantDef = tv): string[] {
  const node = getPending(s, v);
  if (node.kind !== 'decision') throw new Error(`expected decision node, got ${node.kind}`);
  return node.actions.map((a) => describeAction(s, v, a));
}

describe('describeEffect (twice effects)', () => {
  it('names the new effect kinds', () => {
    expect(describeEffect({ t: 'return' })).toBe('↩ return');
    expect(describeEffect({ t: 'free', area: 'pink' })).toBe('? in pink');
    expect(describeEffect({ t: 'silverMark', value: 4, row: 'green' })).toBe(
      'silver 4 (green row)',
    );
    expect(describeEffect({ t: 'silverMark', value: 4, row: null })).toBe('silver 4 (any row)');
  });

  it('spells out the black ? choice', () => {
    const blackQ = tv.roundBonuses[3]!;
    expect(describeEffect(blackQ)).toBe(
      '? in silver / ? in yellow / ? in blue / ? in green / ? in pink',
    );
  });
});

describe('describeAction (twice picks)', () => {
  it('describes picks into every twice area', () => {
    // W=1 Y=3 B=2 G=4 P=5 S=4; blue writes blue+white = 3, green writes 4×2.
    const s = statePicking([1, 3, 2, 4, 5, 4]);
    const texts = actionTexts(s);
    expect(texts).toContain('takes yellow 3 → circle Yellow 3');
    expect(texts).toContain('takes blue 2 → Blue slot 1 = 3');
    expect(texts).toContain('takes green 4 → Green slot 1 = 8');
    expect(texts).toContain('takes pink 5 → Pink slot 1 = 5');
    expect(texts).toContain('takes silver 4 → Silver 4 (yellow row)');
    expect(texts).toContain('takes silver 4 → Silver 4 (pink row)');
  });

  it('distinguishes circling from crossing a yellow cell', () => {
    const s = statePicking([1, 3, 2, 4, 5, 4]);
    s.areas.yellow[1] = 1; // the first "3" (lattice cell 1; cell 0 is a hole) is circled
    const texts = actionTexts(s);
    expect(texts).toContain('takes yellow 3 → cross Yellow 3');
    expect(texts).toContain('takes yellow 3 → circle Yellow 3'); // the other "3"
  });

  it('describes the return window', () => {
    const s = newGame(tv);
    s.pending = [];
    s.phase = 'preRoll';
    s.returns = 1;
    s.faces = [1, 2, 3, 4, 5, 6];
    s.loc[P] = 'platter';
    const texts = actionTexts(s);
    expect(texts).toContain('returns pink 5 to the pool');
    expect(texts).toContain('rolls on');
  });
});

describe('describeAction (twice pending bonuses)', () => {
  it('describes a white/silver chain-mark row choice', () => {
    const s = statePicking([1, 3, 2, 4, 5, 4]);
    s.areas.silver[3] = 1; // yellow row's 4 is taken
    s.pending = [{ t: 'silverMark', value: 4, row: null }];
    const texts = actionTexts(s);
    expect(texts).toEqual([
      'chain mark → Silver 4 (blue row)',
      'chain mark → Silver 4 (green row)',
      'chain mark → Silver 4 (pink row)',
    ]);
  });

  it('describes free ? placements per area', () => {
    const s = statePicking([1, 3, 2, 4, 5, 4]);

    s.pending = [{ t: 'free', area: 'yellow' }];
    expect(actionTexts(s)).toContain('? bonus → circle Yellow 3');

    s.pending = [{ t: 'free', area: 'blue' }];
    const blue = actionTexts(s);
    expect(blue).toContain('? bonus → Blue slot 1 = 2');
    expect(blue).toContain('? bonus → Blue slot 1 = 12');

    s.pending = [{ t: 'free', area: 'green' }];
    expect(actionTexts(s)).toContain('? bonus → Green slot 1 = 12'); // 6 × 2

    s.pending = [{ t: 'free', area: 'silver' }];
    expect(actionTexts(s)).toContain('? bonus → Silver 1 (yellow row)');

    s.pending = [{ t: 'free', area: 'pink' }];
    expect(actionTexts(s)).toContain('? bonus → Pink slot 1 = 6');
  });

  it('describes the black ? options', () => {
    const s = statePicking([1, 3, 2, 4, 5, 4]);
    s.pending = [tv.roundBonuses[3]!];
    expect(actionTexts(s)).toContain('bonus: ? in silver');
    expect(actionTexts(s)).toContain('bonus: ? in pink');
  });
});

describe('describeAction (base voice unchanged)', () => {
  it('keeps the base phrasing for every area kind', () => {
    const bv = thatsPrettyClever; // colors: white, yellow, blue, green, orange, purple
    const s = newGame(bv);
    s.pending = [];
    s.phase = 'pick';
    s.faces = [1, 3, 2, 4, 5, 6];
    const texts = actionTexts(s, bv);
    expect(texts).toContain('takes yellow 3 → Yellow 3');
    expect(texts).toContain('takes blue 2 → Blue 3'); // blue + white
    expect(texts).toContain('takes green 4 → Green slot 1'); // cross, no value suffix
    expect(texts).toContain('takes orange 5 → Orange slot 1 = 5');
    expect(texts).toContain('takes purple 6 → Purple slot 1 = 6');
  });
});

describe('describeAction (full-game sweep)', () => {
  for (const v of [thatsPrettyClever, twiceAsClever]) {
    it(`describes every legal action of seeded random games (${v.id})`, () => {
      const strat = makeRandom();
      for (const seed of [1, 2, 3]) {
        const rng = mulberry32(seed);
        const s = newGame(v);
        let guard = 0;
        while (guard++ < 10000) {
          const node = getPending(s, v);
          if (node.kind === 'over') break;
          if (node.kind === 'chance') {
            resolveChanceMut(s, v, rng);
            continue;
          }
          for (const a of node.actions as Action[]) {
            const txt = describeAction(s, v, a);
            expect(txt).toBeTruthy();
            expect(txt).not.toMatch(/undefined|\[object|NaN/);
          }
          applyActionMut(s, v, strat.choose(s, node.actions, { variant: v, rng }));
        }
        expect(getPending(s, v).kind).toBe('over');
      }
    });
  }
});

describe('effect glyph coverage', () => {
  it('every effect reachable on either sheet has a describeEffect text', () => {
    const collect = (v: VariantDef): Effect[] => {
      const effects: Effect[] = [];
      const push = (e?: Effect | null) => {
        if (!e) return;
        effects.push(e);
        if (e.t === 'choice') e.options.forEach((o) => push(o));
      };
      for (const a of v.areas) {
        for (const c of a.ui.cells) push(c.bonus);
        for (const g of a.ui.groups ?? []) push(g.bonus);
      }
      v.roundBonuses.forEach((b) => push(b));
      (['reroll', 'plus1', 'return'] as const).forEach((k) => push(v.bars[k].endBonus));
      return effects;
    };
    for (const v of [thatsPrettyClever, twiceAsClever]) {
      for (const e of collect(v)) {
        const txt = describeEffect(e);
        expect(txt).toBeTruthy();
        expect(txt).not.toMatch(/undefined|\[object/);
      }
    }
  });
});
