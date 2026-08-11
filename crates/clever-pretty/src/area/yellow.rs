//! Yellow: a 4×4 printed grid, crossed in any order.
//!
//! Columns score, rows and the main diagonal grant bonuses, and four cells
//! come pre-printed. Group completion is a mask test and scoring is a fold
//! over four masks, so the whole area is one `u16`.

use arrayvec::ArrayVec;
use clever_core::{Face, Score};

use super::Area;
use crate::effect::{CrossTarget, Effect, WriteTarget};

/// A markable cell of the yellow grid: an index 0..16 that is *not* one of
/// the four pre-printed crosses. The constructor enforces that, so a
/// `YellowCell` always names a cell a die can reach.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct YellowCell(u8);

impl YellowCell {
    /// The cell at `index` in row-major order, or `None` for an index outside
    /// the grid or on a pre-printed cross.
    #[must_use]
    pub const fn new(index: u8) -> Option<YellowCell> {
        if index < 16 && Yellow::VALUE[index as usize] != 0 {
            Some(YellowCell(index))
        } else {
            None
        }
    }

    /// The row-major index, 0..16.
    #[must_use]
    pub const fn index(self) -> usize {
        self.0 as usize
    }

    /// The row, 0..4.
    #[must_use]
    pub const fn row(self) -> usize {
        (self.0 / 4) as usize
    }

    /// The column, 0..4.
    #[must_use]
    pub const fn column(self) -> usize {
        (self.0 % 4) as usize
    }

    /// The printed value — the face a die must show to cross this cell.
    #[must_use]
    pub const fn value(self) -> Face {
        match Face::new(Yellow::VALUE[self.0 as usize]) {
            Some(f) => f,
            // Unreachable: `new` rejects the printed cells, the only zeroes.
            None => Face::ONE,
        }
    }

    const fn bit(self) -> u16 {
        1u16 << self.0
    }
}

/// The yellow grid: one bit per crossed cell.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Yellow(u16);

/// The mask of the cells whose printed value is `0` — the pre-printed
/// crosses. Derived from the table rather than transcribed a second time.
const fn printed(value: &[u8; 16]) -> u16 {
    let mut mask = 0u16;
    let mut i = 0;
    while i < 16 {
        if value[i] == 0 {
            mask |= 1u16 << i;
        }
        i += 1;
    }
    mask
}

/// The mask of row `r` of a 4×4 row-major grid.
const fn row(r: u16) -> u16 {
    0x000F << (4 * r)
}

/// The mask of column `c` of a 4×4 row-major grid.
const fn column(c: u16) -> u16 {
    0x1111 << c
}

/// The mask of the main diagonal of a 4×4 row-major grid.
const fn diagonal() -> u16 {
    let mut mask = 0u16;
    let mut i = 0;
    while i < 4 {
        mask |= 1u16 << (i * 5);
        i += 1;
    }
    mask
}

impl Yellow {
    /// The printed value of every cell in row-major order; `0` marks a
    /// pre-printed cross, which is why [`Face`] never appears in the table.
    pub(crate) const VALUE: [u8; 16] = [3, 6, 5, 0, 2, 1, 0, 5, 1, 0, 2, 4, 0, 3, 4, 6];

    /// The four cells that start crossed.
    const PRINTED: u16 = printed(&Self::VALUE);

    const ROW: [u16; 4] = [row(0), row(1), row(2), row(3)];
    const COL: [u16; 4] = [column(0), column(1), column(2), column(3)];
    const DIAG: u16 = diagonal();

    /// What completing each row grants, top to bottom.
    const ROW_BONUS: [Effect; 4] = [
        Effect::CrossAny(CrossTarget::Blue),
        Effect::WriteNext(WriteTarget::Orange, Face::FOUR),
        Effect::CrossNextGreen,
        Effect::Fox,
    ];

    /// What completing each column is worth, left to right.
    const COL_POINTS: [Score; 4] = [10, 14, 16, 20];

    /// A fresh grid: the four printed crosses and nothing else.
    #[must_use]
    pub const fn new() -> Self {
        Yellow(Self::PRINTED)
    }

    /// The crossed cells as a bitset, for saving and restoring a game.
    #[must_use]
    pub const fn bits(self) -> u16 {
        self.0
    }

    /// A grid from a saved bitset. The sixteen cells fill the `u16` exactly,
    /// and the printed crosses are re-applied, so no input produces an
    /// impossible state.
    #[must_use]
    pub const fn from_bits(bits: u16) -> Self {
        Yellow(bits | Self::PRINTED)
    }

