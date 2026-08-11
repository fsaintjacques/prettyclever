//! Blue: eleven cells holding the values 2..=12, crossed in any order.
//!
//! The value marked is **always blue + white**, whichever of the two dice is
//! spent — so the area's input is [`Pips`], not [`Face`](clever_core::Face).
//!
//! Blue and yellow are both "cross a grid" areas and they share no code:
//! yellow scores completed columns, blue scores a table indexed by population
//! count. In the prototype that difference is a configuration union both areas
//! carry and one of them ignores.

use arrayvec::ArrayVec;
use clever_core::{Face, Pips, Score};

use super::Area;
use crate::effect::{CrossTarget, Effect, WriteTarget};

/// A cell of the blue grid: the value 2..=12 it holds, as an index 0..11.
///
/// The printed sheet has a hole at the top left, so the layout is
/// `· 2 3 4 / 5 6 7 8 / 9 10 11 12`; the hole is a rendering fact and not a
/// cell, which is why eleven cells fit in eleven bits.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct BlueCell(u8);

impl BlueCell {
    /// The cell holding `pips`. Every sum 2..=12 has one, so this is total.
    #[must_use]
    pub const fn of(pips: Pips) -> BlueCell {
        BlueCell(pips.get() - 2)
    }

    /// The cell at `index`, or `None` outside 0..11.
    #[must_use]
    pub const fn new(index: u8) -> Option<BlueCell> {
        if index < 11 {
            Some(BlueCell(index))
        } else {
            None
        }
    }

    /// The index, 0..11.
    #[must_use]
    pub const fn index(self) -> usize {
        self.0 as usize
    }

    /// The printed value, 2..=12.
    #[must_use]
    pub const fn value(self) -> Pips {
        match Pips::new(self.0 + 2) {
            Some(p) => p,
            // Unreachable: `new` and `of` keep the index inside 0..11.
            None => Pips::MIN,
        }
    }

    const fn bit(self) -> u16 {
        1u16 << self.0
    }
}

/// The blue grid: one bit per crossed cell, bit `n` holding the value `n + 2`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Blue(u16);

/// A mask over cells named by the values they hold.
const fn cells(values: &[u8]) -> u16 {
    let mut mask = 0u16;
    let mut i = 0;
    while i < values.len() {
        mask |= 1u16 << (values[i] - 2);
        i += 1;
    }
    mask
}

impl Blue {
    /// How many cells the area has.
    pub const CELLS: usize = 11;

    /// Points by number of crossed cells.
    const TABLE: [Score; 12] = [0, 1, 2, 4, 7, 11, 16, 22, 29, 37, 46, 56];

    /// The three printed rows: `2 3 4`, `5 6 7 8`, `9 10 11 12`.
    const ROW: [u16; 3] = [
        cells(&[2, 3, 4]),
        cells(&[5, 6, 7, 8]),
        cells(&[9, 10, 11, 12]),
    ];

    /// What completing each row grants, top to bottom.
    const ROW_BONUS: [Effect; 3] = [
        Effect::WriteNext(WriteTarget::Orange, Face::FIVE),
        Effect::CrossAny(CrossTarget::Yellow),
        Effect::Fox,
    ];

    /// The four printed columns. The hole at the top left shortens the first
    /// one to two cells.
    const COL: [u16; 4] = [
        cells(&[5, 9]),
        cells(&[2, 6, 10]),
        cells(&[3, 7, 11]),
        cells(&[4, 8, 12]),
    ];

    /// What completing each column grants, left to right.
    const COL_BONUS: [Effect; 4] = [
        Effect::Reroll,
        Effect::CrossNextGreen,
        Effect::WriteNext(WriteTarget::Purple, Face::SIX),
        Effect::Plus1,
    ];

    /// A fresh, empty grid.
    #[must_use]
    pub const fn new() -> Self {
        Blue(0)
    }

