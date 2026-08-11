//! Pink: twelve slots written left to right, with bonus gates.
//!
//! Any face is a legal write, but the bonus printed under a slot is granted
//! **only when the written face meets the slot's printed minimum**. Writing
//! below it fills the slot and withholds the bonus — the one rule on either
//! sheet where a mark lands and its bonus does not.
//!
//! The gate reads the die's face. There is no multiplier to see past here
//! (every pink slot is ×1), but the prototype's shared write track compares
//! `value / multiplier` against the minimum precisely because it stores the
//! product; storing the face makes the gate a comparison of two faces.

use arrayvec::ArrayVec;
use clever_core::{Face, Score};

use super::Area;
use crate::effect::{Effect, FreeTarget};

/// The pink track: the faces written so far, in order.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Pink(ArrayVec<Face, 12>);

impl Pink {
    /// How many slots the track has.
    pub const SLOTS: usize = 12;

    /// The bonus printed under each slot.
    const BONUS: [Option<Effect>; Self::SLOTS] = [
        None,
        None,
        Some(Effect::Reroll),
        Some(Effect::Return),
        Some(Effect::Plus1),
        Some(Effect::Free(FreeTarget::Green)),
        Some(Effect::Free(FreeTarget::Yellow)),
        Some(Effect::Fox),
        Some(Effect::Free(FreeTarget::Silver)),
        Some(Effect::Reroll),
        Some(Effect::Free(FreeTarget::Blue)),
        Some(Effect::Free(FreeTarget::Yellow)),
    ];

    /// The face a write must reach for the slot's bonus to be granted; `0`
    /// where the slot prints no bonus and so no gate.
    const GATE: [u8; Self::SLOTS] = [0, 0, 2, 3, 4, 5, 6, 2, 3, 4, 5, 6];

    /// A fresh, empty track.
    #[must_use]
    pub fn new() -> Self {
        Pink(ArrayVec::new())
    }

    /// The faces written so far, left to right.
    #[must_use]
    pub fn faces(&self) -> &[Face] {
        &self.0
    }

    /// A track from a saved prefix; faces past the last slot are dropped.
    #[must_use]
    pub fn from_faces(faces: &[Face]) -> Self {
        Pink(faces.iter().copied().take(Self::SLOTS).collect())
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

    /// The minimum face a slot's bonus is gated on, or `None` for a slot with
    /// no printed bonus.
    #[must_use]
    pub fn gate(slot: usize) -> Option<Face> {
        Face::new(*Self::GATE.get(slot)?)
    }

    /// The minimum the *next* write must reach to earn its slot's bonus — what
    /// a bot deciding whether a low pink die is worth spending here reads.
    #[must_use]
    pub fn next_gate(&self) -> Option<Face> {
        Pink::gate(self.0.len())
    }

    /// Whether writing `face` into `slot` would earn that slot's bonus.
    #[must_use]
    pub fn clears_gate(slot: usize, face: Face) -> bool {
        Pink::gate(slot).map_or(true, |min| face >= min)
    }
}

impl Area for Pink {
    /// The face to write; the slot is implied by the prefix.
    type Mark = Face;
    type Input = Face;
    type Bonus = Option<Effect>;

    /// Pink takes any face, so long as a slot is left. Whether the bonus comes
    /// with it is [`Pink::clears_gate`]'s business, not legality's.
    fn marks(&self, face: Face) -> impl Iterator<Item = Face> + '_ {
        (!self.is_full()).then_some(face).into_iter()
    }

