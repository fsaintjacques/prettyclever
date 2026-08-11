//! Randomness, in one place.
//!
//! Every chance node in the engine draws from an [`RngCore`], and every
//! signature that needs one takes `&mut impl RngCore` so a caller can supply a
//! seeded generator, a mock, or a rollout's own stream. [`Rng`] is the
//! concrete default: a seedable, small-state generator with no `std::time`
//! dependency, so `Rng::seed_from_u64(seed)` reproduces a game exactly — on
//! `wasm32-unknown-unknown` as well as natively.

pub use rand_core::{RngCore, SeedableRng};

/// The engine's default generator: xoshiro256++, seeded from a `u64`.
///
/// Determinism is a testable property of this crate ("replaying `(seed,
/// action indices)` reproduces the score"), so the choice lives here rather
/// than being made independently by every bot and simulation driver.
pub type Rng = rand_xoshiro::Xoshiro256PlusPlus;

/// A uniform integer in `0..n`, with no modulo bias.
///
/// Rejection-sampled against the largest multiple of `n` that fits in a
/// `u32`, so every outcome is equally likely — which matters for the passive
/// roll's tie-break, the one place where a biased shuffle would silently
/// favour low-numbered dice.
///
/// Returns 0 when `n` is 0, so no input panics.
pub fn below(rng: &mut impl RngCore, n: u32) -> u32 {
    if n <= 1 {
        return 0;
    }
    let zone = (u32::MAX / n) * n;
    loop {
        let v = rng.next_u32();
        if v < zone {
            return v % n;
        }
    }
}

/// Shuffle `slice` uniformly (Fisher-Yates).
///
/// The passive roll uses it to randomize the order in which equal faces are
/// considered; the tie-break rule is "arbitrary" in the rulebook and
/// "uniformly at random" in this engine.
pub fn shuffle<T>(slice: &mut [T], rng: &mut impl RngCore) {
    for i in (1..slice.len()).rev() {
        let j = below(rng, i as u32 + 1) as usize;
        slice.swap(i, j);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn below_stays_in_range_and_covers_it() {
        let mut rng = Rng::seed_from_u64(1);
        let mut seen = [false; 5];
        for _ in 0..1000 {
            let v = below(&mut rng, 5) as usize;
            assert!(v < 5);
            seen[v] = true;
        }
        assert!(seen.iter().all(|s| *s));
    }

    #[test]
    fn below_degenerate_inputs_return_zero() {
        let mut rng = Rng::seed_from_u64(1);
        assert_eq!(below(&mut rng, 0), 0);
        assert_eq!(below(&mut rng, 1), 0);
    }

    #[test]
    fn shuffle_is_a_permutation() {
        let mut rng = Rng::seed_from_u64(42);
        for _ in 0..100 {
            let mut v = [0u8, 1, 2, 3, 4, 5];
            shuffle(&mut v, &mut rng);
            let mut sorted = v;
            sorted.sort_unstable();
            assert_eq!(sorted, [0, 1, 2, 3, 4, 5]);
        }
    }

    #[test]
    fn shuffle_reaches_every_position() {
        let mut rng = Rng::seed_from_u64(9);
        let mut seen = [[false; 6]; 6];
        for _ in 0..2000 {
            let mut v = [0usize, 1, 2, 3, 4, 5];
            shuffle(&mut v, &mut rng);
            for (pos, &val) in v.iter().enumerate() {
                seen[val][pos] = true;
            }
        }
        assert!(seen.iter().all(|row| row.iter().all(|s| *s)));
    }

    #[test]
    fn same_seed_same_stream() {
        let mut a = Rng::seed_from_u64(1234);
        let mut b = Rng::seed_from_u64(1234);
        for _ in 0..64 {
            assert_eq!(a.next_u32(), b.next_u32());
        }
    }
}
