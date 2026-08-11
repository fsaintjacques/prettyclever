//! Green: eleven cells crossed strictly left to right, each with a printed
//! minimum the die must clear.
//!
//! A track that fills left to right has no holes, so its entire state is *how
//! many cells are crossed* — one byte with twelve reachable values, every one
//! of them legal. The prototype spends eleven bytes on 2048 representable
//! configurations of which 2036 cannot occur, and then every consumer has to
//! scan for the frontier because the representation does not know it is a
//! prefix.

use clever_core::{Face, Score};

use super::Area;
use crate::effect::{CrossTarget, Effect, WriteTarget};

/// A cross on green's next cell.
///
/// There is only ever one legal cross, so the mark carries no payload — but
/// it is a type rather than a `()` so that a stale mark cannot be applied to a
/// track that has moved on: [`Green::apply`] rejects nothing, because the mark
/// names "the next cell" and that is always the right cell.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct GreenCross;

/// The green track: the number of crossed cells, 0..=11.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Green {
    crossed: u8,
}

impl Green {
    /// How many cells the track has.
    pub const CELLS: usize = 11;

    /// The minimum face each cell demands, left to right.
    const NEED: [u8; Self::CELLS] = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 6];

    /// Cumulative points by crossed count.
    const POINTS: [Score; Self::CELLS + 1] = [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 66];

    /// The bonus printed under each cell.
    const BONUS: [Option<Effect>; Self::CELLS] = [
        None,
        None,
        None,
        Some(Effect::Plus1),
        None,
        Some(Effect::CrossAny(CrossTarget::Blue)),
        Some(Effect::Fox),
        None,
        Some(Effect::WriteNext(WriteTarget::Purple, Face::SIX)),
        Some(Effect::Reroll),
        None,
    ];

    /// A fresh, empty track.
    #[must_use]
    pub const fn new() -> Self {
        Green { crossed: 0 }
    }

    /// How many cells are crossed.
    #[must_use]
    pub const fn crossed(self) -> u8 {
        self.crossed
    }

    /// A track from a saved crossed count, saturating at the track's length so
    /// no input produces an impossible state.
    #[must_use]
    pub const fn from_crossed(crossed: u8) -> Self {
        Green {
            crossed: if crossed as usize > Self::CELLS {
                Self::CELLS as u8
            } else {
                crossed
            },
        }
    }

    /// Whether the track is full.
    #[must_use]
    pub const fn is_full(self) -> bool {
        self.crossed as usize >= Self::CELLS
    }

    /// The minimum the next cell demands, or `None` when the track is full —
    /// for rendering, and for a bot that wants to know what it is saving for.
    #[must_use]
    pub const fn needs(self) -> Option<Face> {
        if self.is_full() {
            return None;
        }
        Face::new(Self::NEED[self.crossed as usize])
    }

    /// Whether a die of this face may cross the next cell.
    ///
    /// The green `X` bonus ignores this — it is [`Area::free_marks`], which
    /// offers the cross whatever the cell demands.
    #[must_use]
    pub fn accepts(self, face: Face) -> bool {
        self.needs().is_some_and(|need| face >= need)
    }

    /// The minimum printed under every cell, left to right — for rendering.
    #[must_use]
    pub const fn thresholds() -> &'static [u8; Self::CELLS] {
        &Self::NEED
    }
}

impl Area for Green {
    type Mark = GreenCross;
    type Input = Face;
    type Bonus = Option<Effect>;

    fn marks(&self, face: Face) -> impl Iterator<Item = GreenCross> + '_ {
        self.accepts(face).then_some(GreenCross).into_iter()
    }

    /// The green `X`: cross the next cell whatever it demands.
    fn free_marks(&self) -> impl Iterator<Item = GreenCross> + '_ {
        (!self.is_full()).then_some(GreenCross).into_iter()
    }

    fn apply(&mut self, _: GreenCross) -> Option<Effect> {
        if self.is_full() {
            return None;
        }
        let bonus = Self::BONUS[self.crossed as usize];
        self.crossed += 1;
        bonus
    }

    fn score(&self) -> Score {
        Self::POINTS[self.crossed as usize]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::area::harness;

    #[test]
    fn the_printed_track_matches_the_rulebook() {
        assert_eq!(Green::NEED, [1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 6]);
        assert_eq!(Green::POINTS, [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 66]);
        let bonuses: Vec<(usize, Effect)> = Green::BONUS
            .iter()
            .enumerate()
            .filter_map(|(i, b)| b.map(|e| (i, e)))
            .collect();
        assert_eq!(
            bonuses,
            vec![
                (3, Effect::Plus1),
                (5, Effect::CrossAny(CrossTarget::Blue)),
                (6, Effect::Fox),
                (8, Effect::WriteNext(WriteTarget::Purple, Face::SIX)),
                (9, Effect::Reroll),
            ]
        );
    }

    #[test]
    fn the_whole_state_is_a_count() {
        assert_eq!(core::mem::size_of::<Green>(), 1);
        assert_eq!(Green::new().crossed(), 0);
        assert_eq!(Green::from_crossed(200).crossed(), 11);
        assert!(Green::from_crossed(11).is_full());
    }

    #[test]
    fn a_die_must_clear_the_printed_minimum() {
        let mut g = Green::new();
        assert_eq!(g.needs(), Some(Face::ONE));
        assert!(g.accepts(Face::ONE));
        let mark = g.marks(Face::ONE).next().unwrap();
        let _ = g.apply(mark);
        // Cell 1 wants a 2.
        assert_eq!(g.needs(), Some(Face::TWO));
        assert_eq!(g.marks(Face::ONE).count(), 0);
        assert_eq!(g.marks(Face::SIX).count(), 1);
    }

    #[test]
    fn the_green_x_ignores_the_threshold() {
        let g = Green::from_crossed(10); // the last cell wants a 6
        assert_eq!(g.needs(), Some(Face::SIX));
        assert_eq!(g.marks(Face::ONE).count(), 0);
        assert_eq!(g.free_marks().count(), 1);
        // A full track offers nothing, to a die or a bonus.
        let full = Green::from_crossed(11);
        assert_eq!(full.free_marks().count(), 0);
        assert_eq!(full.marks(Face::SIX).count(), 0);
    }

    #[test]
    fn crossing_fires_the_cell_below() {
        let mut g = Green::from_crossed(3); // cell 3 carries the +1
        assert_eq!(g.apply(GreenCross), Some(Effect::Plus1));
        assert_eq!(g.apply(GreenCross), None); // cell 4 is bare
        assert_eq!(
            g.apply(GreenCross),
            Some(Effect::CrossAny(CrossTarget::Blue))
        );
        assert_eq!(g.crossed(), 6);
    }

    #[test]
    fn a_full_track_absorbs_a_stale_cross() {
        let mut g = Green::from_crossed(11);
        assert_eq!(g.apply(GreenCross), None);
        assert_eq!(g.crossed(), 11);
        assert_eq!(g.score(), 66);
    }

    #[test]
    fn scoring_follows_the_position_table() {
        for n in 0..=11u8 {
            assert_eq!(Green::from_crossed(n).score(), Green::POINTS[n as usize]);
        }
        assert_eq!(Green::from_crossed(7).score(), 28);
        assert_eq!(Green::thresholds().len(), Green::CELLS);
    }

    #[test]
    fn survives_the_generic_area_exercises() {
        harness::saturates_in(&mut Green::new(), &[Face::SIX], Green::CELLS);
    }
}
