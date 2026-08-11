//! Orange: eleven slots written left to right, some of them multipliers.
//!
//! `ArrayVec<Face, 11>` *is* "a prefix of written faces": a hole in the middle
//! of the track is unrepresentable rather than merely unreached, and `len()`
//! is the frontier.
//!
//! The track stores the **die** value and applies the multiplier when scoring.
//! The prototype stores the already-multiplied number and then recovers the
//! die value by dividing — which is how *Twice*'s pink bonus gate ends up
//! written as `p.value / multipliers[p.cell] < min`.

use arrayvec::ArrayVec;
use clever_core::{Face, Score};

use super::Area;
use crate::effect::{CrossTarget, Effect, WriteTarget};

/// The orange track: the faces written so far, in order.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Orange(ArrayVec<Face, 11>);

impl Orange {
    /// How many slots the track has.
    pub const SLOTS: usize = 11;

    /// What each slot multiplies its written face by.
    const MULT: [Score; Self::SLOTS] = [1, 1, 1, 2, 1, 1, 2, 1, 2, 1, 3];

    /// The bonus printed under each slot.
    const BONUS: [Option<Effect>; Self::SLOTS] = [
        None,
        None,
        Some(Effect::Reroll),
        None,
        Some(Effect::CrossAny(CrossTarget::Yellow)),
        Some(Effect::Plus1),
        None,
        Some(Effect::Fox),
        None,
        Some(Effect::WriteNext(WriteTarget::Purple, Face::SIX)),
        None,
    ];

    /// A fresh, empty track.
    #[must_use]
    pub fn new() -> Self {
        Orange(ArrayVec::new())
    }

    /// The faces written so far, left to right.
    #[must_use]
    pub fn faces(&self) -> &[Face] {
        &self.0
    }

    /// A track from a saved prefix; faces past the last slot are dropped.
    #[must_use]
    pub fn from_faces(faces: &[Face]) -> Self {
        Orange(faces.iter().copied().take(Self::SLOTS).collect())
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

    /// The multiplier printed on every slot, left to right — for rendering.
    #[must_use]
    pub const fn multipliers() -> &'static [Score; Self::SLOTS] {
        &Self::MULT
    }
}

impl Area for Orange {
    /// The face to write. The slot is implied by the prefix, so a mark
    /// enumerated before another write cannot land in a stale slot.
    type Mark = Face;
    type Input = Face;
    type Bonus = Option<Effect>;

    /// Orange takes any face, so long as a slot is left.
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
        self.0
            .iter()
            .zip(Self::MULT)
            .map(|(f, mult)| f.score() * mult)
            .sum()
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
        assert_eq!(Orange::MULT, [1, 1, 1, 2, 1, 1, 2, 1, 2, 1, 3]);
        let bonuses: Vec<(usize, Effect)> = Orange::BONUS
            .iter()
            .enumerate()
            .filter_map(|(i, b)| b.map(|e| (i, e)))
            .collect();
        assert_eq!(
            bonuses,
            vec![
                (2, Effect::Reroll),
                (4, Effect::CrossAny(CrossTarget::Yellow)),
                (5, Effect::Plus1),
                (7, Effect::Fox),
                (9, Effect::WriteNext(WriteTarget::Purple, Face::SIX)),
            ]
        );
    }

    #[test]
    fn writing_fills_the_next_slot() {
        let mut o = Orange::new();
        assert_eq!(o.next_slot(), 0);
        for f in faces(&[3, 5, 2]) {
            let mark = o.marks(f).next().unwrap();
            let _ = o.apply(mark);
        }
        assert_eq!(o.faces(), faces(&[3, 5, 2]).as_slice());
        assert_eq!(o.next_slot(), 3);
    }

    #[test]
    fn the_multiplier_is_applied_at_scoring_time() {
        // 3 + 5 + 2 + 4×2 = 18 — the rulebook example.
        let o = Orange::from_faces(&faces(&[3, 5, 2, 4]));
        assert_eq!(o.faces()[3], Face::FOUR, "the die value is stored, not 8");
        assert_eq!(o.score(), 18);
        // Every slot at 6: 6 × (1+1+1+2+1+1+2+1+2+1+3) = 6 × 16.
        let full = Orange::from_faces(&faces(&[6; 11]));
        assert_eq!(full.score(), 96);
        assert!(full.is_full());
    }

    #[test]
    fn a_full_track_takes_nothing_more() {
        let mut o = Orange::from_faces(&faces(&[1; 11]));
        assert_eq!(o.marks(Face::SIX).count(), 0);
        assert_eq!(o.free_marks().count(), 0);
        assert_eq!(o.apply(Face::SIX), None);
        assert_eq!(o.faces().len(), 11);
        // A saved prefix longer than the track is truncated, not rejected.
        assert_eq!(Orange::from_faces(&faces(&[2; 20])).faces().len(), 11);
    }

    #[test]
    fn slot_bonuses_fire_as_they_are_written() {
        let mut o = Orange::new();
        let fired: Vec<Option<Effect>> = (0..11).map(|_| o.apply(Face::THREE)).collect();
        assert_eq!(fired[2], Some(Effect::Reroll));
        assert_eq!(fired[4], Some(Effect::CrossAny(CrossTarget::Yellow)));
        assert_eq!(fired[5], Some(Effect::Plus1));
        assert_eq!(fired[7], Some(Effect::Fox));
        assert_eq!(
            fired[9],
            Some(Effect::WriteNext(WriteTarget::Purple, Face::SIX))
        );
        assert_eq!(fired[0], None);
        assert_eq!(Orange::multipliers().len(), Orange::SLOTS);
    }

    #[test]
    fn a_free_mark_offers_every_face() {
        assert_eq!(Orange::new().free_marks().count(), 6);
    }

    #[test]
    fn survives_the_generic_area_exercises() {
        harness::saturates_in(&mut Orange::new(), &Face::ALL, Orange::SLOTS);
    }
}
