//! Silver: four rows — yellow, blue, green, pink — each holding the values
//! 1..=6.
//!
//! A die of value *n* marks *n* in any row where it is still open. Completing
//! a column (the value marked in all four rows) grants the bonus printed above
//! it; each row scores on its own by how many marks it holds.
//!
//! The rows are named after the *other* dice, and that is not decoration: the
//! platter chain sends a colored die to its own color's row. So the row is a
//! type ([`SilverRow`]) rather than an index, and [`Color::silver_row`] is the
//! only place the correspondence is written down.
//!
//! [`Color::silver_row`]: crate::Color::silver_row

use core::fmt;

use clever_core::{Face, Score};

use super::Area;
use crate::effect::{Effect, FreeTarget};

/// A row of the silver grid, top to bottom.
///
/// Named after the die whose platter-chain mark lands there, which is the only
/// reason a row needs a name at all.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum SilverRow {
    /// The top row — the yellow die's chain row.
    Yellow = 0,
    /// The blue die's chain row.
    Blue = 1,
    /// The green die's chain row.
    Green = 2,
    /// The bottom row — the pink die's chain row.
    Pink = 3,
}

impl SilverRow {
    /// The four rows, top to bottom.
    pub const ALL: [SilverRow; 4] = [
        SilverRow::Yellow,
        SilverRow::Blue,
        SilverRow::Green,
        SilverRow::Pink,
    ];

    /// The row at `index`, or `None` outside 0..4.
    #[must_use]
    pub const fn new(index: u8) -> Option<SilverRow> {
        match index {
            0 => Some(SilverRow::Yellow),
            1 => Some(SilverRow::Blue),
            2 => Some(SilverRow::Green),
            3 => Some(SilverRow::Pink),
            _ => None,
        }
    }

    /// The row's position, 0..4.
    #[must_use]
    pub const fn index(self) -> usize {
        self as usize
    }

    /// The printed name of the row.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            SilverRow::Yellow => "yellow",
            SilverRow::Blue => "blue",
            SilverRow::Green => "green",
            SilverRow::Pink => "pink",
        }
    }
}

impl fmt::Display for SilverRow {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// A cell of the silver grid: a row and the value printed in it.
///
/// Row-major, so the index is `row × 6 + value − 1` and a column is an
/// arithmetic progression of stride six.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct SilverCell(u8);

impl SilverCell {
    /// The cell holding `value` in `row`. Every row prints every value, so
    /// this is total.
    #[must_use]
    pub const fn at(row: SilverRow, value: Face) -> SilverCell {
        SilverCell(row as u8 * Silver::VALUES as u8 + value.get() - 1)
    }

    /// The cell at `index` in row-major order, or `None` outside the grid.
    #[must_use]
    pub const fn new(index: u8) -> Option<SilverCell> {
        if (index as usize) < Silver::CELLS {
            Some(SilverCell(index))
        } else {
            None
        }
    }

    /// The row-major index, 0..24.
    #[must_use]
    pub const fn index(self) -> usize {
        self.0 as usize
    }

    /// The row this cell sits in.
    #[must_use]
    pub const fn row(self) -> SilverRow {
        match SilverRow::new(self.0 / Silver::VALUES as u8) {
            Some(row) => row,
            // Unreachable: the constructors keep the index inside the grid.
            None => SilverRow::Yellow,
        }
    }

    /// The value printed in this cell, 1..=6 — which is also its column.
    #[must_use]
    pub const fn value(self) -> Face {
        match Face::new(self.0 % Silver::VALUES as u8 + 1) {
            Some(f) => f,
            // Unreachable: `n % 6 + 1` is in 1..=6.
            None => Face::ONE,
        }
    }

    const fn bit(self) -> u32 {
        1u32 << self.0
    }
}

/// The silver grid: one bit per marked cell, row-major.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Silver(u32);

/// The mask of one row of the grid.
const fn row_mask(row: usize) -> u32 {
    ((1u32 << Silver::VALUES) - 1) << (row * Silver::VALUES)
}

/// The mask of the column holding `value` — the same value in every row.
const fn column_mask(value: usize) -> u32 {
    let mut mask = 0u32;
    let mut row = 0;
    while row < Silver::ROWS {
        mask |= 1u32 << (row * Silver::VALUES + value - 1);
        row += 1;
    }
    mask
}

impl Silver {
    /// How many rows the grid prints.
    pub const ROWS: usize = 4;

    /// How many values each row prints.
    pub const VALUES: usize = 6;

    /// How many cells the grid has.
    pub const CELLS: usize = Self::ROWS * Self::VALUES;

    /// Cumulative points for **one row**, by how many of its six cells are
    /// marked. The area's score is this table summed over the four rows.
    const POINTS: [Score; Self::VALUES + 1] = [0, 2, 4, 7, 11, 16, 22];