    /// The crossed cells as a bitset, for saving and restoring a game.
    #[must_use]
    pub const fn bits(self) -> u16 {
        self.0
    }

    /// A grid from a saved bitset; bits outside the eleven cells are dropped.
    #[must_use]
    pub const fn from_bits(bits: u16) -> Self {
        Blue(bits & 0x07FF)
    }

    /// Whether a cell is crossed.
    #[must_use]
    pub const fn is_crossed(self, cell: BlueCell) -> bool {
        self.0 & cell.bit() != 0
    }

    /// How many cells are crossed — the index into the scoring table.
    #[must_use]
    pub const fn crossed(self) -> u32 {
        self.0.count_ones()
    }

    /// Every cell, crossed or not — for rendering the printed sheet.
    pub fn cells() -> impl Iterator<Item = BlueCell> + Clone {
        (0..11u8).filter_map(BlueCell::new)
    }

    /// The cell a sum would cross, if it is still open.
    #[must_use]
    pub fn open(&self, pips: Pips) -> Option<BlueCell> {
        let cell = BlueCell::of(pips);
        (!self.is_crossed(cell)).then_some(cell)
    }
}

impl Area for Blue {
    type Mark = BlueCell;
    type Input = Pips;
    type Bonus = ArrayVec<Effect, 2>;

