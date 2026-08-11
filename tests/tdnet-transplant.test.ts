import { describe, expect, it } from 'vitest';
import {
  createEvalCtx,
  extractFeatures,
  forward,
  netFromParams,
  paramsFromNet,
  stateValue,
  TD_FEATURES,
  widenNet,
} from '../src/strategies/tdnet';
import { extractFeaturesBonus, TD_BONUS_FEATURES } from '../src/strategies/tdnet-bonus';
import { TDNET_WEIGHTS } from '../src/strategies/tdnet-weights';
import { applyAction, getPending, getVariant, mulberry32, newGame, resolveChanceMut } from '../src/engine';

const v = getVariant('thats-pretty-clever');

describe('widenNet', () => {
  it('keeps the source shapes and zeroes only the new input rows', () => {
    const src = netFromParams(TDNET_WEIGHTS);
    const wide = widenNet(TDNET_WEIGHTS, TD_BONUS_FEATURES, src.nH1, src.nH2);

    expect(wide.nIn).toBe(TD_BONUS_FEATURES);
    expect(wide.W1.length).toBe(TD_BONUS_FEATURES * src.nH1);
    // The copied prefix is bit-identical...
    expect(Array.from(wide.W1.subarray(0, src.nIn * src.nH1))).toEqual(Array.from(src.W1));
    // ...and every new row is exactly zero, not merely small.
    for (let i = src.nIn * src.nH1; i < wide.W1.length; i++) expect(wide.W1[i]).toBe(0);
    // Deeper layers are untouched.
    expect(Array.from(wide.W2)).toEqual(Array.from(src.W2));
    expect(Array.from(wide.W3)).toEqual(Array.from(src.W3));
    expect(wide.b3[0]).toBe(src.b3[0]);
  });

  it('rejects shrinking the input or changing the hidden widths', () => {
    expect(() => widenNet(TDNET_WEIGHTS, TD_FEATURES - 1, 128, 128)).toThrow(/narrower/);
    expect(() => widenNet(TDNET_WEIGHTS, TD_BONUS_FEATURES, 256, 128)).toThrow(/hidden widths/);
  });

  /**
   * The property the transplant recipe depends on: over real game states, the
   * widened net must value every state bit-identically to its source, so the
   * argmax policy it induces is the same one. Any nonzero seed on the new rows
   * would break this.
   */
  it('values real states bit-identically to the source net', () => {
    const src = netFromParams(TDNET_WEIGHTS);
    const narrow = createEvalCtx(src);
    const wide = createEvalCtx(widenNet(TDNET_WEIGHTS, TD_BONUS_FEATURES, src.nH1, src.nH2));
    const xNarrow = new Float64Array(TD_FEATURES);
    const xWide = new Float64Array(TD_BONUS_FEATURES);

    let compared = 0;
    for (let g = 0; g < 3; g++) {
      const rng = mulberry32((7777 + g) >>> 0);
      let s = newGame(v);
      for (;;) {
        const node = getPending(s, v);
        if (node.kind === 'over') break;
        if (node.kind === 'chance') {
          resolveChanceMut(s, v, rng);
          continue;
        }
        // Compare on every candidate afterstate, not just the visited ones.
        for (const a of node.actions) {
          const ns = applyAction(s, v, a);
          if (ns.phase === 'over') continue;
          extractFeatures(ns, v, xNarrow);
          extractFeaturesBonus(ns, v, xWide);
          expect(forward(wide.net, xWide, wide.h1, wide.h2)).toBe(
            forward(src, xNarrow, narrow.h1, narrow.h2),
          );
          compared++;
        }
        s = applyAction(s, v, node.actions[0]);
      }
    }
    expect(compared).toBeGreaterThan(500);
  });

  it('round-trips through the serialized params a checkpoint would store', () => {
    const src = netFromParams(TDNET_WEIGHTS);
    const wide = widenNet(TDNET_WEIGHTS, TD_BONUS_FEATURES, src.nH1, src.nH2);
    const reloaded = netFromParams(paramsFromNet(wide));

    expect(reloaded.nIn).toBe(TD_BONUS_FEATURES);
    const s = newGame(v);
    expect(stateValue(createEvalCtx(reloaded), s, v)).toBeCloseTo(
      stateValue(createEvalCtx(wide), s, v),
      10,
    );
  });
});
