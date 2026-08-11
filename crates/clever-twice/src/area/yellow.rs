//! Yellow: ten two-state cells on a staggered four-column lattice.
//!
//! A die of value *n* either **circles** an uncircled cell showing *n* or
//! **crosses** a cell showing *n* that is already circled. Rows and columns
//! fire their bonus once every cell in them is at least circled — crossing is
//! not required — and only crosses score.
//!
//! Two facts drive the representation.
//!
//! **The state is two bitsets, not a state per cell.** `circled` and `crossed`
//! with the invariant `crossed ⊆ circled`: group completion is then one mask
//! test against `circled` and the score is a population count of `crossed`.
//!
//! **The mark is relative.** A [`LatticeCell`] names a cell and nothing else;
//! [`Area::apply`] advances it one state. A mark enumerated before another
//! touched the same cell therefore cannot write a stale absolute value — the
//! prototype stores `cells[i] + 1` computed at enumeration time and is safe
//! only because it applies immediately.
//!
//! The lattice's holes are a fact about the printed sheet, so the layout is
//! transcribed once, in full, and the ten real cells, their rows and their
//! columns are derived from it.

use arrayvec::ArrayVec;
use clever_core::{Face, Score};

use super::Area;
use crate::effect::{Effect, FreeTarget};

/// How wide the printed lattice is.
const COLUMNS: usize = 4;

/// How tall the printed lattice is.
const ROWS: usize = 5;

/// The printed value at every position of the staggered layout, row-major;
/// `0` is a hole, where the sheet prints no cell at all.
const LAYOUT: [u8; ROWS * COLUMNS] = [
    0, 3, 0, 6, //
    1, 0, 2, 0, //
    0, 4, 0, 3, //
    2, 0, 5, 0, //
    0, 5, 0, 4, //
];

/// The layout position of each real cell, in reading order. Derived from
/// [`LAYOUT`], so the holes are transcribed once.
const fn positions() -> [u8; Yellow::CELLS] {
    let mut out = [0u8; Yellow::CELLS];
    let (mut i, mut n) = (0, 0);
    while i < LAYOUT.len() {
        if LAYOUT[i] != 0 {
            out[n] = i as u8;
            n += 1;
        }
        i += 1;
    }
    assert!(n == Yellow::CELLS, "the lattice does not hold ten cells");
    out
}

/// A markable cell of the lattice: an index 0..10 in reading order.
///
/// The mark is the cell alone — what it *does* depends on the cell's state
/// when it is applied, which is what makes it safe to enumerate one mark and
/// apply it after another has touched the same cell.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct LatticeCell(u8);

impl LatticeCell {
    /// The cell at `index` in reading order, or `None` outside 0..10.
    #[must_use]
    pub const fn new(index: u8) -> Option<LatticeCell> {
        if (index as usize) < Yellow::CELLS {
            Some(LatticeCell(index))
        } else {
            None
        }
    }

    /// The cell at `position` in the printed layout, or `None` for a hole or
    /// an out-of-range position.
    #[must_use]
    pub const fn at(position: u8) -> Option<LatticeCell> {
        let mut i = 0;
        while i < Yellow::CELLS {
            if Yellow::POSITION[i] == position {
                return Some(LatticeCell(i as u8));
            }
            i += 1;
        }
        None
    }

    /// The index in reading order, 0..10.
    #[must_use]
    pub const fn index(self) -> usize {
        self.0 as usize
    }

    /// The cell's position in the printed layout, 0..20.
    #[must_use]
    pub const fn position(self) -> usize {
        Yellow::POSITION[self.0 as usize] as usize
    }

    /// The printed row, 0..5.
    #[must_use]
    pub const fn row(self) -> usize {
        self.position() / COLUMNS
    }

    /// The printed column, 0..4.
    #[must_use]
    pub const fn column(self) -> usize {
        self.position() % COLUMNS
    }

    /// The printed value — the face a die must show to mark this cell.
    #[must_use]
    pub const fn value(self) -> Face {
        match Face::new(LAYOUT[self.position()]) {
            Some(f) => f,
            // Unreachable: a real cell's layout entry is never a hole.
            None => Face::ONE,
        }
    }

    const fn bit(self) -> u16 {
        1u16 << self.0
    }
}

/// What a lattice cell holds. Marking advances it one step and stops.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Default)]
pub enum LatticeState {
    /// Untouched. A matching die circles it.
    #[default]
    Empty,
    /// Circled: it counts towards its row and column, and scores nothing.
    Circled,
    /// Crossed: it scores, and nothing more can be done to it.
    Crossed,
}

/// The yellow lattice: which cells are circled, and which of those are
/// crossed.
///
/// The invariant `crossed ⊆ circled` is maintained by [`Area::apply`] being
/// the only mutator: a cell is circled before it can be crossed.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Yellow {
    circled: u16,
    crossed: u16,
}