    /// What completing each column grants, for the values 1..=6.
    const COLUMN_BONUS: [Effect; Self::VALUES] = [
        Effect::Plus1,
        Effect::Free(FreeTarget::Yellow),
        Effect::Fox,
        Effect::Free(FreeTarget::Blue),
        Effect::Free(FreeTarget::Green),
        Effect::Free(FreeTarget::Pink),
    ];

    const ROW: [u32; Self::ROWS] = [row_mask(0), row_mask(1), row_mask(2), row_mask(3)];

    const COLUMN: [u32; Self::VALUES] = [
        column_mask(1),
        column_mask(2),
        column_mask(3),
        column_mask(4),
        column_mask(5),
        column_mask(6),
    ];

    /// A fresh, empty grid.
    #[must_use]
    pub const fn new() -> Self {
        Silver(0)
    }

    /// The marked cells as a bitset, for saving and restoring a game.
    #[must_use]
    pub const fn bits(self) -> u32 {
        self.0
    }

    /// A grid from a saved bitset; bits outside the twenty-four cells are
    /// dropped, so no input produces an impossible state.
    #[must_use]
    pub const fn from_bits(bits: u32) -> Self {
        Silver(bits & ((1u32 << Self::CELLS) - 1))
    }

    /// Whether a cell is marked.
    #[must_use]
    pub const fn is_marked(self, cell: SilverCell) -> bool {
        self.0 & cell.bit() != 0
    }

    /// How many cells are marked, across the whole grid.
    #[must_use]
    pub const fn marked(self) -> u32 {
        self.0.count_ones()
    }

    /// How many of one row's six cells are marked — the index into that row's
    /// scoring table.
    #[must_use]
    pub fn row_marks(self, row: SilverRow) -> u32 {
        (self.0 & Self::ROW[row.index()]).count_ones()
    }

    /// Whether a column is complete: the value marked in all four rows.
    #[must_use]
    pub fn column_is_complete(self, value: Face) -> bool {
        let mask = Self::COLUMN[value.get() as usize - 1];
        self.0 & mask == mask
    }

    /// Every cell, marked or not — for rendering the printed sheet.
    pub fn cells() -> impl Iterator<Item = SilverCell> + Clone {
        (0..Self::CELLS as u8).filter_map(SilverCell::new)
    }

    /// The open cells, in row-major order — exactly what the silver `?` may
    /// mark, which is why [`Area::free_marks`] delegates to it.
    pub fn open(&self) -> impl Iterator<Item = SilverCell> + '_ {
        Silver::cells().filter(move |&c| !self.is_marked(c))
    }

    /// The rows where `value` is still open — the choice a wild or silver
    /// platter-chain mark offers, and the placements the silver die itself
    /// has.
    ///
    /// When this is empty the silver die cannot be picked at all: the rulebook
    /// grants it no wasted-pick fallback.
    pub fn open_rows(&self, value: Face) -> impl Iterator<Item = SilverCell> + '_ {
        SilverRow::ALL
            .into_iter()
            .map(move |row| SilverCell::at(row, value))
            .filter(move |&c| !self.is_marked(c))
    }

    /// The cumulative points of one row, by mark count — for rendering.
    #[must_use]
    pub const fn row_points() -> &'static [Score; Self::VALUES + 1] {
        &Self::POINTS
    }
}

impl Area for Silver {
    type Mark = SilverCell;
    type Input = Face;
    type Bonus = Option<Effect>;

