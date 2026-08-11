//! The score sheet: the five areas, the marks they accept, and the total.

use arrayvec::ArrayVec;
use clever_core::{Areas, Breakdown, Face, Pips, Score};

use crate::area::{Area, Blue, BlueCell, Green, GreenCross, Orange, Purple, Yellow, YellowCell};
use crate::color::Color;
use crate::effect::{CrossTarget, Effect, WriteTarget};

/// A mark on this game's sheet: what to write and where.
///
/// [`Placement::Green`] carries no payload because green only ever has one
/// legal cross, and the two tracks name a *face* rather than a slot because
/// the slot is implied by the prefix. The prototype's `{ area, cell, value }`
/// triple has to encode all five of these shapes in one struct whose `value`
/// field means something different in each.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Placement {
    /// Cross a yellow cell showing the die's face.
    Yellow(YellowCell),
    /// Cross the blue cell holding blue + white.
    Blue(BlueCell),
    /// Cross green's next cell.
    Green,
    /// Write a face in orange's next slot.
    Orange(Face),
    /// Write a face in purple's next slot.
    Purple(Face),
}

impl Placement {
    /// The name of the area this mark lands in.
    #[must_use]
    pub const fn area(self) -> &'static str {
        match self {
            Placement::Yellow(_) => Sheet::YELLOW,
            Placement::Blue(_) => Sheet::BLUE,
            Placement::Green => Sheet::GREEN,
            Placement::Orange(_) => Sheet::ORANGE,
            Placement::Purple(_) => Sheet::PURPLE,
        }
    }

    /// Whether this mark is a cross in the grid a *cross any* bonus targets.
    #[must_use]
    pub const fn crosses(self, target: CrossTarget) -> bool {
        matches!(
            (self, target),
            (Placement::Yellow(_), CrossTarget::Yellow) | (Placement::Blue(_), CrossTarget::Blue)
        )
    }
}

/// The five areas of *That's Pretty Clever*.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Sheet {
    yellow: Yellow,
    blue: Blue,
    green: Green,
    orange: Orange,
    purple: Purple,
}

impl Sheet {
    /// The name yellow appears under in a [`Breakdown`].
    pub const YELLOW: &'static str = "yellow";
    /// The name blue appears under in a [`Breakdown`].
    pub const BLUE: &'static str = "blue";
    /// The name green appears under in a [`Breakdown`].
    pub const GREEN: &'static str = "green";
    /// The name orange appears under in a [`Breakdown`].
    pub const ORANGE: &'static str = "orange";
    /// The name purple appears under in a [`Breakdown`].
    pub const PURPLE: &'static str = "purple";

    /// A blank sheet: yellow's four printed crosses, everything else empty.
    #[must_use]
    pub fn new() -> Self {
        Sheet {
            yellow: Yellow::new(),
            blue: Blue::new(),
            green: Green::new(),
            orange: Orange::new(),
            purple: Purple::new(),
        }
    }

    /// The yellow grid.
    #[must_use]
    pub const fn yellow(&self) -> &Yellow {
        &self.yellow
    }

    /// The blue grid.
    #[must_use]
    pub const fn blue(&self) -> &Blue {
        &self.blue
    }

    /// The green track.
    #[must_use]
    pub const fn green(&self) -> &Green {
        &self.green
    }

    /// The orange track.
    #[must_use]
    pub const fn orange(&self) -> &Orange {
        &self.orange
    }

    /// The purple track.
    #[must_use]
    pub const fn purple(&self) -> &Purple {
        &self.purple
    }

    /// Restore a sheet from its five areas — for a facade resuming a saved
    /// game.
    #[must_use]
    pub fn from_areas(
        yellow: Yellow,
        blue: Blue,
        green: Green,
        orange: Orange,
        purple: Purple,
    ) -> Self {
        Sheet {
            yellow,
            blue,
            green,
            orange,
            purple,
        }
    }

    /// Every mark a die of `color` showing `face` can make.
    ///
    /// `pips` is blue + white, the value blue is *always* marked at whichever
    /// of the two dice is spent there; the caller reads it off the mat rather
    /// than from `face`.
    ///
    /// Six is the real bound: yellow prints every value twice and the other
    /// four areas offer at most one mark each, so only the wild die can fill
    /// the buffer.
    #[must_use]
    pub(crate) fn marks(&self, color: Color, face: Face, pips: Pips) -> DieMarks {
        let mut marks = DieMarks::new();
        let wild = color.is_wild();
        if wild || color == Color::Yellow {
            marks.extend(self.yellow.marks(face).map(Placement::Yellow));
        }
        if wild || color == Color::Blue {
            marks.extend(self.blue.marks(pips).map(Placement::Blue));
        }
        if wild || color == Color::Green {
            marks.extend(self.green.marks(face).map(|GreenCross| Placement::Green));
        }
        if wild || color == Color::Orange {
            marks.extend(self.orange.marks(face).map(Placement::Orange));
        }
        if wild || color == Color::Purple {
            marks.extend(self.purple.marks(face).map(Placement::Purple));
        }
        marks
    }