/// The mask of the real cells of one printed row.
const fn row_mask(row: usize) -> u16 {
    let mut mask = 0u16;
    let mut i = 0;
    while i < Yellow::CELLS {
        if Yellow::POSITION[i] as usize / COLUMNS == row {
            mask |= 1u16 << i;
        }
        i += 1;
    }
    mask
}

/// The mask of the real cells of one printed column.
const fn column_mask(column: usize) -> u16 {
    let mut mask = 0u16;
    let mut i = 0;
    while i < Yellow::CELLS {
        if Yellow::POSITION[i] as usize % COLUMNS == column {
            mask |= 1u16 << i;
        }
        i += 1;
    }
    mask
}

impl Yellow {
    /// How many real cells the lattice has.
    pub const CELLS: usize = 10;

    /// The layout position of each cell, in reading order.
    const POSITION: [u8; Self::CELLS] = positions();

    /// Cumulative points by **crossed** count. Circles score nothing.
    const POINTS: [Score; Self::CELLS + 1] = [0, 3, 10, 21, 36, 55, 75, 96, 118, 141, 165];

    const ROW: [u16; ROWS] = [
        row_mask(0),
        row_mask(1),
        row_mask(2),
        row_mask(3),
        row_mask(4),
    ];

    const COLUMN: [u16; COLUMNS] = [
        column_mask(0),
        column_mask(1),
        column_mask(2),
        column_mask(3),
    ];

    /// What completing each row grants, top to bottom.
    const ROW_BONUS: [Effect; ROWS] = [
        Effect::Free(FreeTarget::Blue),
        Effect::Return,
        Effect::Free(FreeTarget::Yellow),
        Effect::Free(FreeTarget::Green),
        Effect::Free(FreeTarget::Pink),
    ];

    /// What completing each column grants, left to right.
    const COLUMN_BONUS: [Effect; COLUMNS] = [
        Effect::Reroll,
        Effect::Plus1,
        Effect::Free(FreeTarget::Silver),
        Effect::Fox,
    ];

    /// A fresh, empty lattice.
    #[must_use]
    pub const fn new() -> Self {
        Yellow {
            circled: 0,
            crossed: 0,
        }
    }

    /// The two bitsets, for saving a game: circled first, then crossed.
    #[must_use]
    pub const fn bits(self) -> (u16, u16) {
        (self.circled, self.crossed)
    }

    /// A lattice from saved bitsets. Bits outside the ten cells are dropped
    /// and `crossed` is narrowed to `circled`, so no input can break the
    /// invariant.
    #[must_use]
    pub const fn from_bits(circled: u16, crossed: u16) -> Self {
        let all = (1u16 << Self::CELLS) - 1;
        let crossed = crossed & all;
        Yellow {
            circled: (circled & all) | crossed,
            crossed,
        }
    }

    /// What a cell holds.
    #[must_use]
    pub const fn state(self, cell: LatticeCell) -> LatticeState {
        if self.crossed & cell.bit() != 0 {
            LatticeState::Crossed
        } else if self.circled & cell.bit() != 0 {
            LatticeState::Circled
        } else {
            LatticeState::Empty
        }
    }

    /// What a cell would hold after one more mark — `None` when it is already
    /// crossed and no mark is legal.
    ///
    /// The action layer needs this to say "circle" or "cross" in a
    /// description, and it is the same lookup [`Area::apply`] performs.
    #[must_use]
    pub const fn next_state(self, cell: LatticeCell) -> Option<LatticeState> {
        match self.state(cell) {
            LatticeState::Empty => Some(LatticeState::Circled),
            LatticeState::Circled => Some(LatticeState::Crossed),
            LatticeState::Crossed => None,
        }
    }

    /// How many cells are crossed — the index into the scoring table.
    #[must_use]
    pub const fn crossed(self) -> u32 {
        self.crossed.count_ones()
    }

    /// How many cells are at least circled.
    #[must_use]
    pub const fn circled(self) -> u32 {
        self.circled.count_ones()
    }

    /// Every cell, in reading order — for rendering the printed sheet.
    pub fn cells() -> impl Iterator<Item = LatticeCell> + Clone {
        (0..Self::CELLS as u8).filter_map(LatticeCell::new)
    }

    /// The cells a mark can still advance: everything not yet crossed. This is
    /// exactly what the yellow `?` may take.
    pub fn markable(&self) -> impl Iterator<Item = LatticeCell> + '_ {
        Yellow::cells().filter(move |&c| self.state(c) != LatticeState::Crossed)
    }
}

