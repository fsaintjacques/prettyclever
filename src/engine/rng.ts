/** Deterministic RNG so games are reproducible from a seed. */
export type RNG = () => number;

/** An RNG whose 32-bit internal state can be saved and restored mid-stream. */
export interface SeededRNG extends RNG {
  getState(): number;
  setState(state: number): void;
}

export function mulberry32(seed: number): SeededRNG {
  let a = seed >>> 0;
  const rng = (() => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as SeededRNG;
  rng.getState = () => a;
  rng.setState = (state: number) => {
    a = state >>> 0;
  };
  return rng;
}

export function rollD6(rng: RNG): number {
  return 1 + Math.floor(rng() * 6);
}

/** Derive a fresh seed from an RNG stream (for per-game / per-rollout forks). */
export function forkSeed(rng: RNG): number {
  return Math.floor(rng() * 0xffffffff) >>> 0;
}