    /// The open cells of a grid — what a *cross any* bonus may take.
    pub(crate) fn open(&self, target: CrossTarget) -> impl Iterator<Item = Placement> + '_ {
        let yellow = matches!(target, CrossTarget::Yellow)
            .then(|| self.yellow.free_marks().map(Placement::Yellow))
            .into_iter()
            .flatten();
        let blue = matches!(target, CrossTarget::Blue)
            .then(|| self.blue.free_marks().map(Placement::Blue))
            .into_iter()
            .flatten();
        yellow.chain(blue)
    }

    /// Green's next cross, whatever the cell demands — the green `X`.
    #[must_use]
    pub(crate) fn cross_next_green(&self) -> Option<Placement> {
        self.green
            .free_marks()
            .next()
            .map(|GreenCross| Placement::Green)
    }

    /// A fixed number in a track's next slot — orange 4/5/6 and purple 6.
    /// `None` when the track will not take it, in which case the bonus is
    /// lost.
    #[must_use]
    pub(crate) fn write_next(&self, target: WriteTarget, face: Face) -> Option<Placement> {
        match target {
            WriteTarget::Orange => self.orange.marks(face).next().map(Placement::Orange),
            WriteTarget::Purple => self.purple.marks(face).next().map(Placement::Purple),
        }
    }

    /// Make a mark and report the bonuses it fired, in the order the sheet
    /// prints them.
    pub(crate) fn apply(&mut self, placement: Placement) -> Fired {
        let mut fired = Fired::new();
        match placement {
            Placement::Yellow(c) => fired.extend(self.yellow.apply(c)),
            Placement::Blue(c) => fired.extend(self.blue.apply(c)),
            Placement::Green => fired.extend(self.green.apply(GreenCross)),
            Placement::Orange(f) => fired.extend(self.orange.apply(f)),
            Placement::Purple(f) => fired.extend(self.purple.apply(f)),
        }
        fired
    }

    /// The five area scores, in sheet order.
    #[must_use]
    pub fn areas(&self) -> Areas {
        let mut areas = Areas::new();
        areas.push((Self::YELLOW, self.yellow.score()));
        areas.push((Self::BLUE, self.blue.score()));
        areas.push((Self::GREEN, self.green.score()));
        areas.push((Self::ORANGE, self.orange.score()));
        areas.push((Self::PURPLE, self.purple.score()));
        areas
    }

    /// The sheet's score with `foxes` foxes, each worth the lowest area.
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
/// column-or-diagonal.
pub(crate) type Fired = ArrayVec<Effect, 2>;

/// The marks one die offers. Six is the bound — see [`Sheet::marks`].
pub(crate) type DieMarks = ArrayVec<Placement, 6>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Color;

    fn pips(v: u8) -> Pips {
        Pips::new(v).unwrap()
    }

    #[test]
    fn a_blank_sheet_scores_nothing() {
        let s = Sheet::new();
        assert_eq!(s.subtotal(), 0);
        let b = s.score(5);
        assert_eq!(b.total, 0);
        assert_eq!(b.fox_points, 0, "an empty area sinks every fox");
        assert_eq!(b.areas.len(), 5);
        assert_eq!(b.area(Sheet::YELLOW), Some(0));
    }

    #[test]
    fn the_white_die_reaches_every_area() {
        let s = Sheet::new();
        let areas: Vec<&str> = s
            .marks(Color::White, Face::FIVE, pips(5))
            .into_iter()
            .map(Placement::area)
            .collect();
        for name in [
            Sheet::YELLOW,
            Sheet::BLUE,
            Sheet::GREEN,
            Sheet::ORANGE,
            Sheet::PURPLE,
        ] {
            assert!(areas.contains(&name), "white cannot reach {name}");
        }
    }

    #[test]
    fn a_colored_die_reaches_only_its_own_area() {
        let s = Sheet::new();
        for (color, area) in [
            (Color::Yellow, Sheet::YELLOW),
            (Color::Blue, Sheet::BLUE),
            (Color::Green, Sheet::GREEN),
            (Color::Orange, Sheet::ORANGE),
            (Color::Purple, Sheet::PURPLE),
        ] {
            let areas: Vec<&str> = s
                .marks(color, Face::FIVE, pips(5))
                .into_iter()
                .map(Placement::area)
                .collect();
            assert!(areas.iter().all(|&a| a == area), "{color}: {areas:?}");
            assert!(!areas.is_empty());
        }
    }

    #[test]
    fn a_cross_any_bonus_only_reaches_its_own_grid() {
        let s = Sheet::new();
        assert_eq!(s.open(CrossTarget::Yellow).count(), 12);
        assert_eq!(s.open(CrossTarget::Blue).count(), 11);
        assert!(s
            .open(CrossTarget::Yellow)
            .all(|p| p.crosses(CrossTarget::Yellow)));
    }

    #[test]
    fn write_next_respects_the_track_it_writes_into() {
        let mut s = Sheet::new();
        assert_eq!(
            s.write_next(WriteTarget::Orange, Face::FOUR),
            Some(Placement::Orange(Face::FOUR))
        );
        // Purple has just taken a 6, so only another 6 — or anything, since a
        // 6 resets — still fits.
        let _ = s.apply(Placement::Purple(Face::SIX));
        assert_eq!(
            s.write_next(WriteTarget::Purple, Face::SIX),
            Some(Placement::Purple(Face::SIX))
        );
        // A full purple track loses the bonus.
        s = Sheet::from_areas(
            Yellow::new(),
            Blue::new(),
            Green::new(),
            Orange::new(),
            Purple::from_faces(&[Face::SIX; 11]),
        );
        assert_eq!(s.write_next(WriteTarget::Purple, Face::SIX), None);
    }

    #[test]
    fn green_has_exactly_one_cross_and_then_none() {
        let mut s = Sheet::new();
        for _ in 0..11 {
            let p = s.cross_next_green().expect("green has room");
            let _ = s.apply(p);
        }
        assert_eq!(s.cross_next_green(), None);
        assert_eq!(s.green().crossed(), 11);
    }
}
