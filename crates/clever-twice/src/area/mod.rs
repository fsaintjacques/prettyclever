//! The five scoring areas.
//!
//! Each is a plain struct with a tight representation and inherent methods;
//! [`Area`] records the shape they have in common. It is a *shape*, not a
//! plugin interface — the phase machine calls concrete methods on concrete
//! fields, and anything one area needs that the others do not (pink's bonus
//! gate, silver's open rows, green's pair arithmetic) is an inherent method
//! with a name that says what it does.
//!
//! The design rule the representations follow is **encode the reachable
//! states, not the grid**: the three tracks are prefixes of what was written,
//! the silver grid is one bitset, and the yellow lattice is two — `circled`
//! and `crossed`, with `crossed ⊆ circled`.
//!
//! Only one thing about the trait changed to accommodate this sheet, and it is
//! not the trait: [`Yellow`]'s mark is **relative**. It names a cell, and
//! [`Area::apply`] advances that cell one state. The trait already tolerated
//! that — `Mark` is opaque — so `Area` survived the two-state cell intact.

mod blue;
mod green;
mod pink;
mod silver;
mod yellow;

pub use blue::Blue;
pub use green::Green;
pub use pink::Pink;
pub use silver::{Silver, SilverCell, SilverRow};
pub use yellow::{LatticeCell, LatticeState, Yellow};

use clever_core::Score;

use crate::effect::Effect;

/// The shape the five areas share.
///
/// The three methods that matter are the three the phase machine needs:
/// [`marks`](Area::marks) answers "what can this die do here",
/// [`free_marks`](Area::free_marks) answers "what can a bonus do here without
/// a die", and [`apply`](Area::apply) marks and reports what fired.
///
/// This sheet's bonuses are almost all the second question: every colored `?`
/// is `free_marks` on one area, and the platter chain's row choice is
/// [`Silver::open_rows`] — the only bonus of either game that is neither of
/// the two, because it is restricted to one value.
pub trait Area {
    /// A fully determined mark. Small and `Copy`, so it can sit inside an
    /// action.
    ///
    /// "Fully determined" does not mean absolute: [`Yellow`]'s mark names a
    /// cell and advances it one state, so the same mark means "circle" or
    /// "cross" depending on when it lands. Only the *choice* has to be
    /// determined; what it writes may still depend on the sheet.
    type Mark: Copy + Eq;

    /// What a die contributes here — a [`Face`](clever_core::Face) for four
    /// areas, [`Pips`](clever_core::Pips) for blue's two-die sum.
    type Input: Copy;

    /// The effects one mark can fire. At most two: a mark completes at most
    /// one row and one column.
    type Bonus: IntoIterator<Item = Effect>;

    /// The legal marks for a die contributing `input`.
    fn marks(&self, input: Self::Input) -> impl Iterator<Item = Self::Mark> + '_;

    /// The marks a colored `?` may make with no die behind it — every open
    /// cell of the silver grid, every circle or cross of the lattice, every
    /// value the tracks will still take.
    fn free_marks(&self) -> impl Iterator<Item = Self::Mark> + '_;

    /// Make the mark and report the bonuses it fired.
    fn apply(&mut self, mark: Self::Mark) -> Self::Bonus;

    /// This area's contribution to the total. Green's can be negative.
    fn score(&self) -> Score;
}

#[cfg(test)]
pub(crate) mod harness {
    //! Generic exercises every area must survive. Written once against
    //! [`Area`] and instantiated five times — the trait's whole return on
    //! investment.

    use super::Area;

    /// Anything a die can mark, a `?` with no die behind it can mark too — the
    /// containment that lets the phase machine resolve every colored `?`
    /// through one method.
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
    /// exactly `marks` marks and then stops offering anything — the area is a
    /// finite resource that cannot be spent twice.
    ///
    /// `marks` counts *marks*, not cells, which is what lets the two-state
    /// lattice through unchanged: ten cells at two states each saturate in
    /// twenty marks.
    pub(crate) fn fills_in<A: Area>(area: &mut A, inputs: &[A::Input], marks: usize) {
        run(area, inputs, marks, false);
    }

    /// [`fills_in`], and the score never goes backwards on the way.
    ///
    /// The second shape the base game's harness did not need. Four of this
    /// sheet's five areas are monotone in the marks made; green's subtraction
    /// pairs are not, and splitting the exercise says so explicitly rather
    /// than quietly dropping the check for everyone.
    pub(crate) fn saturates_in<A: Area>(area: &mut A, inputs: &[A::Input], marks: usize) {
        run(area, inputs, marks, true);
    }

    fn run<A: Area>(area: &mut A, inputs: &[A::Input], marks: usize, monotone: bool) {
        let mut applied = 0;
        let mut last = area.score();
        assert_eq!(last, 0, "a fresh area scores nothing");
        loop {
            marks_are_free_marks(area, inputs);
            let Some(mark) = inputs.iter().find_map(|&i| area.marks(i).next()) else {
                break;
            };
            assert!(applied < marks, "the area never saturated");
            for _ in area.apply(mark) {}
            applied += 1;
            let now = area.score();
            assert!(
                !monotone || now >= last,
                "score went backwards: {last} → {now}"
            );
            last = now;
        }
        assert_eq!(applied, marks, "the area saturated early");
        assert_eq!(
            area.free_marks().count(),
            0,
            "a full area still offers marks"
        );
    }
}
