//! Scoring: the fox rule and the rating lookup, both shared; the areas and
//! the rating table itself, both per game.

use arrayvec::ArrayVec;

use crate::vocab::Score;

/// The largest number of scoring areas a sheet has. Both games have five.
pub const MAX_AREAS: usize = 6;

/// A sheet's areas with their per-area scores.
pub type Areas = ArrayVec<(&'static str, Score), MAX_AREAS>;

/// A finished game's score, area by area.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Breakdown {
    /// Each area's name and score, in the game's own order.
    pub areas: Areas,
    /// The lowest area score — what one fox is worth.
    pub min_area: Score,
    /// How many foxes were collected.
    pub foxes: u8,
    /// `foxes × min_area`.
    pub fox_points: Score,
    /// `sum(areas) + fox_points`.
    pub total: Score,
}

impl Breakdown {
    /// Assemble a breakdown from the areas' scores and the fox count.
    ///
    /// A fox is worth the lowest area's score, in both games — including when
    /// that is zero (an untouched area sinks every fox) and when it is
    /// *negative*, which *Twice as Clever*'s subtraction pairs can produce. In
    /// that case the foxes subtract; the rulebook only spells out the zero
    /// case and the literal minimum is the straightforward reading.
    ///
    /// With no areas at all the minimum is 0, so foxes are worth nothing.
    #[must_use]
    pub fn assemble(areas: Areas, foxes: u8) -> Self {
        let sum: Score = areas.iter().map(|&(_, s)| s).sum();
        let min_area = areas.iter().map(|&(_, s)| s).min().unwrap_or(0);
        let fox_points = Score::from(foxes).saturating_mul(min_area);
        Breakdown {
            areas,
            min_area,
            foxes,
            fox_points,
            total: sum.saturating_add(fox_points),
        }
    }

    /// One area's score by name, for tests and UIs.
    #[must_use]
    pub fn area(&self, name: &str) -> Option<Score> {
        self.areas
            .iter()
            .find(|&&(n, _)| n == name)
            .map(|&(_, s)| s)
    }
}

/// One row of a game's solo rating table: the lowest score that earns
/// `label`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rating {
    /// The lowest total that earns this label.
    pub min: Score,
    /// What the rulebook calls a player who scores it.
    pub label: &'static str,
}

impl Rating {
    /// A rating row.
    #[must_use]
    pub const fn new(min: Score, label: &'static str) -> Self {
        Rating { min, label }
    }
}

/// The label a total earns, from a table ordered from the highest `min` down.
///
/// The first row the score reaches wins; a table whose last row is
/// `Score::MIN` always answers. An exhausted table answers `""`.
#[must_use]
pub fn rate(table: &[Rating], score: Score) -> &'static str {
    table
        .iter()
        .find(|r| score >= r.min)
        .map_or("", |r| r.label)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn areas(scores: &[(&'static str, Score)]) -> Areas {
        scores.iter().copied().collect()
    }

    #[test]
    fn foxes_are_worth_the_lowest_area() {
        let b = Breakdown::assemble(
            areas(&[("yellow", 30), ("blue", 22), ("green", 15), ("orange", 40)]),
            3,
        );
        assert_eq!(b.min_area, 15);
        assert_eq!(b.fox_points, 45);
        assert_eq!(b.total, 30 + 22 + 15 + 40 + 45);
        assert_eq!(b.area("blue"), Some(22));
        assert_eq!(b.area("purple"), None);
    }

    #[test]
    fn an_empty_area_sinks_every_fox() {
        let b = Breakdown::assemble(areas(&[("a", 50), ("b", 0)]), 6);
        assert_eq!(b.min_area, 0);
        assert_eq!(b.fox_points, 0);
        assert_eq!(b.total, 50);
    }

    #[test]
    fn a_negative_area_makes_foxes_subtract() {
        // Twice's green scores subtraction pairs and can go below zero; the
        // fox multiplier follows it down.
        let b = Breakdown::assemble(areas(&[("silver", 40), ("green", -6)]), 2);
        assert_eq!(b.min_area, -6);
        assert_eq!(b.fox_points, -12);
        assert_eq!(b.total, 40 - 6 - 12);
    }

    #[test]
    fn no_foxes_no_fox_points() {
        let b = Breakdown::assemble(areas(&[("a", 10), ("b", -4)]), 0);
        assert_eq!(b.fox_points, 0);
        assert_eq!(b.total, 6);
    }

    #[test]
    fn an_empty_sheet_scores_zero() {
        let b = Breakdown::assemble(Areas::new(), 4);
        assert_eq!(b.min_area, 0);
        assert_eq!(b.total, 0);
    }

    const TABLE: [Rating; 3] = [
        Rating::new(281, "You're so clever!"),
        Rating::new(140, "Not bad"),
        Rating::new(Score::MIN, "Try harder!"),
    ];

    #[test]
    fn rate_takes_the_first_row_the_score_reaches() {
        assert_eq!(rate(&TABLE, 300), "You're so clever!");
        assert_eq!(rate(&TABLE, 281), "You're so clever!");
        assert_eq!(rate(&TABLE, 280), "Not bad");
        assert_eq!(rate(&TABLE, 139), "Try harder!");
        assert_eq!(rate(&TABLE, -50), "Try harder!");
    }

    #[test]
    fn rate_of_an_unreachable_table_is_empty() {
        assert_eq!(rate(&[Rating::new(10, "x")], 9), "");
        assert_eq!(rate(&[], 100), "");
    }
}