impl Area for Yellow {
    /// The cell alone. What the mark *writes* is decided when it is applied,
    /// which is what makes the mark safe to enumerate ahead of time.
    type Mark = LatticeCell;
    type Input = Face;
    type Bonus = ArrayVec<Effect, 2>;

    fn marks(&self, value: Face) -> impl Iterator<Item = LatticeCell> + '_ {
        self.markable().filter(move |c| c.value() == value)
    }

    fn free_marks(&self) -> impl Iterator<Item = LatticeCell> + '_ {
        self.markable()
    }

    /// Advance the cell one state, and report what a *fresh circle* completed.
    ///
    /// Only a circle can fire a group — crossing a cell that already counted
    /// changes no group's status — so a cross returns nothing and a stale mark
    /// on a crossed cell is absorbed. A cell belongs to one row and one
    /// column, hence the two-slot bound, and rows fire first.
    fn apply(&mut self, cell: LatticeCell) -> ArrayVec<Effect, 2> {
        let mut fired = ArrayVec::new();
        match self.state(cell) {
            LatticeState::Crossed => return fired,
            LatticeState::Circled => {
                self.crossed |= cell.bit();
                return fired;
            }
            LatticeState::Empty => self.circled |= cell.bit(),
        }
        let mask = Self::ROW[cell.row()];
        if self.circled & mask == mask {
            fired.push(Self::ROW_BONUS[cell.row()]);
        }
        let mask = Self::COLUMN[cell.column()];
        if self.circled & mask == mask {
            fired.push(Self::COLUMN_BONUS[cell.column()]);
        }
        fired
    }

    fn score(&self) -> Score {
        Self::POINTS[self.crossed() as usize]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::area::harness;

    fn face(v: u8) -> Face {
        Face::new(v).expect("a die face")
    }

    /// The cell at a *layout* position — the coordinates the sheet and the
    /// TypeScript group lists use.
    fn at(position: u8) -> LatticeCell {
        LatticeCell::at(position).expect("a real cell")
    }

    fn bits(mask: u16) -> Vec<usize> {
        (0..Yellow::CELLS)
            .filter(|i| mask & (1 << i) != 0)
            .map(|i| LatticeCell::new(i as u8).expect("a cell").position())
            .collect()
    }

    #[test]
    fn the_layout_holds_ten_cells_among_its_holes() {
        assert_eq!(LAYOUT.iter().filter(|&&v| v != 0).count(), Yellow::CELLS);
        assert_eq!(
            Yellow::POSITION.to_vec(),
            vec![1, 3, 4, 6, 9, 11, 12, 14, 17, 19]
        );
        // 1 and 6 are printed once, 2..=5 twice.
        for (value, count) in [(1, 1), (2, 2), (3, 2), (4, 2), (5, 2), (6, 1)] {
            assert_eq!(
                Yellow::cells().filter(|c| c.value() == face(value)).count(),
                count,
                "value {value}"
            );
        }
        for position in [0u8, 2, 5, 7, 8, 10, 13, 15, 16, 18] {
            assert!(LatticeCell::at(position).is_none(), "{position} is a hole");
        }
        assert!(LatticeCell::at(20).is_none());
        assert!(LatticeCell::new(10).is_none());
    }

    #[test]
    fn the_group_masks_match_the_printed_layout() {
        assert_eq!(bits(Yellow::ROW[0]), vec![1, 3]);
        assert_eq!(bits(Yellow::ROW[1]), vec![4, 6]);
        assert_eq!(bits(Yellow::ROW[2]), vec![9, 11]);
        assert_eq!(bits(Yellow::ROW[3]), vec![12, 14]);
        assert_eq!(bits(Yellow::ROW[4]), vec![17, 19]);
        assert_eq!(bits(Yellow::COLUMN[0]), vec![4, 12]);
        assert_eq!(bits(Yellow::COLUMN[1]), vec![1, 9, 17]);
        assert_eq!(bits(Yellow::COLUMN[2]), vec![6, 14]);
        assert_eq!(bits(Yellow::COLUMN[3]), vec![3, 11, 19]);
    }

    #[test]
    fn a_die_circles_an_empty_cell_and_crosses_a_circled_one() {
        let mut y = Yellow::new();
        let fives: Vec<usize> = y.marks(face(5)).map(|c| c.position()).collect();
        assert_eq!(fives, vec![14, 17]);
        assert_eq!(y.marks(face(1)).count(), 1);

        let _ = y.apply(at(14));
        assert_eq!(y.state(at(14)), LatticeState::Circled);
        // Still offered — now as a cross.
        assert_eq!(y.marks(face(5)).count(), 2);
        assert_eq!(y.next_state(at(14)), Some(LatticeState::Crossed));

        let _ = y.apply(at(14));
        assert_eq!(y.state(at(14)), LatticeState::Crossed);
        assert_eq!(y.next_state(at(14)), None);
        let fives: Vec<usize> = y.marks(face(5)).map(|c| c.position()).collect();
        assert_eq!(fives, vec![17]);
    }

    /// The mark is relative, so applying one twice walks the cell through both
    /// states rather than writing a state captured at enumeration time.
    #[test]
    fn one_mark_applied_twice_circles_then_crosses() {
        let mut y = Yellow::new();
        let mark = y.marks(face(1)).next().expect("the lone 1");
        let _ = y.apply(mark);
        assert_eq!(y.state(mark), LatticeState::Circled);
        let _ = y.apply(mark);
        assert_eq!(y.state(mark), LatticeState::Crossed);
        // And a third application is absorbed.
        assert!(y.apply(mark).is_empty());
        assert_eq!(y.state(mark), LatticeState::Crossed);
        assert_eq!(y.crossed(), 1);
    }

    #[test]
    fn a_fully_circled_group_fires_its_bonus_and_crossing_does_not_refire_it() {
        let mut y = Yellow::new();
        assert!(y.apply(at(4)).is_empty(), "row 1 fired early");
        let fired: Vec<Effect> = y.apply(at(6)).into_iter().collect();
        assert_eq!(fired, vec![Effect::Return]);
        assert!(y.apply(at(4)).is_empty(), "crossing is bonus-neutral");
        assert!(y.apply(at(6)).is_empty());
    }

    #[test]
    fn a_crossed_cell_still_counts_as_circled_for_its_groups() {
        let mut y = Yellow::new();
        let _ = y.apply(at(4)); // circle
        let _ = y.apply(at(4)); // cross
        let fired: Vec<Effect> = y.apply(at(12)).into_iter().collect();
        assert_eq!(fired, vec![Effect::Reroll], "column 0 is complete");
    }

    #[test]
    fn a_circle_can_complete_a_row_and_a_column_at_once() {
        let mut y = Yellow::new();
        let _ = y.apply(at(3));
        let _ = y.apply(at(11));
        assert_eq!(
            y.apply(at(19)).into_iter().collect::<Vec<_>>(),
            vec![Effect::Fox]
        );
        assert_eq!(
            y.apply(at(1)).into_iter().collect::<Vec<_>>(),
            vec![Effect::Free(FreeTarget::Blue)]
        );
        assert_eq!(
            y.apply(at(17)).into_iter().collect::<Vec<_>>(),
            vec![Effect::Free(FreeTarget::Pink)]
        );
        // Cell 9 closes its row and its column together, row first.
        assert_eq!(
            y.apply(at(9)).into_iter().collect::<Vec<_>>(),
            vec![Effect::Free(FreeTarget::Yellow), Effect::Plus1]
        );
    }

    #[test]
    fn only_crosses_score() {
        let mut y = Yellow::new();
        for position in [1u8, 3, 4, 6, 9] {
            let _ = y.apply(at(position));
        }
        assert_eq!(y.circled(), 5);
        assert_eq!(y.score(), 0, "circles alone score nothing");
        let _ = y.apply(at(1));
        let _ = y.apply(at(4));
        assert_eq!(y.score(), 10);
        // Every cell circled and crossed is the full 165.
        let mut full = Yellow::new();
        for _ in 0..2 {
            for cell in Yellow::cells() {
                let _ = full.apply(cell);
            }
        }
        assert_eq!(full.crossed(), 10);
        assert_eq!(full.score(), 165);
        assert_eq!(full.markable().count(), 0);
    }

    #[test]
    fn free_marks_are_every_circle_and_every_cross() {
        let mut y = Yellow::new();
        assert_eq!(y.free_marks().count(), 10, "ten circles");
        let _ = y.apply(at(4));
        assert_eq!(y.free_marks().count(), 10, "nine circles and one cross");
        assert_eq!(y.next_state(at(4)), Some(LatticeState::Crossed));
        let _ = y.apply(at(4));
        assert_eq!(y.free_marks().count(), 9);
    }

    #[test]
    fn from_bits_cannot_cross_what_is_not_circled() {
        let y = Yellow::from_bits(0, u16::MAX);
        assert_eq!(y.circled(), 10, "a cross implies a circle");
        assert_eq!(y.crossed(), 10);
        let (circled, crossed) = y.bits();
        assert_eq!(circled, (1 << 10) - 1);
        assert_eq!(crossed, (1 << 10) - 1);
        assert_eq!(Yellow::default(), Yellow::new());
    }

    #[test]
    fn survives_the_generic_area_exercises() {
        // Twenty marks: ten cells, two states each. `saturates_in` counts
        // marks rather than cells, which a relative mark satisfies unchanged.
        harness::saturates_in(&mut Yellow::new(), &Face::ALL, 2 * Yellow::CELLS);
    }
}
