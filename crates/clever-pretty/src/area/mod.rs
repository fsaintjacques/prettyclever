//! The five scoring areas.
//!
//! Each is a plain struct with a tight representation and inherent methods;
//! [`Area`] records the shape they have in common. It is a *shape*, not a
//! plugin interface — the phase machine calls concrete methods on concrete
//! fields, and anything one area needs that the others do not is an inherent
//! method with a name that says what it does.
//!
//! The design rule the representations follow is **encode the reachable
//! states, not the grid**: green's entire state is a crossed count, the two
//! write tracks are prefixes of written faces, and only the two grids — whose
//! cells really are crossed in any order — are bitsets.

mod blue;
mod green;
mod orange;
mod purple;
mod yellow;

pub use blue::{Blue, BlueCell};
pub use green::{Green, GreenCross};
pub use orange::Orange;
pub use purple::Purple;
pub use yellow::{Yellow, YellowCell};

use clever_core::Score;

use crate::effect::Effect;

/// The shape the five areas share.
///
/// The three methods that matter are the three the phase machine needs:
/// [`marks`](Area::marks) answers "what can this die do here",
/// [`free_marks`](Area::free_marks) answers "what can a bonus do here without
/// a die", and [`apply`](Area::apply) marks and reports what fired.
///
/// The base game's bonuses are exactly these two questions:
/// a *cross any* bonus is `free_marks` on a grid, a *cross next* bonus is
/// `free_marks` on green (which is where the "ignore the threshold" rule
/// lives), and a *write next N* bonus is `marks(N)` on a track.
pub trait Area {
    /// A fully determined mark: what to write and where. Small and `Copy`, so
    /// it can sit inside an action.
    type Mark: Copy + Eq;

    /// What a die contributes here — a [`Face`](clever_core::Face) for four
    /// areas, [`Pips`](clever_core::Pips) for blue's two-die sum.
    type Input: Copy;

    /// The effects one mark can fire. At most two: a mark completes at most
    /// one row and one column-or-diagonal.
    type Bonus: IntoIterator<Item = Effect>;

    /// The legal marks for a die contributing `input`.
    fn marks(&self, input: Self::Input) -> impl Iterator<Item = Self::Mark> + '_;

    /// The marks a bonus may make with no die behind it — every open cell of
    /// a grid, green's next cell whatever it demands, every face a track will
    /// still take.
    fn free_marks(&self) -> impl Iterator<Item = Self::Mark> + '_;

    /// Make the mark and report the bonuses it fired.
    fn apply(&mut self, mark: Self::Mark) -> Self::Bonus;

    /// This area's contribution to the total.
    fn score(&self) -> Score;
}

#[cfg(test)]
pub(crate) mod harness {
    //! Generic exercises every area must survive. Written once against
    //! [`Area`] and instantiated five times — the trait's whole return on
    //! investment.

    use super::Area;

    /// Anything a die can mark, a bonus with no die behind it can mark too —
    /// the containment that lets the phase machine resolve *cross any*,
    /// *cross next* and *write next* through the same two methods.
    pub(crate) fn marks_are_free_marks<A: Area>(area: &A, inputs: &[A::Input]) {
        let free: Vec<A::Mark> = area.free_marks().collect();
        for &input in inputs {
            for mark in area.marks(input) {
                assert!(
                    free.contains(&mark),
                    "a mark a die can make is not among the free marks"
                );
            }
        }
    }

    /// Marking greedily with the first input that fits fills the area in
    /// exactly `capacity` marks and then stops offering anything — the area is
    /// a finite resource that cannot be spent twice — and the score never goes
    /// backwards on the way (true of all five areas of *this* game; *Twice*'s
    /// subtraction pairs are the counter-example, and they live elsewhere).
    pub(crate) fn saturates_in<A: Area>(area: &mut A, inputs: &[A::Input], capacity: usize) {
        let mut applied = 0;
        let mut last = area.score();
        assert_eq!(last, 0, "a fresh area scores nothing");
        loop {
            marks_are_free_marks(area, inputs);
            let Some(mark) = inputs.iter().find_map(|&i| area.marks(i).next()) else {
                break;
            };
            assert!(applied < capacity, "the area never saturated");
            for _ in area.apply(mark) {}
            applied += 1;
            let now = area.score();
            assert!(now >= last, "score went backwards: {last} → {now}");
            last = now;
        }
        assert_eq!(applied, capacity, "the area saturated early");
        assert_eq!(
            area.free_marks().count(),
            0,
            "a full area still offers marks"
        );
    }
}
