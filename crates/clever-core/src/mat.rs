//! The dice mat: the one mechanic both games genuinely share.
//!
//! The mat knows faces and locations and nothing about sheets. It reports
//! facts — "these dice moved to the platter" — and the game decides what they
//! mean.

use crate::dieset::DieSet;
use crate::rng::{shuffle, RngCore};
use crate::vocab::{Die, Face, Loc};

/// `N` dice, each with a face and a location.
///
/// Both games play six dice; the const parameter costs nothing and keeps the
/// door open. `N` may not exceed [`Die::MAX`], the width of a [`DieSet`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Mat<const N: usize> {
    faces: [Face; N],
    loc: [Loc; N],
}

impl<const N: usize> Mat<N> {
    /// How many dice the passive roll sets aside on the platter — the three
    /// lowest, in both games.
    pub const PASSIVE_PLATTER: usize = 3;

    /// Rejects an `N` a [`DieSet`] could not represent, at compile time.
    const CHECK_N: () = assert!(
        N >= Self::PASSIVE_PLATTER && N <= Die::MAX,
        "a mat holds between 3 and Die::MAX dice"
    );

    /// A fresh mat: every die in the pool, every die rolled.
    ///
    /// A game's first phase is a roll, so "rolled but untouched" and "never
    /// rolled" are indistinguishable; the mat has no unrolled state and
    /// therefore no `0` face to guard against.
    pub fn new(rng: &mut impl RngCore) -> Self {
        let () = Self::CHECK_N;
        Mat {
            faces: [Face::ONE; N],
            loc: [Loc::Pool; N],
        }
        .rolled(rng)
    }

    fn rolled(mut self, rng: &mut impl RngCore) -> Self {
        for f in &mut self.faces {
            *f = Face::roll(rng);
        }
        self
    }

    /// How many dice this mat holds.
    #[must_use]
    pub const fn len(&self) -> usize {
        N
    }

