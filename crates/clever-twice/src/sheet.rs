//! The score sheet: the five areas, the marks they accept, and the total.

use arrayvec::ArrayVec;
use clever_core::{Areas, Breakdown, Face, Pips, Score};

use crate::area::{Area, Blue, Green, LatticeCell, Pink, Silver, SilverCell, SilverRow, Yellow};
use crate::color::Color;
use crate::effect::{Effect, FreeTarget};

/// A mark on this game's sheet: what to write and where.
///
/// The three tracks name a *value* rather than a slot because the slot is
/// implied by the prefix, and [`Placement::Yellow`] names a *cell* rather than
/// a state because the lattice's mark is relative: it advances whatever the
/// cell holds when it lands.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Placement {
    /// Mark a cell of the silver grid.
    Silver(SilverCell),
    /// Advance a lattice cell one state: circle it, or cross it if circled.
    Yellow(LatticeCell),
    /// Write a sum in blue's next slot.
    Blue(Pips),
    /// Write a face in green's next slot, at that slot's multiplier.
    Green(Face),
    /// Write a face in pink's next slot.
    Pink(Face),
}

impl Placement {
    /// The name of the area this mark lands in.
    #[must_use]
    pub const fn area(self) -> &'static str {
        match self {
            Placement::Silver(_) => Sheet::SILVER,
            Placement::Yellow(_) => Sheet::YELLOW,
            Placement::Blue(_) => Sheet::BLUE,
            Placement::Green(_) => Sheet::GREEN,
            Placement::Pink(_) => Sheet::PINK,
        }
    }

    /// Whether this mark lands in the area a colored `?` targets.
    #[must_use]
    pub const fn is_in(self, target: FreeTarget) -> bool {
        matches!(
            (self, target),
            (Placement::Silver(_), FreeTarget::Silver)
                | (Placement::Yellow(_), FreeTarget::Yellow)
                | (Placement::Blue(_), FreeTarget::Blue)
                | (Placement::Green(_), FreeTarget::Green)
                | (Placement::Pink(_), FreeTarget::Pink)
        )
    }
}

/// The five areas of *Twice as Clever*.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Sheet {
    silver: Silver,
    yellow: Yellow,
    blue: Blue,
    green: Green,
    pink: Pink,
}

impl Sheet {
    /// The name silver appears under in a [`Breakdown`].
    pub const SILVER: &'static str = "silver";
    /// The name yellow appears under in a [`Breakdown`].
    pub const YELLOW: &'static str = "yellow";
    /// The name blue appears under in a [`Breakdown`].
    pub const BLUE: &'static str = "blue";
    /// The name green appears under in a [`Breakdown`].
    pub const GREEN: &'static str = "green";
    /// The name pink appears under in a [`Breakdown`].
    pub const PINK: &'static str = "pink";

    /// A blank sheet. Nothing on this one comes pre-printed.
    #[must_use]
    pub fn new() -> Self {
        Sheet {
            silver: Silver::new(),
            yellow: Yellow::new(),
            blue: Blue::new(),
            green: Green::new(),
            pink: Pink::new(),
        }
    }

    /// The silver grid.
    #[must_use]
    pub const fn silver(&self) -> &Silver {
        &self.silver
    }

    /// The yellow lattice.
    #[must_use]
    pub const fn yellow(&self) -> &Yellow {
        &self.yellow
    }

    /// The blue descend track.
    #[must_use]
    pub const fn blue(&self) -> &Blue {
        &self.blue
    }

    /// The green pairs track.
    #[must_use]
    pub const fn green(&self) -> &Green {
        &self.green
    }

    /// The pink write track.
    #[must_use]
    pub const fn pink(&self) -> &Pink {
        &self.pink
    }

    /// Restore a sheet from its five areas — for a facade resuming a saved
    /// game.
    #[must_use]
    pub fn from_areas(
        silver: Silver,
        yellow: Yellow,
        blue: Blue,
        green: Green,
        pink: Pink,
    ) -> Self {
        Sheet {
            silver,
            yellow,
            blue,
            green,
            pink,
        }
    }

