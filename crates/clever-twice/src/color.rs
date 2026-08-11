//! The six dice of *Twice as Clever*, named.
//!
//! The core never learns these names: it only knows [`Die`] indices, and this
//! enum is the game's own mapping from an index to the area a die may mark —
//! and, for the platter chain, to the silver row a die marks when it is swept
//! onto the platter.

use core::fmt;

use clever_core::Die;

use crate::area::SilverRow;

/// A die of this game. The discriminant *is* the core's die index, which is
/// the order the printed sheet lists them in.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum Color {
    /// The wild die: placeable in every area, and the second half of every
    /// blue value.
    White = 0,
    /// Marks the yellow lattice.
    Yellow = 1,
    /// Writes into the blue descend track — always at blue + white, never at
    /// its own face.
    Blue = 2,
    /// Writes into the green pairs track.
    Green = 3,
    /// Writes into the pink track.
    Pink = 4,
    /// The only die that may be *placed* in the silver grid. Every other die
    /// reaches silver through the platter chain.
    Silver = 5,
}

impl Color {
    /// Every die, in sheet order — the order actions are enumerated in.
    pub const ALL: [Color; 6] = [
        Color::White,
        Color::Yellow,
        Color::Blue,
        Color::Green,
        Color::Pink,
        Color::Silver,
    ];

    /// This die's index on the mat.
    #[must_use]
    pub const fn die(self) -> Die {
        Die::new(self as u8)
    }

    /// The die at a mat index. `None` for an index this game has no die at,
    /// so a facade's out-of-range input is rejected rather than panicking.
    #[must_use]
    pub const fn of(d: Die) -> Option<Color> {
        match d.get() {
            0 => Some(Color::White),
            1 => Some(Color::Yellow),
            2 => Some(Color::Blue),
            3 => Some(Color::Green),
            4 => Some(Color::Pink),
            5 => Some(Color::Silver),
            _ => None,
        }
    }

    /// Whether this die may be placed in every area. Only the white die is.
    #[must_use]
    pub const fn is_wild(self) -> bool {
        matches!(self, Color::White)
    }

    /// The silver row this die marks when the platter chain sweeps it up, or
    /// `None` when the row is the player's to choose.
    ///
    /// The rule is "a colored die marks its own color's row"; the wild and
    /// silver dice have no row of their own — white because it is every color
    /// and silver because it is the grid's own die — and they mark any row.
    /// That is the whole of the chain's fixed-versus-queued distinction.
    #[must_use]
    pub const fn silver_row(self) -> Option<SilverRow> {
        match self {
            Color::Yellow => Some(SilverRow::Yellow),
            Color::Blue => Some(SilverRow::Blue),
            Color::Green => Some(SilverRow::Green),
            Color::Pink => Some(SilverRow::Pink),
            Color::White | Color::Silver => None,
        }
    }

    /// The printed name, for logs and the action descriptions.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Color::White => "white",
            Color::Yellow => "yellow",
            Color::Blue => "blue",
            Color::Green => "green",
            Color::Pink => "pink",
            Color::Silver => "silver",
        }
    }
}

impl fmt::Display for Color {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colors_index_the_mat_in_sheet_order() {
        for (i, c) in Color::ALL.into_iter().enumerate() {
            assert_eq!(c.die().index(), i);
            assert_eq!(Color::of(c.die()), Some(c));
        }
        assert_eq!(Color::of(Die::new(6)), None);
    }

    #[test]
    fn only_white_is_wild() {
        assert!(Color::White.is_wild());
        assert_eq!(Color::ALL.iter().filter(|c| c.is_wild()).count(), 1);
        assert_eq!(Color::Silver.to_string(), "silver");
    }

    #[test]
    fn only_the_wild_and_silver_dice_choose_their_chain_row() {
        assert_eq!(Color::White.silver_row(), None);
        assert_eq!(Color::Silver.silver_row(), None);
        // The other four map onto the four printed rows, one each.
        let rows: Vec<SilverRow> = Color::ALL.iter().filter_map(|c| c.silver_row()).collect();
        assert_eq!(rows, SilverRow::ALL.to_vec());
    }
}
