//! Green: twelve slots written left to right in six subtraction pairs.
//!
//! Each slot multiplies the face written into it; each pair scores
//! `first − second` once both of its slots are filled. Negative results stand,
//! so this is the one area of either game whose score can go down — and
//! therefore the one that can drive [`Breakdown::min_area`] and the fox
//! multiplier below zero.
//!
//! The track stores the **die** face and applies the multiplier when scoring.
//! Storing the product instead is what forces the prototype to recover a face
//! by dividing.
//!
//! [`Breakdown::min_area`]: clever_core::Breakdown::min_area

use arrayvec::ArrayVec;
use clever_core::{Face, Score};

use super::Area;
use crate::effect::{Effect, FreeTarget};

/// The green track: the faces written so far, in order.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Green(ArrayVec<Face, 12>);

impl Green {
    /// How many slots the track has.
    pub const SLOTS: usize = 12;

    /// How many subtraction pairs the slots form — consecutive slots, so
    /// `(0,1)`, `(2,3)` and so on.
    pub const PAIRS: usize = Self::SLOTS / 2;

    /// What each slot multiplies its written face by.
    const MULT: [Score; Self::SLOTS] = [2, 2, 2, 1, 3, 3, 3, 2, 3, 1, 4, 1];

    /// The bonus printed under each slot.
    const BONUS: [Option<Effect>; Self::SLOTS] = [
        None,
        Some(Effect::Reroll),
        None,
        Some(Effect::Free(FreeTarget::Blue)),
        Some(Effect::Return),
        None,
        Some(Effect::Fox),
        Some(Effect::Free(FreeTarget::Silver)),
        Some(Effect::Plus1),
        None,
        Some(Effect::Free(FreeTarget::Pink)),
        Some(Effect::Free(FreeTarget::Yellow)),
    ];

    /// A fresh, empty track.
    #[must_use]
    pub fn new() -> Self {
        Green(ArrayVec::new())
    }

    /// The faces written so far, left to right.
    #[must_use]
    pub fn faces(&self) -> &[Face] {
        &self.0
    }

    /// A track from a saved prefix; faces past the last slot are dropped.
    #[must_use]
    pub fn from_faces(faces: &[Face]) -> Self {
        Green(faces.iter().copied().take(Self::SLOTS).collect())
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

    /// What the next slot multiplies by, or `None` when the track is full.
    ///
    /// A bot wanting to write big numbers into the first slot of a pair and
    /// small ones into the second reads this.
    #[must_use]
    pub fn next_multiplier(&self) -> Option<Score> {
        Self::MULT.get(self.0.len()).copied()
    }

    /// What one slot contributes, face times its multiplier.
    #[must_use]
    pub fn written(&self, slot: usize) -> Option<Score> {
        Some(self.0.get(slot)?.score() * Self::MULT[slot])
    }

    /// What each pair is worth: `first − second` once both slots are filled,
    /// and nothing while the pair is half open.
    pub fn pairs(&self) -> impl Iterator<Item = Score> + '_ {
        (0..Self::PAIRS).map(
            move |p| match (self.written(2 * p), self.written(2 * p + 1)) {
                (Some(first), Some(second)) => first - second,
                _ => 0,
            },
        )
    }

    /// The multiplier printed on every slot, left to right — for rendering.
    #[must_use]
    pub const fn multipliers() -> &'static [Score; Self::SLOTS] {
        &Self::MULT
    }
}

impl Area for Green {
    /// The face to write; the slot, and therefore the multiplier, is implied
    /// by the prefix.
    type Mark = Face;
    type Input = Face;
    type Bonus = Option<Effect>;