    /// Every mark a die of `color` showing `face` can make.
    ///
    /// `pips` is blue + white, the value blue is *always* written at whichever
    /// of the two dice is spent there; the caller reads it off the mat rather
    /// than from `face`.
    ///
    /// Only the silver die may be *placed* in the silver grid — every other
    /// die reaches it through the platter chain — so nine is the bound and
    /// only the wild die approaches it: four silver rows, two lattice cells of
    /// a value, and one mark each in the three tracks.
    #[must_use]
    pub(crate) fn marks(&self, color: Color, face: Face, pips: Pips) -> DieMarks {
        let mut marks = DieMarks::new();
        let wild = color.is_wild();
        if wild || color == Color::Silver {
            marks.extend(self.silver.marks(face).map(Placement::Silver));
        }
        if wild || color == Color::Yellow {
            marks.extend(self.yellow.marks(face).map(Placement::Yellow));
        }
        if wild || color == Color::Blue {
            marks.extend(self.blue.marks(pips).map(Placement::Blue));
        }
        if wild || color == Color::Green {
            marks.extend(self.green.marks(face).map(Placement::Green));
        }
        if wild || color == Color::Pink {
            marks.extend(self.pink.marks(face).map(Placement::Pink));
        }
        marks
    }

    /// What a colored `?` may mark — the whole of this game's bonus
    /// vocabulary, less the platter chain.
    pub(crate) fn free(&self, target: FreeTarget) -> impl Iterator<Item = Placement> + '_ {
        let silver = matches!(target, FreeTarget::Silver)
            .then(|| self.silver.free_marks().map(Placement::Silver))
            .into_iter()
            .flatten();
        let yellow = matches!(target, FreeTarget::Yellow)
            .then(|| self.yellow.free_marks().map(Placement::Yellow))
            .into_iter()
            .flatten();
        let blue = matches!(target, FreeTarget::Blue)
            .then(|| self.blue.free_marks().map(Placement::Blue))
            .into_iter()
            .flatten();
        let green = matches!(target, FreeTarget::Green)
            .then(|| self.green.free_marks().map(Placement::Green))
            .into_iter()
            .flatten();
        let pink = matches!(target, FreeTarget::Pink)
            .then(|| self.pink.free_marks().map(Placement::Pink))
            .into_iter()
            .flatten();
        silver.chain(yellow).chain(blue).chain(green).chain(pink)
    }

    /// The silver rows where `value` is still open — a platter-chain mark
    /// whose row the player chooses.
    pub(crate) fn silver_rows(&self, value: Face) -> impl Iterator<Item = Placement> + '_ {
        self.silver.open_rows(value).map(Placement::Silver)
    }

    /// A platter-chain mark in a fixed row: `None` when that cell is already
    /// taken, in which case the mark is lost.
    #[must_use]
    pub(crate) fn silver_row(&self, row: SilverRow, value: Face) -> Option<Placement> {
        let cell = SilverCell::at(row, value);
        (!self.silver.is_marked(cell)).then_some(Placement::Silver(cell))
    }

    /// Make a mark and report the bonuses it fired, in the order the sheet
    /// prints them.
    pub(crate) fn apply(&mut self, placement: Placement) -> Fired {
        let mut fired = Fired::new();
        match placement {
            Placement::Silver(c) => fired.extend(self.silver.apply(c)),
            Placement::Yellow(c) => fired.extend(self.yellow.apply(c)),
            Placement::Blue(p) => fired.extend(self.blue.apply(p)),
            Placement::Green(f) => fired.extend(self.green.apply(f)),
            Placement::Pink(f) => fired.extend(self.pink.apply(f)),
        }
        fired
    }

    /// The five area scores, in sheet order.
    #[must_use]
    pub fn areas(&self) -> Areas {
        let mut areas = Areas::new();
        areas.push((Self::SILVER, self.silver.score()));
        areas.push((Self::YELLOW, self.yellow.score()));
        areas.push((Self::BLUE, self.blue.score()));
        areas.push((Self::GREEN, self.green.score()));
        areas.push((Self::PINK, self.pink.score()));
        areas
    }

    /// The sheet's score with `foxes` foxes, each worth the lowest area — a
    /// figure green's subtraction pairs can push below zero.
    #[must_use]
    pub fn score(&self, foxes: u8) -> Breakdown {
        Breakdown::assemble(self.areas(), foxes)
    }

    /// The sum of the five areas, foxes aside.
    #[must_use]
    pub fn subtotal(&self) -> Score {
        self.areas().iter().map(|&(_, s)| s).sum()
    }
}

/// At most two bonuses fire from one mark: a cell belongs to one row and one
/// column.
pub(crate) type Fired = ArrayVec<Effect, 2>;