    /// Always `false` — a mat always has dice. Present because `len` is.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        N == 0
    }

    /// The face a die currently shows, wherever it sits. Dice on the field
    /// and the platter keep the face they were last rolled with, which is
    /// what a +1 action spends them at.
    ///
    /// # Panics
    /// If `d` is not a die of this mat.
    #[must_use]
    pub fn face(&self, d: Die) -> Face {
        self.faces[d.index()]
    }

    /// Where a die sits.
    ///
    /// # Panics
    /// If `d` is not a die of this mat.
    #[must_use]
    pub fn loc(&self, d: Die) -> Loc {
        self.loc[d.index()]
    }

    /// Every die of the mat, in index order.
    pub fn dice(&self) -> impl Iterator<Item = Die> + Clone {
        (0..N as u8).map(Die::new)
    }

    /// The dice in a given location, in index order.
    pub fn in_loc(&self, want: Loc) -> impl Iterator<Item = Die> + '_ {
        self.loc
            .iter()
            .enumerate()
            .filter(move |(_, &l)| l == want)
            .map(|(i, _)| Die::new(i as u8))
    }

    /// The dice still available to pick and to re-roll.
    pub fn pool(&self) -> impl Iterator<Item = Die> + '_ {
        self.in_loc(Loc::Pool)
    }

    /// The dice on the silver platter: pushed there by a higher pick, or set
    /// aside by the passive roll.
    pub fn platter(&self) -> impl Iterator<Item = Die> + '_ {
        self.in_loc(Loc::Platter)
    }

    /// The dice on the dice fields — the picks made this turn.
    pub fn field(&self) -> impl Iterator<Item = Die> + '_ {
        self.in_loc(Loc::Field)
    }

    /// How many dice sit in a location.
    #[must_use]
    pub fn count(&self, want: Loc) -> usize {
        self.loc.iter().filter(|&&l| l == want).count()
    }

    /// Re-roll every die still in the pool, and only those.
    ///
    /// This is both the turn's opening roll and the re-roll action: the
    /// rulebook's "re-roll *all* currently rolled dice (no keeping some)" is
    /// exactly "the pool", because picked and platter dice are no longer
    /// rolled.
    pub fn roll_pool(&mut self, rng: &mut impl RngCore) {
        for (f, _) in self
            .faces
            .iter_mut()
            .zip(self.loc.iter())
            .filter(|(_, &l)| l == Loc::Pool)
        {
            *f = Face::roll(rng);
        }
    }

    /// Take `d` onto a dice field, and push every *lower* pool die onto the
    /// platter. Returns exactly the dice that moved.
    ///
    /// `d` enters the field before the sweep, so it is never in its own moved
    /// set, and "lower" is strict: dice showing the same face as the pick stay
    /// in the pool. Dice already on the platter from an earlier pick are not
    /// in the set either — which is what makes the returned value usable
    /// directly as *Twice*'s platter chain.
    ///
    /// # Panics
    /// If `d` is not a die of this mat.
    pub fn take(&mut self, d: Die) -> DieSet {
        let picked = self.faces[d.index()];
        self.loc[d.index()] = Loc::Field;

        let mut moved = DieSet::EMPTY;
        for (i, (loc, &face)) in self.loc.iter_mut().zip(self.faces.iter()).enumerate() {
            if *loc == Loc::Pool && face < picked {
                *loc = Loc::Platter;
                moved.insert(Die::new(i as u8));
            }
        }
        moved
    }

    /// The passive roll: every die comes back, all of them are rolled, and the
    /// three lowest go to the platter. Returns the platter set — the dice the
    /// passive pick may choose from.
    ///
    /// Ties are broken uniformly at random (the rulebook says "arbitrarily"),
    /// implemented as a shuffle of the die indices followed by a partial
    /// selection sort on the face: one pass, no tie-break keys to compare.
    pub fn passive_roll(&mut self, rng: &mut impl RngCore) -> DieSet {
        self.loc = [Loc::Pool; N];
        for f in &mut self.faces {
            *f = Face::roll(rng);
        }

        let mut order = [0u8; N];
        for (i, slot) in order.iter_mut().enumerate() {
            *slot = i as u8;
        }
        shuffle(&mut order, rng);

        // Selection sort of the lowest `PASSIVE_PLATTER`. `<` is strict, so
        // among equal faces the shuffled order decides — uniformly.
        let keep = Self::PASSIVE_PLATTER;
        for i in 0..keep {
            let mut lowest = i;
            for j in i + 1..N {
                if self.faces[order[j] as usize] < self.faces[order[lowest] as usize] {
                    lowest = j;
                }
            }
            order.swap(i, lowest);
        }

        let mut platter = DieSet::EMPTY;
        for &i in &order[..keep] {
            self.loc[i as usize] = Loc::Platter;
            platter.insert(Die::new(i));
        }
        platter
    }

    /// Return a platter die to the pool, so the next roll includes it —
    /// *Twice*'s return action. Answers `false`, changing nothing, when `d`
    /// is not on the platter.
    ///
    /// Nothing in the base game reaches this: its phase machine has no state
    /// in which a return is offered. Inertness by use, not by a flag.
    ///
    /// # Panics
    /// If `d` is not a die of this mat.
    pub fn recall(&mut self, d: Die) -> bool {
        if self.loc[d.index()] != Loc::Platter {
            return false;
        }
        self.loc[d.index()] = Loc::Pool;
        true
    }

    /// Bring every die back to the pool, keeping its face — the end of a turn.
    pub fn reset(&mut self) {
        self.loc = [Loc::Pool; N];
    }

    /// Force a die's face. For test fixtures and for restoring a saved state;
    /// the game itself only ever changes faces by rolling.
    pub fn set_face(&mut self, d: Die, f: Face) {
        self.faces[d.index()] = f;
    }

    /// Force a die's location. For test fixtures and for restoring a saved
    /// state; the game itself moves dice through `take`, `recall` and `reset`.
    pub fn set_loc(&mut self, d: Die, l: Loc) {
        self.loc[d.index()] = l;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::{Rng, SeedableRng};

    fn mat(faces: [u8; 6]) -> Mat<6> {
        let mut m = Mat::<6>::new(&mut Rng::seed_from_u64(0));
        for (i, v) in faces.into_iter().enumerate() {
            m.set_face(Die::new(i as u8), Face::new(v).unwrap());
        }
        m
    }

    fn set(indices: &[u8]) -> DieSet {
        indices.iter().map(|&i| Die::new(i)).collect()
    }

    #[test]
    fn new_puts_everything_in_the_pool() {
        let m = Mat::<6>::new(&mut Rng::seed_from_u64(3));
        assert_eq!(m.pool().count(), 6);
        assert_eq!(m.platter().count(), 0);
        assert_eq!(m.field().count(), 0);
        assert_eq!(m.len(), 6);
        assert!(!m.is_empty());
    }

    #[test]
    fn take_moves_strictly_lower_pool_dice() {
        let mut m = mat([4, 4, 2, 6, 1, 5]);
        let moved = m.take(Die::new(0));
        // Equal faces (die 1) and higher faces (dice 3, 5) stay in the pool.
        assert_eq!(moved, set(&[2, 4]));
        assert_eq!(m.loc(Die::new(0)), Loc::Field);
        assert_eq!(m.loc(Die::new(1)), Loc::Pool);
        assert_eq!(m.loc(Die::new(2)), Loc::Platter);
        assert_eq!(m.loc(Die::new(3)), Loc::Pool);
        assert_eq!(m.loc(Die::new(4)), Loc::Platter);
        assert_eq!(m.loc(Die::new(5)), Loc::Pool);
    }

    #[test]
    fn take_never_returns_the_taken_die() {
        let mut m = mat([3, 3, 3, 3, 3, 3]);
        let moved = m.take(Die::new(2));
        assert!(moved.is_empty());
        assert!(!moved.contains(Die::new(2)));
    }

    #[test]
    fn take_ignores_dice_already_off_the_pool() {
        let mut m = mat([6, 1, 1, 2, 3, 4]);
        let first = m.take(Die::new(3)); // pushes the two 1s
        assert_eq!(first, set(&[1, 2]));
        let second = m.take(Die::new(0)); // pushes only what is still pooled
        assert_eq!(second, set(&[4, 5]));
        assert_eq!(m.platter().count(), 4);
        assert_eq!(m.field().count(), 2);
    }

    #[test]
    fn roll_pool_leaves_field_and_platter_faces_alone() {
        let mut rng = Rng::seed_from_u64(11);
        let mut m = mat([6, 1, 1, 1, 6, 6]);
        m.take(Die::new(0)); // dice 1..=3 to the platter, dice 4,5 stay pooled
        assert_eq!(m.pool().count(), 2);
        let kept: Vec<Face> = m.dice().map(|d| m.face(d)).collect();
        m.roll_pool(&mut rng);
        for d in m.dice() {
            if m.loc(d) != Loc::Pool {
                assert_eq!(m.face(d), kept[d.index()], "{d} moved but was re-rolled");
            }
        }
    }

    #[test]
    fn passive_roll_leaves_exactly_three_on_the_platter() {
        let mut rng = Rng::seed_from_u64(5);
        let mut m = mat([1, 1, 1, 1, 1, 1]);
        m.take(Die::new(0));
        for _ in 0..200 {
            let platter = m.passive_roll(&mut rng);
            assert_eq!(platter.len(), 3);
            assert_eq!(m.platter().count(), 3);
            assert_eq!(m.pool().count(), 3);
            assert_eq!(m.field().count(), 0);
            for d in platter {
                assert_eq!(m.loc(d), Loc::Platter);
            }
        }
    }

    #[test]
    fn passive_roll_keeps_the_lowest_three() {
        let mut rng = Rng::seed_from_u64(17);
        let mut m = Mat::<6>::new(&mut rng);
        for _ in 0..500 {
            m.passive_roll(&mut rng);
            let hi = m
                .platter()
                .map(|d| m.face(d))
                .max()
                .expect("three on the platter");
            let lo = m.pool().map(|d| m.face(d)).min().expect("three pooled");
            assert!(hi <= lo, "platter {hi} above pool {lo}");
        }
    }

    #[test]
    fn passive_roll_breaks_ties_at_random() {
        // Every die is equally likely to be one of the three set aside, so
        // over many rolls each index must appear.
        let mut rng = Rng::seed_from_u64(23);
        let mut m = Mat::<6>::new(&mut rng);
        let mut seen = [0u32; 6];
        for _ in 0..3000 {
            for d in m.passive_roll(&mut rng) {
                seen[d.index()] += 1;
            }
        }
        // 1500 expected per die if the tie-break is unbiased.
        for c in seen {
            assert!(c > 1200 && c < 1800, "biased tie-break: {seen:?}");
        }
    }

    #[test]
    fn recall_only_moves_platter_dice() {
        let mut m = mat([6, 1, 2, 3, 4, 5]);
        m.take(Die::new(0));
        assert!(m.recall(Die::new(1)));
        assert_eq!(m.loc(Die::new(1)), Loc::Pool);
        // Already back in the pool: nothing to recall.
        assert!(!m.recall(Die::new(1)));
        // On the field: not recallable either.
        assert!(!m.recall(Die::new(0)));
        assert_eq!(m.loc(Die::new(0)), Loc::Field);
    }

    #[test]
    fn reset_returns_everything_to_the_pool_keeping_faces() {
        let mut m = mat([6, 1, 2, 3, 4, 5]);
        m.take(Die::new(0));
        m.reset();
        assert_eq!(m.pool().count(), 6);
        assert_eq!(m.face(Die::new(0)), Face::SIX);
        assert_eq!(m.face(Die::new(1)), Face::ONE);
    }

    #[test]
    fn same_seed_same_mat() {
        let a = Mat::<6>::new(&mut Rng::seed_from_u64(99));
        let b = Mat::<6>::new(&mut Rng::seed_from_u64(99));
        assert_eq!(a, b);
    }
}
