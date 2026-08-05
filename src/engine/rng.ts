/** Deterministic RNG so games are reproducible from a seed. */
export type RNG = () => number;

export function mulberry32(seed: number): RNG {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rollD6(rng: RNG): number {
  return 1 + Math.floor(rng() * 6);
}

/** Derive a fresh seed from an RNG stream (for per-game / per-rollout forks). */
export function forkSeed(rng: RNG): number {
  return Math.floor(rng() * 0xffffffff) >>> 0;
}