/// The marks one die offers. Nine is the bound — see [`Sheet::marks`].
pub(crate) type DieMarks = ArrayVec<Placement, 9>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::area::LatticeState;

    fn face(v: u8) -> Face {
        Face::new(v).expect("a die face")
    }

    fn pips(v: u8) -> Pips {
        Pips::new(v).expect("a two-die sum")
    }

    #[test]
    fn a_blank_sheet_scores_nothing() {
        let s = Sheet::new();
        assert_eq!(s.subtotal(), 0);
        let b = s.score(5);
        assert_eq!(b.total, 0);
        assert_eq!(b.fox_points, 0, "an empty area sinks every fox");
        assert_eq!(b.areas.len(), 5);
        assert_eq!(b.area(Sheet::SILVER), Some(0));
        assert_eq!(
            b.areas.iter().map(|&(n, _)| n).collect::<Vec<_>>(),
            vec!["silver", "yellow", "blue", "green", "pink"]
        );
    }

    #[test]
    fn the_white_die_reaches_every_area() {
        let s = Sheet::new();
        let areas: Vec<&str> = s
            .marks(Color::White, face(5), pips(5))
            .into_iter()
            .map(Placement::area)
            .collect();
        for name in [
            Sheet::SILVER,
            Sheet::YELLOW,
            Sheet::BLUE,
            Sheet::GREEN,
            Sheet::PINK,
        ] {
            assert!(areas.contains(&name), "white cannot reach {name}");
        }
    }

    /// The wild die's widest node: four open silver rows, both cells of a
    /// twice-printed lattice value, and one mark in each track.
    #[test]
    fn nine_marks_is_the_widest_one_die_offers() {
        let s = Sheet::new();
        // A 5 is printed twice on the lattice and is a legal blue sum.
        let marks = s.marks(Color::White, face(5), pips(5));
        assert_eq!(marks.len(), 9);
        assert_eq!(marks.len(), marks.capacity(), "the bound is tight");
        for color in Color::ALL {
            for value in Face::ALL {
                for sum in Pips::all() {
                    assert!(s.marks(color, value, sum).len() <= 9);
                }
            }
        }
    }

    #[test]
    fn a_colored_die_reaches_only_its_own_area() {
        let s = Sheet::new();
        for (color, area) in [
            (Color::Yellow, Sheet::YELLOW),
            (Color::Blue, Sheet::BLUE),
            (Color::Green, Sheet::GREEN),
            (Color::Pink, Sheet::PINK),
            (Color::Silver, Sheet::SILVER),
        ] {
            let areas: Vec<&str> = s
                .marks(color, face(5), pips(5))
                .into_iter()
                .map(Placement::area)
                .collect();
            assert!(areas.iter().all(|&a| a == area), "{color}: {areas:?}");
            assert!(!areas.is_empty());
        }
    }

    #[test]
    fn a_colored_question_only_reaches_its_own_area() {
        let s = Sheet::new();
        assert_eq!(s.free(FreeTarget::Silver).count(), 24);
        assert_eq!(s.free(FreeTarget::Yellow).count(), 10);
        assert_eq!(s.free(FreeTarget::Blue).count(), 11);
        assert_eq!(s.free(FreeTarget::Green).count(), 6);
        assert_eq!(s.free(FreeTarget::Pink).count(), 6);
        for target in FreeTarget::ALL {
            assert!(s.free(target).all(|p| p.is_in(target)), "{target}");
        }
    }

    #[test]
    fn a_chain_mark_is_restricted_to_one_value() {
        let mut s = Sheet::new();
        assert_eq!(s.silver_rows(face(3)).count(), 4);
        assert_eq!(
            s.silver_row(SilverRow::Blue, face(3)),
            Some(Placement::Silver(SilverCell::at(SilverRow::Blue, face(3))))
        );
        let _ = s.apply(Placement::Silver(SilverCell::at(SilverRow::Blue, face(3))));
        assert_eq!(s.silver_rows(face(3)).count(), 3);
        assert_eq!(s.silver_row(SilverRow::Blue, face(3)), None, "taken");
    }

    #[test]
    fn a_lattice_mark_advances_whatever_the_cell_holds() {
        let mut s = Sheet::new();
        let mark = s
            .marks(Color::Yellow, face(1), pips(2))
            .into_iter()
            .next()
            .expect("the lone 1");
        let Placement::Yellow(cell) = mark else {
            panic!("a yellow mark")
        };
        let _ = s.apply(mark);
        assert_eq!(s.yellow().state(cell), LatticeState::Circled);
        // The *same* placement, applied again, crosses.
        let _ = s.apply(mark);
        assert_eq!(s.yellow().state(cell), LatticeState::Crossed);
    }

    #[test]
    fn a_placement_is_four_bytes_at_most() {
        assert!(core::mem::size_of::<Placement>() <= 4);
    }
}