    fn marks(&self, value: Face) -> impl Iterator<Item = SilverCell> + '_ {
        self.open_rows(value)
    }

    fn free_marks(&self) -> impl Iterator<Item = SilverCell> + '_ {
        self.open()
    }

    /// A cell belongs to one row and one column, and only columns carry a
    /// bonus — hence the single slot. A mark on an already-marked cell is
    /// absorbed rather than re-firing its column.
    fn apply(&mut self, cell: SilverCell) -> Option<Effect> {
        if self.is_marked(cell) {
            return None;
        }
        self.0 |= cell.bit();
        let value = cell.value();
        self.column_is_complete(value)
            .then(|| Self::COLUMN_BONUS[value.get() as usize - 1])
    }

    fn score(&self) -> Score {
        SilverRow::ALL
            .into_iter()
            .map(|row| Self::POINTS[self.row_marks(row) as usize])
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::area::harness;

    fn face(v: u8) -> Face {
        Face::new(v).expect("a die face")
    }

    fn cell(row: usize, value: u8) -> SilverCell {
        SilverCell::at(SilverRow::new(row as u8).expect("a row"), face(value))
    }

    fn bits(mask: u32) -> Vec<u8> {
        (0..Silver::CELLS as u8)
            .filter(|i| mask & (1 << i) != 0)
            .collect()
    }

    #[test]
    fn the_grid_lays_rows_out_row_major() {
        assert_eq!(Silver::CELLS, 24);
        assert_eq!(cell(0, 1).index(), 0);
        assert_eq!(cell(2, 5).index(), 16);
        assert_eq!(cell(3, 6).index(), 23);
        for c in Silver::cells() {
            assert_eq!(SilverCell::at(c.row(), c.value()), c, "{c:?}");
        }
        assert!(SilverCell::new(24).is_none());
    }

    #[test]
    fn the_group_masks_match_the_printed_layout() {
        assert_eq!(bits(Silver::ROW[0]), vec![0, 1, 2, 3, 4, 5]);
        assert_eq!(bits(Silver::ROW[3]), vec![18, 19, 20, 21, 22, 23]);
        assert_eq!(bits(Silver::COLUMN[0]), vec![0, 6, 12, 18]);
        assert_eq!(bits(Silver::COLUMN[5]), vec![5, 11, 17, 23]);
        // Every cell sits in exactly one row and one column.
        for c in Silver::cells() {
            assert_eq!(
                Silver::ROW
                    .iter()
                    .filter(|m| *m & (1 << c.index()) != 0)
                    .count(),
                1
            );
            assert_eq!(
                Silver::COLUMN
                    .iter()
                    .filter(|m| *m & (1 << c.index()) != 0)
                    .count(),
                1
            );
        }
    }

    #[test]
    fn a_value_may_be_marked_in_any_row_where_it_is_open() {
        let mut s = Silver::new();
        let rows: Vec<usize> = s.marks(face(3)).map(|c| c.index()).collect();
        assert_eq!(rows, vec![2, 8, 14, 20]);
        assert_eq!(s.apply(cell(1, 3)), None);
        let rows: Vec<usize> = s.marks(face(3)).map(|c| c.index()).collect();
        assert_eq!(rows, vec![2, 14, 20]);
    }

    #[test]
    fn completing_a_column_fires_its_bonus_exactly_once() {
        let mut s = Silver::new();
        for row in 0..3 {
            assert_eq!(s.apply(cell(row, 3)), None, "row {row} fired early");
        }
        assert_eq!(s.apply(cell(3, 3)), Some(Effect::Fox));
        assert!(s.column_is_complete(face(3)));
        // A stale mark on a marked cell is absorbed, not re-fired.
        assert_eq!(s.apply(cell(3, 3)), None);
    }

    #[test]
    fn the_column_bonuses_match_the_sheet() {
        let want = [
            Effect::Plus1,
            Effect::Free(FreeTarget::Yellow),
            Effect::Fox,
            Effect::Free(FreeTarget::Blue),
            Effect::Free(FreeTarget::Green),
            Effect::Free(FreeTarget::Pink),
        ];
        for (i, effect) in want.into_iter().enumerate() {
            let value = i as u8 + 1;
            let mut s = Silver::new();
            for row in 0..3 {
                let _ = s.apply(cell(row, value));
            }
            assert_eq!(s.apply(cell(3, value)), Some(effect), "column {value}");
        }
    }

    #[test]
    fn rows_score_independently_by_their_own_mark_count() {
        let mut s = Silver::new();
        assert_eq!(s.score(), 0);
        for value in 1..=6u8 {
            let _ = s.apply(cell(0, value));
            assert_eq!(s.score(), Silver::POINTS[value as usize], "{value} marks");
        }
        assert_eq!(s.row_marks(SilverRow::Yellow), 6);
        for value in 1..=3u8 {
            let _ = s.apply(cell(2, value));
        }
        assert_eq!(s.score(), 22 + 7);
        assert_eq!(Silver::from_bits(u32::MAX).score(), 4 * 22);
        assert_eq!(Silver::from_bits(u32::MAX).marked(), 24);
    }

    #[test]
    fn free_marks_are_every_open_cell() {
        let mut s = Silver::new();
        assert_eq!(s.free_marks().count(), 24);
        let _ = s.apply(cell(0, 1));
        let _ = s.apply(cell(3, 6));
        let open: Vec<usize> = s.free_marks().map(|c| c.index()).collect();
        assert_eq!(open.len(), 22);
        assert!(!open.contains(&0) && !open.contains(&23));
    }

    #[test]
    fn from_bits_drops_what_the_grid_cannot_hold() {
        assert_eq!(Silver::from_bits(u32::MAX).bits().count_ones(), 24);
        assert_eq!(Silver::default(), Silver::new());
    }

    #[test]
    fn survives_the_generic_area_exercises() {
        harness::saturates_in(&mut Silver::new(), &Face::ALL, Silver::CELLS);
    }
}
