//! Blue: twelve slots written left to right, each sum no greater than the one
//! before it.
//!
//! The value written is **always blue + white**, whichever of the two dice is
//! spent — so the area's input is [`Pips`], not [`Face`](clever_core::Face) —
//! and the track scores by how many slots are filled rather than by what is in
//! them.
//!
//! `ArrayVec<Pips, 12>` *is* "a prefix of written sums": a hole in the middle
//! is unrepresentable rather than merely unreached, `len()` is the frontier,
//! and the descent rule reads as one line against `last()`.

use arrayvec::ArrayVec;
use clever_core::{Pips, Score};

use super::Area;
use crate::effect::{Effect, FreeTarget};

/// The blue track: the sums written so far, in order.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Blue(ArrayVec<Pips, 12>);

impl Blue {
    /// How many slots the track has.
    pub const SLOTS: usize = 12;

    /// Cumulative points by how many slots are filled.
    const POINTS: [Score; Self::SLOTS + 1] = [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 66, 78];

    /// The bonus printed under each slot.
    const BONUS: [Option<Effect>; Self::SLOTS] = [
        None,
        Some(Effect::Return),
        Some(Effect::Free(FreeTarget::Yellow)),
        None,
        Some(Effect::Plus1),
        Some(Effect::Reroll),
        Some(Effect::Free(FreeTarget::Pink)),
        None,
        Some(Effect::Fox),
        Some(Effect::Return),
        None,
        Some(Effect::Free(FreeTarget::Green)),
    ];

    /// A fresh, empty track.
    #[must_use]
    pub fn new() -> Self {
        Blue(ArrayVec::new())
    }

    /// The sums written so far, left to right.
    #[must_use]
    pub fn sums(&self) -> &[Pips] {
        &self.0
    }

    /// A track from a saved prefix; sums past the last slot are dropped.
    ///
    /// The descent rule is *not* re-checked — a saved game is assumed to have
    /// been played legally, and a facade that fabricates one gets a strange
    /// sheet rather than a panic.
    #[must_use]
    pub fn from_sums(sums: &[Pips]) -> Self {
        Blue(sums.iter().copied().take(Self::SLOTS).collect())
    }

    /// The index of the next empty slot — the frontier, and the index into the
    /// scoring table.
    #[must_use]
    pub fn next_slot(&self) -> usize {
        self.0.len()
    }

    /// Whether every slot is written.
    #[must_use]
    pub fn is_full(&self) -> bool {
        self.0.is_full()
    }

    /// The sum the next write may not exceed, or `None` on an empty track.
    #[must_use]
    pub fn ceiling(&self) -> Option<Pips> {
        self.0.last().copied()
    }

    /// Whether a sum may be written next. Equal to the previous one is legal —
    /// the track descends, it does not strictly descend.
    #[must_use]
    pub fn accepts(&self, sum: Pips) -> bool {
        !self.is_full() && self.ceiling().map_or(true, |last| sum <= last)
    }

    /// The points printed above each slot — for rendering.
    #[must_use]
    pub const fn points() -> &'static [Score; Self::SLOTS + 1] {
        &Self::POINTS
    }
}

impl Area for Blue {
    /// The sum to write; the slot is implied by the prefix, so a mark
    /// enumerated before another write cannot land in a stale slot.
    type Mark = Pips;
    type Input = Pips;
    type Bonus = Option<Effect>;

    fn marks(&self, sum: Pips) -> impl Iterator<Item = Pips> + '_ {
        self.accepts(sum).then_some(sum).into_iter()
    }

    /// The blue `?` frees the *value*, not the placement rule: only the sums
    /// the descent still allows are offered.
    fn free_marks(&self) -> impl Iterator<Item = Pips> + '_ {
        Pips::all().filter(move |&p| self.accepts(p))
    }

    fn apply(&mut self, sum: Pips) -> Option<Effect> {
        let slot = self.0.len();
        self.0.try_push(sum).ok()?;
        Self::BONUS[slot]
    }

    fn score(&self) -> Score {
        Self::POINTS[self.0.len()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::area::harness;

    fn pips(v: u8) -> Pips {
        Pips::new(v).expect("a two-die sum")
    }

    fn sums(values: &[u8]) -> Vec<Pips> {
        values.iter().map(|&v| pips(v)).collect()
    }

    #[test]
    fn the_printed_track_matches_the_rulebook() {
        assert_eq!(
            Blue::POINTS,
            [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 66, 78]
        );
        let bonuses: Vec<(usize, Effect)> = Blue::BONUS
            .iter()
            .enumerate()
            .filter_map(|(i, b)| b.map(|e| (i, e)))
            .collect();
        assert_eq!(
            bonuses,
            vec![
                (1, Effect::Return),
                (2, Effect::Free(FreeTarget::Yellow)),
                (4, Effect::Plus1),
                (5, Effect::Reroll),
                (6, Effect::Free(FreeTarget::Pink)),
                (8, Effect::Fox),
                (9, Effect::Return),
                (11, Effect::Free(FreeTarget::Green)),
            ]
        );
    }

    #[test]
    fn writes_must_not_increase() {
        let mut b = Blue::new();
        assert_eq!(b.ceiling(), None);
        assert_eq!(b.marks(pips(7)).count(), 1);
        let _ = b.apply(pips(7));
        assert_eq!(b.ceiling(), Some(pips(7)));
        assert_eq!(b.marks(pips(8)).count(), 0);
        assert_eq!(b.marks(pips(7)).count(), 1, "equal is legal");
        assert_eq!(b.marks(pips(2)).count(), 1);
        assert_eq!(b.next_slot(), 1);
    }

    #[test]
    fn slot_bonuses_fire_as_they_are_written() {
        let mut b = Blue::new();
        assert_eq!(b.apply(pips(12)), None);
        assert_eq!(b.apply(pips(12)), Some(Effect::Return));
        assert_eq!(b.apply(pips(11)), Some(Effect::Free(FreeTarget::Yellow)));
    }

    #[test]
    fn scoring_follows_the_filled_count() {
        let mut b = Blue::new();
        assert_eq!(b.score(), 0);
        for _ in 0..5 {
            let _ = b.apply(pips(8));
        }
        assert_eq!(b.score(), 15);
        for _ in 5..12 {
            let _ = b.apply(pips(3));
        }
        assert_eq!(b.score(), 78);
        assert!(b.is_full());
        assert_eq!(Blue::points().len(), Blue::SLOTS + 1);
    }

    #[test]
    fn free_marks_are_every_sum_the_descent_still_allows() {
        let b = Blue::new();
        let all: Vec<u8> = b.free_marks().map(Pips::get).collect();
        assert_eq!(all, vec![2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        let b = Blue::from_sums(&sums(&[5]));
        let left: Vec<u8> = b.free_marks().map(Pips::get).collect();
        assert_eq!(left, vec![2, 3, 4, 5]);
    }

    #[test]
    fn a_full_track_takes_nothing_more() {
        let mut b = Blue::from_sums(&sums(&[12; 12]));
        assert!(b.is_full());
        assert_eq!(b.marks(pips(2)).count(), 0);
        assert_eq!(b.free_marks().count(), 0);
        assert_eq!(b.apply(pips(2)), None);
        assert_eq!(b.sums().len(), 12);
        assert_eq!(Blue::from_sums(&sums(&[2; 20])).sums().len(), 12);
    }

    #[test]
    fn survives_the_generic_area_exercises() {
        // The descent never blocks a track that keeps writing the minimum.
        let all: Vec<Pips> = Pips::all().collect();
        harness::saturates_in(&mut Blue::new(), &all, Blue::SLOTS);
    }
}