    /// Green takes any face, so long as a slot is left.
    fn marks(&self, face: Face) -> impl Iterator<Item = Face> + '_ {
        (!self.is_full()).then_some(face).into_iter()
    }

    fn free_marks(&self) -> impl Iterator<Item = Face> + '_ {
        Face::ALL.into_iter().filter(move |_| !self.is_full())
    }

    fn apply(&mut self, face: Face) -> Option<Effect> {
        let slot = self.0.len();
        self.0.try_push(face).ok()?;
        Self::BONUS[slot]
    }

    fn score(&self) -> Score {
        self.pairs().sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::area::harness;

    fn face(v: u8) -> Face {
        Face::new(v).expect("a die face")
    }

    fn faces(values: &[u8]) -> Vec<Face> {
        values.iter().map(|&v| face(v)).collect()
    }

    #[test]
    fn the_printed_track_matches_the_rulebook() {
        assert_eq!(Green::MULT, [2, 2, 2, 1, 3, 3, 3, 2, 3, 1, 4, 1]);
        let bonuses: Vec<(usize, Effect)> = Green::BONUS
            .iter()
            .enumerate()
            .filter_map(|(i, b)| b.map(|e| (i, e)))
            .collect();
        assert_eq!(
            bonuses,
            vec![
                (1, Effect::Reroll),
                (3, Effect::Free(FreeTarget::Blue)),
                (4, Effect::Return),
                (6, Effect::Fox),
                (7, Effect::Free(FreeTarget::Silver)),
                (8, Effect::Plus1),
                (10, Effect::Free(FreeTarget::Pink)),
                (11, Effect::Free(FreeTarget::Yellow)),
            ]
        );
    }

    #[test]
    fn the_face_is_stored_and_multiplied_at_scoring_time() {
        let mut g = Green::new();
        assert_eq!(g.next_multiplier(), Some(2));
        let _ = g.apply(face(4));
        assert_eq!(g.faces()[0], face(4), "the die value is stored, not 8");
        assert_eq!(g.written(0), Some(8));
        assert_eq!(g.next_multiplier(), Some(2));
        let _ = g.apply(face(6));
        assert_eq!(g.written(1), Some(12));
    }

    #[test]
    fn slot_bonuses_fire_as_they_are_written() {
        let mut g = Green::new();
        assert_eq!(g.apply(face(6)), None);
        assert_eq!(g.apply(face(1)), Some(Effect::Reroll));
    }

    #[test]
    fn a_pair_scores_first_minus_second_once_complete() {
        let mut g = Green::new();
        let _ = g.apply(face(6)); // 6 × 2 = 12
        assert_eq!(g.score(), 0, "an incomplete pair scores nothing");
        let _ = g.apply(face(2)); // 2 × 2 = 4
        assert_eq!(g.score(), 8);
        let _ = g.apply(face(1)); // the second pair opens
        assert_eq!(g.score(), 8);
        assert_eq!(g.pairs().collect::<Vec<_>>(), vec![8, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn negative_pairs_stand_and_the_total_can_go_below_zero() {
        let g = Green::from_faces(&faces(&[1, 6]));
        assert_eq!(g.score(), 2 - 12);
        let g = Green::from_faces(&faces(&[1, 6, 6, 6]));
        assert_eq!(g.score(), -10 + (12 - 6));
        // The worst sheet: 1 at every ×-heavy first slot, 6 at every second.
        let worst = Green::from_faces(&faces(&[1, 6, 1, 6, 1, 6, 1, 6, 1, 6, 1, 6]));
        assert!(worst.score() < 0, "{}", worst.score());
    }

    #[test]
    fn the_score_can_go_backwards_which_is_why_the_harness_has_two_shapes() {
        let mut g = Green::from_faces(&faces(&[6]));
        assert_eq!(g.score(), 0);
        let _ = g.apply(face(6));
        assert_eq!(g.score(), 0);
        let _ = g.apply(face(1));
        let before = g.score();
        let _ = g.apply(face(6));
        assert!(g.score() < before, "{before} → {}", g.score());
    }

    #[test]
    fn free_marks_are_the_six_faces() {
        assert_eq!(Green::new().free_marks().count(), 6);
        let full = Green::from_faces(&faces(&[1; 12]));
        assert_eq!(full.free_marks().count(), 0);
        assert_eq!(full.marks(face(3)).count(), 0);
        assert_eq!(full.next_multiplier(), None);
        assert_eq!(full.written(12), None);
    }

    #[test]
    fn a_full_track_takes_nothing_more() {
        let mut g = Green::from_faces(&faces(&[1; 12]));
        assert!(g.is_full());
        assert_eq!(g.apply(face(6)), None);
        assert_eq!(g.next_slot(), 12);
        assert_eq!(Green::from_faces(&faces(&[6; 20])).faces().len(), 12);
        assert_eq!(Green::multipliers().len(), Green::SLOTS);
    }

    #[test]
    fn survives_the_generic_area_exercises() {
        // `fills_in`, not `saturates_in`: subtraction pairs are the one area
        // whose score is not monotone in the marks made.
        harness::fills_in(&mut Green::new(), &Face::ALL, Green::SLOTS);
    }
}