    /// Whether a cell is crossed.
    #[must_use]
    pub const fn is_crossed(self, cell: YellowCell) -> bool {
        self.0 & cell.bit() != 0
    }

    /// How many cells are crossed, printed ones included.
    #[must_use]
    pub const fn crossed(self) -> u32 {
        self.0.count_ones()
    }

    /// Every cell, crossed or not — for rendering the printed sheet.
    pub fn cells() -> impl Iterator<Item = YellowCell> + Clone {
        (0..16u8).filter_map(YellowCell::new)
    }

    /// The open cells, in index order. This is exactly what a yellow `X`
    /// bonus may cross, which is why [`Area::free_marks`] delegates to it.
    pub fn open(&self) -> impl Iterator<Item = YellowCell> + '_ {
        Yellow::cells().filter(move |&c| !self.is_crossed(c))
    }
}

impl Default for Yellow {
    fn default() -> Self {
        Yellow::new()
    }
}

impl Area for Yellow {
    type Mark = YellowCell;
    type Input = Face;
    type Bonus = ArrayVec<Effect, 2>;

    fn marks(&self, face: Face) -> impl Iterator<Item = YellowCell> + '_ {
        self.open().filter(move |c| c.value() == face)
    }

    fn free_marks(&self) -> impl Iterator<Item = YellowCell> + '_ {
        self.open()
    }

    /// A cell belongs to one row and one column-or-diagonal, and only rows and
    /// the diagonal carry bonuses — hence the two-slot bound. Rows fire before
    /// the diagonal, the order the sheet lists them in.
    fn apply(&mut self, cell: YellowCell) -> ArrayVec<Effect, 2> {
        self.0 |= cell.bit();
        let mut fired = ArrayVec::new();
        let mask = Self::ROW[cell.row()];
        if self.0 & mask == mask {
            fired.push(Self::ROW_BONUS[cell.row()]);
        }
        if cell.bit() & Self::DIAG != 0 && self.0 & Self::DIAG == Self::DIAG {
            fired.push(Effect::Plus1);
        }
        fired
    }

    fn score(&self) -> Score {
        Self::COL
            .iter()
            .zip(Self::COL_POINTS)
            .filter(|(&mask, _)| self.0 & mask == mask)
            .map(|(_, points)| points)
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::area::harness;

    /// The printed sheet, transcribed a second time — independently of
    /// `VALUE` — as `null` for a pre-printed cross.
    const SHEET: [Option<u8>; 16] = [
        Some(3),
        Some(6),
        Some(5),
        None,
        Some(2),
        Some(1),
        None,
        Some(5),
        Some(1),
        None,
        Some(2),
        Some(4),
        None,
        Some(3),
        Some(4),
        Some(6),
    ];

    fn bits(mask: u16) -> Vec<u8> {
        (0..16u8).filter(|i| mask & (1 << i) != 0).collect()
    }

    #[test]
    fn the_value_table_matches_the_printed_sheet() {
        for (i, want) in SHEET.into_iter().enumerate() {
            assert_eq!(Yellow::VALUE[i], want.unwrap_or(0), "cell {i}");
        }
        // Every value appears exactly twice — the sheet's own invariant.
        for v in 1..=6u8 {
            assert_eq!(
                Yellow::VALUE.iter().filter(|&&x| x == v).count(),
                2,
                "value {v}"
            );
        }
    }

    /// The bug this whole test module exists for: `PRINTED` written by hand
    /// once dropped cell 9.
    #[test]
    fn printed_is_exactly_the_zero_valued_cells() {
        assert_eq!(bits(Yellow::PRINTED), vec![3, 6, 9, 12]);
        assert_eq!(Yellow::PRINTED.count_ones(), 4);
        assert_eq!(Yellow::PRINTED, 0b0001_0010_0100_1000);
        assert_eq!(Yellow::new().bits(), Yellow::PRINTED);
        assert_eq!(Yellow::new().crossed(), 4);
        assert_eq!(Yellow::new().open().count(), 12);
    }

    #[test]
    fn the_group_masks_match_the_printed_layout() {
        assert_eq!(bits(Yellow::ROW[0]), vec![0, 1, 2, 3]);
        assert_eq!(bits(Yellow::ROW[1]), vec![4, 5, 6, 7]);
        assert_eq!(bits(Yellow::ROW[2]), vec![8, 9, 10, 11]);
        assert_eq!(bits(Yellow::ROW[3]), vec![12, 13, 14, 15]);
        assert_eq!(bits(Yellow::COL[0]), vec![0, 4, 8, 12]);
        assert_eq!(bits(Yellow::COL[1]), vec![1, 5, 9, 13]);
        assert_eq!(bits(Yellow::COL[2]), vec![2, 6, 10, 14]);
        assert_eq!(bits(Yellow::COL[3]), vec![3, 7, 11, 15]);
        assert_eq!(bits(Yellow::DIAG), vec![0, 5, 10, 15]);
        assert_eq!(Yellow::DIAG, 0x8421);
    }

    #[test]
    fn cells_know_their_row_column_and_value() {
        let c = YellowCell::new(11).unwrap();
        assert_eq!((c.row(), c.column()), (2, 3));
        assert_eq!(c.value(), Face::FOUR);
        // The printed crosses are not cells a die can reach.
        for printed in [3u8, 6, 9, 12] {
            assert!(YellowCell::new(printed).is_none());
        }
        assert!(YellowCell::new(16).is_none());
        assert_eq!(Yellow::cells().count(), 12);
    }

    #[test]
    fn a_die_crosses_either_open_cell_of_its_value() {
        let y = Yellow::new();
        // 4 sits at cells 11 and 14.
        let cells: Vec<usize> = y.marks(Face::FOUR).map(YellowCell::index).collect();
        assert_eq!(cells, vec![11, 14]);
        // 5 sits at 2 and 7; 1 at 5 and 8.
        assert_eq!(y.marks(Face::FIVE).count(), 2);
        assert_eq!(y.marks(Face::ONE).count(), 2);
    }

    #[test]
    fn a_crossed_cell_is_no_longer_offered() {
        let mut y = Yellow::new();
        let c = y.marks(Face::FOUR).next().unwrap();
        assert!(y.apply(c).is_empty());
        assert!(y.is_crossed(c));
        assert_eq!(y.marks(Face::FOUR).count(), 1);
        assert_eq!(y.open().count(), 11);
    }

    #[test]
    fn rows_fire_their_printed_bonus() {
        let want = [
            Effect::CrossAny(CrossTarget::Blue),
            Effect::WriteNext(WriteTarget::Orange, Face::FOUR),
            Effect::CrossNextGreen,
            Effect::Fox,
        ];
        for r in 0..4 {
            let mut y = Yellow::new();
            let cells: Vec<YellowCell> = (0..4u8)
                .filter_map(|c| YellowCell::new(r * 4 + c))
                .collect();
            let (last, rest) = cells.split_last().unwrap();
            for c in rest {
                assert!(y.apply(*c).is_empty(), "row {r} fired early");
            }
            let fired: Vec<Effect> = y.apply(*last).into_iter().collect();
            assert_eq!(fired.first(), Some(&want[r as usize]), "row {r}");
        }
    }

    #[test]
    fn the_diagonal_grants_a_plus1_after_its_row() {
        let mut y = Yellow::new();
        for i in [0u8, 5, 10] {
            let _ = y.apply(YellowCell::new(i).unwrap());
        }
        // Cell 15 completes both row 3 (fox) and the diagonal (+1), in that
        // order.
        for i in [13u8, 14] {
            let _ = y.apply(YellowCell::new(i).unwrap());
        }
        let fired: Vec<Effect> = y.apply(YellowCell::new(15).unwrap()).into_iter().collect();
        assert_eq!(fired, vec![Effect::Fox, Effect::Plus1]);
    }

    #[test]
    fn columns_score_when_complete() {
        let mut y = Yellow::new();
        assert_eq!(y.score(), 0);
        // Column 0 is cells 0, 4, 8 and the printed 12.
        for i in [0u8, 4, 8] {
            let _ = y.apply(YellowCell::new(i).unwrap());
        }
        assert_eq!(y.score(), 10);
        for i in [1u8, 5, 13] {
            let _ = y.apply(YellowCell::new(i).unwrap());
        }
        assert_eq!(y.score(), 10 + 14);
        let full = Yellow::from_bits(u16::MAX);
        assert_eq!(full.score(), 10 + 14 + 16 + 20);
        assert_eq!(full.open().count(), 0);
    }

    #[test]
    fn from_bits_cannot_erase_the_printed_crosses() {
        assert_eq!(Yellow::from_bits(0).bits(), Yellow::PRINTED);
        assert_eq!(Yellow::default(), Yellow::new());
    }

    #[test]
    fn survives_the_generic_area_exercises() {
        // Twelve open cells: the sixteen printed ones less the four crosses.
        harness::saturates_in(&mut Yellow::new(), &Face::ALL, 12);
    }
}
