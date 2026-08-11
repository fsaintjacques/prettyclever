//! The six dice of *That's Pretty Clever*, named.
//!
//! The core never learns these names: it only knows [`Die`] indices, and this
//! enum is the game's own mapping from an index to the area a die may mark.

use core::fmt;

use clever_core::Die;

/// A die of this game. The discriminant *is* the core's die index, which is
/// the order the printed sheet lists them in.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum Color {
    /// The wild die: placeable in every area, and the second half of every
    /// blue value.
    White = 0,
    /// Marks the yellow grid.
    Yellow = 1,
    /// Marks the blue grid — always at blue + white, never at its own face.
    Blue = 2,
    /// Marks the green track.
    Green = 3,
    /// Writes into the orange track.
    Orange = 4,
    /// Writes into the purple track.
    Purple = 5,
}

impl Color {
    /// Every die, in sheet order — the order actions are enumerated in.
    pub const ALL: [Color; 6] = [
        Color::White,
        Color::Yellow,
        Color::Blue,
        Color::Green,
        Color::Orange,
        Color::Purple,
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
            4 => Some(Color::Orange),
            5 => Some(Color::Purple),
            _ => None,
        }
    }

    /// Whether this die may be placed in every area. Only the white die is.
    #[must_use]
    pub const fn is_wild(self) -> bool {
        matches!(self, Color::White)
    }

    /// The printed name, for logs and the action descriptions.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Color::White => "white",
            Color::Yellow => "yellow",
            Color::Blue => "blue",
            Color::Green => "green",
            Color::Orange => "orange",
            Color::Purple => "purple",
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
        assert!(Color::ALL.iter().filter(|c| c.is_wild()).count() == 1);
        assert_eq!(Color::Purple.to_string(), "purple");
    }
}