    fn marks(&self, pips: Pips) -> impl Iterator<Item = BlueCell> + '_ {
        self.open(pips).into_iter()
    }

    fn free_marks(&self) -> impl Iterator<Item = BlueCell> + '_ {
        Blue::cells().filter(move |&c| !self.is_crossed(c))
    }

    /// A cell belongs to one row and one column, so at most two bonuses fire —
    /// the row first, the order the sheet lists them in.
    fn apply(&mut self, cell: BlueCell) -> ArrayVec<Effect, 2> {
        self.0 |= cell.bit();
        let mut fired = ArrayVec::new();
        for (mask, effect) in Self::ROW.iter().zip(Self::ROW_BONUS) {
            if cell.bit() & mask != 0 && self.0 & mask == *mask {
                fired.push(effect);
            }
        }
        for (mask, effect) in Self::COL.iter().zip(Self::COL_BONUS) {
            if cell.bit() & mask != 0 && self.0 & mask == *mask {
                fired.push(effect);
            }
        }
        fired
    }

    fn score(&self) -> Score {
        Self::TABLE[self.crossed() as usize]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::area::harness;

    fn bits(mask: u16) -> Vec<u8> {
        (0..11u8)
            .filter(|i| mask & (1 << i) != 0)
            .map(|i| i + 2)
            .collect()
    }

    fn pips(v: u8) -> Pips {
        Pips::new(v).unwrap()
    }

    #[test]
    fn the_group_masks_match_the_printed_layout() {
        assert_eq!(bits(Blue::ROW[0]), vec![2, 3, 4]);
        assert_eq!(bits(Blue::ROW[1]), vec![5, 6, 7, 8]);
        assert_eq!(bits(Blue::ROW[2]), vec![9, 10, 11, 12]);
        assert_eq!(bits(Blue::COL[0]), vec![5, 9]);
        assert_eq!(bits(Blue::COL[1]), vec![2, 6, 10]);
        assert_eq!(bits(Blue::COL[2]), vec![3, 7, 11]);
        assert_eq!(bits(Blue::COL[3]), vec![4, 8, 12]);
        // Every cell is in exactly one row and one column.
        for cell in Blue::cells() {
            assert_eq!(
                Blue::ROW.iter().filter(|m| *m & cell.bit() != 0).count(),
                1,
                "{:?}",
                cell.value()
            );
            assert_eq!(
                Blue::COL.iter().filter(|m| *m & cell.bit() != 0).count(),
                1,
                "{:?}",
                cell.value()
            );
        }
    }

    #[test]
    fn the_scoring_table_matches_the_rulebook() {
        assert_eq!(Blue::TABLE, [0, 1, 2, 4, 7, 11, 16, 22, 29, 37, 46, 56]);
        let mut b = Blue::new();
        assert_eq!(b.score(), 0);
        for v in 2..=6u8 {
            let _ = b.apply(BlueCell::of(pips(v)));
        }
        assert_eq!(b.crossed(), 5);
        assert_eq!(b.score(), 11);
        assert_eq!(Blue::from_bits(u16::MAX).score(), 56);
    }

    #[test]
    fn a_cell_holds_the_sum_of_its_index() {
        for v in 2..=12u8 {
            let c = BlueCell::of(pips(v));
            assert_eq!(c.value(), pips(v));
            assert_eq!(c.index(), (v - 2) as usize);
        }
        assert!(BlueCell::new(11).is_none());
        assert_eq!(Blue::cells().count(), Blue::CELLS);
    }

    #[test]
    fn a_sum_marks_one_cell_and_only_while_open() {
        let mut b = Blue::new();
        let cell = b.marks(pips(7)).next().unwrap();
        assert_eq!(cell.value(), pips(7));
        let _ = b.apply(cell);
        assert_eq!(b.marks(pips(7)).count(), 0);
        assert_eq!(b.open(pips(7)), None);
        assert_eq!(b.free_marks().count(), 10);
    }

    #[test]
    fn rows_fire_their_printed_bonus() {
        let cases: [(&[u8], Effect); 3] = [
            (
                &[2, 3, 4],
                Effect::WriteNext(WriteTarget::Orange, Face::FIVE),
            ),
            (&[5, 6, 7, 8], Effect::CrossAny(CrossTarget::Yellow)),
            (&[9, 10, 11, 12], Effect::Fox),
        ];
        for (values, want) in cases {
            let mut b = Blue::new();
            let (last, rest) = values.split_last().unwrap();
            for v in rest {
                let fired: Vec<Effect> = b.apply(BlueCell::of(pips(*v))).into_iter().collect();
                assert!(!fired.contains(&want), "row fired early");
            }
            let fired: Vec<Effect> = b.apply(BlueCell::of(pips(*last))).into_iter().collect();
            assert!(fired.contains(&want), "{values:?} → {fired:?}");
        }
    }

    #[test]
    fn columns_fire_their_printed_bonus() {
        let cases: [(&[u8], Effect); 4] = [
            (&[5, 9], Effect::Reroll),
            (&[2, 6, 10], Effect::CrossNextGreen),
            (
                &[3, 7, 11],
                Effect::WriteNext(WriteTarget::Purple, Face::SIX),
            ),
            (&[4, 8, 12], Effect::Plus1),
        ];
        for (values, want) in cases {
            let mut b = Blue::new();
            let (last, rest) = values.split_last().unwrap();
            for v in rest {
                let _ = b.apply(BlueCell::of(pips(*v)));
            }
            let fired: Vec<Effect> = b.apply(BlueCell::of(pips(*last))).into_iter().collect();
            assert!(fired.contains(&want), "{values:?} → {fired:?}");
        }
    }

    #[test]
    fn a_cell_can_complete_a_row_and_a_column_at_once() {
        // Cell 4 closes row 0 (2 3 4) and column 3 (4 8 12), row first.
        let mut b = Blue::new();
        for v in [2u8, 3, 8, 12] {
            let _ = b.apply(BlueCell::of(pips(v)));
        }
        let fired: Vec<Effect> = b.apply(BlueCell::of(pips(4))).into_iter().collect();
        assert_eq!(
            fired,
            vec![
                Effect::WriteNext(WriteTarget::Orange, Face::FIVE),
                Effect::Plus1
            ]
        );
    }

    #[test]
    fn survives_the_generic_area_exercises() {
        let all: Vec<Pips> = Pips::all().collect();
        harness::saturates_in(&mut Blue::new(), &all, Blue::CELLS);
    }
}
