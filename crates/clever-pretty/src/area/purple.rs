//! Purple: eleven slots written left to right, strictly ascending — except
//! that writing a 6 lifts the constraint for the next slot.
//!
//! Like orange, the state is a prefix of written faces; unlike orange, which
//! faces are legal depends on the last one, and that rule reads as one line
//! against `last()`.

use arrayvec::ArrayVec;
use clever_core::{Face, Score};

use super::Area;
use crate::effect::{CrossTarget, Effect, WriteTarget};

/// The purple track: the faces written so far, in order.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Purple(ArrayVec<Face, 11>);

impl Purple {
    /// How many slots the track has.
    pub const SLOTS: usize = 11;

    /// Writing this face lifts the ascending constraint for the next slot.
    pub const RESET: Face = Face::SIX;

    /// The bonus printed under each slot.
    const BONUS: [Option<Effect>; Self::SLOTS] = [
        None,
        None,
        Some(Effect::Reroll),
        Some(Effect::CrossAny(CrossTarget::Blue)),
        Some(Effect::Plus1),
        Some(Effect::CrossAny(CrossTarget::Yellow)),
        Some(Effect::Fox),
        Some(Effect::Reroll),
        Some(Effect::CrossNextGreen),
        Some(Effect::WriteNext(WriteTarget::Orange, Face::SIX)),
        Some(Effect::Plus1),
    ];

    /// A fresh, empty track.
    #[must_use]
    pub fn new() -> Self {
        Purple(ArrayVec::new())
    }

    /// The faces written so far, left to right.
    #[must_use]
    pub fn faces(&self) -> &[Face] {
        &self.0
    }

    /// A track from a saved prefix; faces past the last slot are dropped.
    ///
    /// The ascending rule is *not* re-checked — a saved game is assumed to
    /// have been played legally, and a facade that fabricates one gets a
    /// strange sheet rather than a panic.
    #[must_use]
    pub fn from_faces(faces: &[Face]) -> Self {
        Purple(faces.iter().copied().take(Self::SLOTS).collect())
    }

    /// The index of the next empty slot — the frontier.
    #[must_use]
    pub fn next_slot(&self) -> usize {
        self.0.len()
    }

    /// Whether every slot is written.
    #[must_use]
    pub fn is_full(&self) -> bool {
        self.0.is_full()
    }

    /// The face the next write must exceed, or `None` when anything goes —
    /// an empty track, or one whose last slot holds a 6.
    #[must_use]
    pub fn must_exceed(&self) -> Option<Face> {
        match self.0.last() {
            Some(&last) if last != Self::RESET => Some(last),
            _ => None,
        }
    }

    /// Whether a face may be written next.
    #[must_use]
    pub fn accepts(&self, face: Face) -> bool {
        !self.is_full() && self.must_exceed().map_or(true, |last| face > last)
    }
}

impl Area for Purple {
    /// The face to write; the slot is implied by the prefix.
    type Mark = Face;
    type Input = Face;
    type Bonus = Option<Effect>;

    fn marks(&self, face: Face) -> impl Iterator<Item = Face> + '_ {
        self.accepts(face).then_some(face).into_iter()
    }

    fn free_marks(&self) -> impl Iterator<Item = Face> + '_ {
        Face::ALL.into_iter().filter(move |&f| self.accepts(f))
    }

    fn apply(&mut self, face: Face) -> Option<Effect> {
        let slot = self.0.len();
        self.0.try_push(face).ok()?;
        Self::BONUS[slot]
    }

    fn score(&self) -> Score {
        self.0.iter().map(|f| f.score()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::area::harness;

    fn faces(values: &[u8]) -> Vec<Face> {
        values.iter().map(|&v| Face::new(v).unwrap()).collect()
    }

    #[test]
    fn the_printed_track_matches_the_rulebook() {
        let bonuses: Vec<(usize, Effect)> = Purple::BONUS
            .iter()
            .enumerate()
            .filter_map(|(i, b)| b.map(|e| (i, e)))
            .collect();
        assert_eq!(
            bonuses,
            vec![
                (2, Effect::Reroll),
                (3, Effect::CrossAny(CrossTarget::Blue)),
                (4, Effect::Plus1),
                (5, Effect::CrossAny(CrossTarget::Yellow)),
                (6, Effect::Fox),
                (7, Effect::Reroll),
                (8, Effect::CrossNextGreen),
                (9, Effect::WriteNext(WriteTarget::Orange, Face::SIX)),
                (10, Effect::Plus1),
            ]
        );
    }

    #[test]
    fn an_empty_track_takes_anything() {
        let p = Purple::new();
        assert_eq!(p.must_exceed(), None);
        assert_eq!(p.free_marks().count(), 6);
        assert_eq!(p.marks(Face::ONE).count(), 1);
    }

    #[test]
    fn writes_must_ascend() {
        let p = Purple::from_faces(&faces(&[4]));
        assert_eq!(p.must_exceed(), Some(Face::FOUR));
        assert_eq!(p.marks(Face::THREE).count(), 0);
        assert_eq!(p.marks(Face::FOUR).count(), 0, "strictly ascending");
        assert_eq!(p.marks(Face::FIVE).count(), 1);
        assert_eq!(p.free_marks().collect::<Vec<_>>(), faces(&[5, 6]));
    }

    #[test]
    fn a_six_lifts_the_constraint() {
        let p = Purple::from_faces(&faces(&[6]));
        assert_eq!(p.must_exceed(), None);
        assert_eq!(p.marks(Face::ONE).count(), 1);
        assert_eq!(p.free_marks().count(), 6);
        // And again after a second 6.
        let q = Purple::from_faces(&faces(&[2, 6]));
        assert_eq!(q.marks(Face::ONE).count(), 1);
    }

    #[test]
    fn a_full_track_takes_nothing_more() {
        let mut p = Purple::from_faces(&faces(&[1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5]));
        assert!(p.is_full());
        assert_eq!(p.marks(Face::SIX).count(), 0);
        assert_eq!(p.free_marks().count(), 0);
        assert_eq!(p.apply(Face::SIX), None);
        assert_eq!(p.next_slot(), 11);
        assert_eq!(Purple::from_faces(&faces(&[6; 20])).faces().len(), 11);
    }

    #[test]
    fn scoring_sums_the_written_faces() {
        assert_eq!(Purple::new().score(), 0);
        assert_eq!(Purple::from_faces(&faces(&[2, 4, 6, 1])).score(), 13);
        assert_eq!(Purple::from_faces(&faces(&[6; 11])).score(), 66);
    }

    #[test]
    fn slot_bonuses_fire_as_they_are_written() {
        let mut p = Purple::new();
        let mut fired = Vec::new();
        for f in faces(&[1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5]) {
            let mark = p.marks(f).next().expect("the sequence is legal");
            fired.push(p.apply(mark));
        }
        assert_eq!(fired[2], Some(Effect::Reroll));
        assert_eq!(fired[6], Some(Effect::Fox));
        assert_eq!(fired[8], Some(Effect::CrossNextGreen));
        assert_eq!(
            fired[9],
            Some(Effect::WriteNext(WriteTarget::Orange, Face::SIX))
        );
        assert_eq!(fired[10], Some(Effect::Plus1));
        assert_eq!(fired[0], None);
    }

    #[test]
    fn survives_the_generic_area_exercises() {
        // Ascending greedily — 1..6 then 1..5 — is exactly eleven writes.
        harness::saturates_in(&mut Purple::new(), &Face::ALL, Purple::SLOTS);
    }
}
