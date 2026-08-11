//! What a cell, a completed group, a filled action bar or the round track can
//! grant.
//!
//! Two types, not one. [`Effect`] is everything a bonus can be; [`Choice`] is
//! the strict subset that needs the player to decide, and only that subset can
//! enter the pending queue.
//!
//! This sheet's bonuses are almost all decisions. Every colored `?` offers a
//! choice — of a cell in silver and yellow, of a value in blue, green and pink
//! — so the base game's "applied at once, lost at once" arm has exactly one
//! counterpart here: a platter-chain mark whose row is fixed.

use core::fmt;

use clever_core::Face;

use crate::area::SilverRow;

/// The five areas a colored `?` can target.
///
/// Unlike the base game's two-variant `CrossTarget`, every area of this sheet
/// answers a `?`: silver and yellow offer a cell, blue a sum, green and pink a
/// face. The black `?` of round 4 is a free choice among exactly these five,
/// so it needs no separate option type.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum FreeTarget {
    /// Mark any open silver cell — any row, any value.
    Silver,
    /// Circle any uncircled lattice cell, or cross any circled one.
    Yellow,
    /// Write any sum 2..=12 the descent still allows.
    Blue,
    /// Write any face in the next green slot, at that slot's multiplier.
    Green,
    /// Write any face in the next pink slot; the slot's threshold gates its
    /// bonus as usual.
    Pink,
}

impl FreeTarget {
    /// The five targets in sheet order — which is also the order the round-4
    /// black `?` prints its options in.
    pub const ALL: [FreeTarget; 5] = [
        FreeTarget::Silver,
        FreeTarget::Yellow,
        FreeTarget::Blue,
        FreeTarget::Green,
        FreeTarget::Pink,
    ];

    /// The printed name of the area.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            FreeTarget::Silver => "silver",
            FreeTarget::Yellow => "yellow",
            FreeTarget::Blue => "blue",
            FreeTarget::Green => "green",
            FreeTarget::Pink => "pink",
        }
    }
}

/// A bonus.
///
/// Most of these become a [`Choice`]. Only the fox, the three bar unlocks and
/// a row-fixed [`Effect::SilverMark`] resolve without asking the player.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Effect {
    /// One fox, worth the lowest area's score at game end — which this sheet
    /// can drive negative.
    Fox,
    /// Circle the next slot of the re-roll bar.
    Reroll,
    /// Circle the next slot of the +1 bar.
    Plus1,
    /// Circle the next slot of the return bar.
    Return,
    /// A colored `?`: mark the target area however the player likes. A
    /// decision.
    Free(FreeTarget),
    /// A platter-chain mark in the silver grid.
    ///
    /// With a row, it is a colored die marking its own row: applied at once,
    /// and lost at once when that cell is already taken. Without one — the
    /// wild and silver dice — the row is the player's to choose, and it
    /// becomes [`Choice::SilverRow`].
    SilverMark(Face, Option<SilverRow>),
    /// The round-4 black `?`: any one of the five colored `?`s. A decision.
    Black,
}

/// The effects that need a player decision. Only these enter the queue, so the
/// head of the queue is always resolvable by construction.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Choice {
    /// A colored `?` in the target area.
    Free(FreeTarget),
    /// A platter-chain mark of this face, in whichever silver row the player
    /// picks — the wild and silver dice's chain mark.
    SilverRow(Face),
    /// The round-4 black `?`.
    Black,
}

impl Choice {
    /// The effect this decision came from.
    #[must_use]
    pub const fn effect(self) -> Effect {
        match self {
            Choice::Free(target) => Effect::Free(target),
            Choice::SilverRow(face) => Effect::SilverMark(face, None),
            Choice::Black => Effect::Black,
        }
    }
}

impl fmt::Display for FreeTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

impl fmt::Display for Effect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Effect::Fox => f.write_str("fox"),
            Effect::Reroll => f.write_str("re-roll"),
            Effect::Plus1 => f.write_str("+1 die"),
            Effect::Return => f.write_str("return"),
            Effect::Free(target) => write!(f, "? in {target}"),
            Effect::SilverMark(value, Some(row)) => write!(f, "silver {value} ({row} row)"),
            Effect::SilverMark(value, None) => write!(f, "silver {value} (any row)"),
            Effect::Black => f.write_str("? in any area"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_choice_names_the_effect_it_came_from() {
        for target in FreeTarget::ALL {
            assert_eq!(Choice::Free(target).effect(), Effect::Free(target));
        }
        assert_eq!(
            Choice::SilverRow(Face::FOUR).effect(),
            Effect::SilverMark(Face::FOUR, None)
        );
        assert_eq!(Choice::Black.effect(), Effect::Black);
    }

    #[test]
    fn the_black_bonus_is_the_five_colored_questions() {
        let names: Vec<&str> = FreeTarget::ALL.iter().map(|t| t.name()).collect();
        assert_eq!(names, vec!["silver", "yellow", "blue", "green", "pink"]);
    }

    #[test]
    fn effects_describe_themselves() {
        assert_eq!(Effect::Fox.to_string(), "fox");
        assert_eq!(Effect::Return.to_string(), "return");
        assert_eq!(Effect::Free(FreeTarget::Pink).to_string(), "? in pink");
        assert_eq!(
            Effect::SilverMark(Face::FOUR, Some(SilverRow::Green)).to_string(),
            "silver 4 (green row)"
        );
        assert_eq!(
            Effect::SilverMark(Face::FOUR, None).to_string(),
            "silver 4 (any row)"
        );
    }
}