    fn free_marks(&self) -> impl Iterator<Item = Face> + '_ {
        Face::ALL.into_iter().filter(move |_| !self.is_full())
    }

    fn apply(&mut self, face: Face) -> Option<Effect> {
        let slot = self.0.len();
        self.0.try_push(face).ok()?;
        Self::BONUS[slot].filter(|_| Pink::clears_gate(slot, face))
    }

    fn score(&self) -> Score {
        self.0.iter().map(|f| f.score()).sum()
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
        let bonuses: Vec<(usize, Effect)> = Pink::BONUS
            .iter()
            .enumerate()
            .filter_map(|(i, b)| b.map(|e| (i, e)))
            .collect();
        assert_eq!(
            bonuses,
            vec![
                (2, Effect::Reroll),
                (3, Effect::Return),
                (4, Effect::Plus1),
                (5, Effect::Free(FreeTarget::Green)),
                (6, Effect::Free(FreeTarget::Yellow)),
                (7, Effect::Fox),
                (8, Effect::Free(FreeTarget::Silver)),
                (9, Effect::Reroll),
                (10, Effect::Free(FreeTarget::Blue)),
                (11, Effect::Free(FreeTarget::Yellow)),
            ]
        );
        // Every slot with a bonus has a gate, and only those.
        for slot in 0..Pink::SLOTS {
            assert_eq!(
                Pink::gate(slot).is_some(),
                Pink::BONUS[slot].is_some(),
                "slot {slot}"
            );
        }
        let gates: Vec<u8> = (0..Pink::SLOTS)
            .filter_map(|s| Pink::gate(s).map(Face::get))
            .collect();
        assert_eq!(gates, vec![2, 3, 4, 5, 6, 2, 3, 4, 5, 6]);
        assert_eq!(Pink::gate(12), None);
    }

    #[test]
    fn any_face_is_a_legal_write() {
        let p = Pink::new();
        assert_eq!(p.marks(face(1)).count(), 1);
        assert_eq!(p.free_marks().count(), 6);
        assert_eq!(p.next_gate(), None, "slot 1 prints no bonus");
    }

    #[test]
    fn a_write_below_the_gate_fills_the_slot_and_withholds_the_bonus() {
        let mut p = Pink::from_faces(&faces(&[3, 3]));
        assert_eq!(p.next_gate(), Some(Face::TWO));
        assert_eq!(p.apply(face(1)), None, "slot 3 wants a 2");
        assert_eq!(p.faces().len(), 3, "the slot is filled all the same");
        assert_eq!(p.score(), 7);
        assert_eq!(p.apply(face(2)), None, "slot 4 wants a 3");
        assert_eq!(p.next_slot(), 4);
    }

    #[test]
    fn a_write_at_or_above_the_gate_earns_the_bonus() {
        let mut p = Pink::from_faces(&faces(&[6, 6]));
        assert_eq!(
            p.apply(face(2)),
            Some(Effect::Reroll),
            "exactly the minimum"
        );
        let mut p = Pink::from_faces(&faces(&[6; 6]));
        assert_eq!(p.apply(face(6)), Some(Effect::Free(FreeTarget::Yellow)));
        let mut p = Pink::from_faces(&faces(&[6; 7]));
        assert_eq!(p.apply(face(2)), Some(Effect::Fox), "slot 8 only wants a 2");
    }

    #[test]
    fn the_gate_reads_the_face_written() {
        for slot in 0..Pink::SLOTS {
            let Some(min) = Pink::gate(slot) else {
                continue;
            };
            for f in Face::ALL {
                assert_eq!(Pink::clears_gate(slot, f), f >= min, "slot {slot} {f}");
            }
        }
        assert!(
            Pink::clears_gate(0, Face::ONE),
            "an ungated slot always pays"
        );
    }

    #[test]
    fn scoring_sums_the_written_faces() {
        assert_eq!(Pink::new().score(), 0);
        assert_eq!(Pink::from_faces(&faces(&[6, 6, 5, 3, 1, 2])).score(), 23);
        assert_eq!(Pink::from_faces(&faces(&[6; 12])).score(), 72);
    }

    #[test]
    fn a_full_track_takes_nothing_more() {
        let mut p = Pink::from_faces(&faces(&[1; 12]));
        assert!(p.is_full());
        assert_eq!(p.marks(face(6)).count(), 0);
        assert_eq!(p.free_marks().count(), 0);
        assert_eq!(p.apply(face(6)), None);
        assert_eq!(p.next_gate(), None);
        assert_eq!(Pink::from_faces(&faces(&[2; 20])).faces().len(), 12);
    }

    #[test]
    fn survives_the_generic_area_exercises() {
        harness::saturates_in(&mut Pink::new(), &Face::ALL, Pink::SLOTS);
    }
}
