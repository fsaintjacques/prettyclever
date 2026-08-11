//! What a cell, a completed group or the round track can grant.
//!
//! Two types, not one. [`Effect`] is everything a bonus can be; [`Choice`] is
//! the strict subset that needs the player to decide, and only that subset can
//! enter the pending queue. The prototype has a single union and a runtime
//! `non-decision effect in pending queue` throw; splitting them deletes that
//! error case.

use core::fmt;

use clever_core::Face;

/// The areas a "cross any open cell" bonus can target — the only two with
/// open cells. "Cross any cell of green" is not expressible.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum CrossTarget {
    /// The yellow grid.
    Yellow,
    /// The blue grid.
    Blue,
}

/// The areas a "write this number in the next slot" bonus can target — the
/// two write tracks. "Write a 4 into blue" is not expressible.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum WriteTarget {
    /// The orange track, where the slot's multiplier applies.
    Orange,
    /// The purple track, where the ascending rule still applies.
    Purple,
}

/// A bonus. Most resolve on the spot; two need a decision and become a
/// [`Choice`].
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Effect {
    /// One fox, worth the lowest area's score at game end.
    Fox,
    /// Circle the next slot of the re-roll bar.
    Reroll,
    /// Circle the next slot of the +1 bar.
    Plus1,
    /// Cross any open cell of the target grid — the yellow `X` and blue `X`
    /// bonuses. A decision.
    CrossAny(CrossTarget),
    /// Cross green's next cell, *ignoring* its printed threshold — the green
    /// `X` bonus. Applied at once, lost at once if the track is full.
    CrossNextGreen,
    /// Write a fixed number in the target track's next slot — orange 4/5/6
    /// and purple 6. Applied at once, lost at once if it does not fit.
    WriteNext(WriteTarget, Face),
    /// The round-4 bonus: a black `X` or a black `6`, five options wide. A
    /// decision.
    Black,
}

/// The effects that need a player decision. Only these enter the queue, so
/// the head of the queue is always resolvable by construction.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Choice {
    /// Cross any open cell of the target grid.
    CrossAny(CrossTarget),
    /// The round-4 black `X` / black `6`.
    Black,
}

impl Choice {
    /// The effect this decision came from.
    #[must_use]
    pub const fn effect(self) -> Effect {
        match self {
            Choice::CrossAny(t) => Effect::CrossAny(t),
            Choice::Black => Effect::Black,
        }
    }
}

/// One arm of the round-4 black bonus.
///
/// The variants are the printed options in sheet order; a resolved black
/// bonus names the *option*, not an index into a filtered list, so a legal
/// action cannot silently shift when another option becomes impossible.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum BlackOption {
    /// Black `X`: cross any open yellow cell.
    Yellow,
    /// Black `X`: cross any open blue cell.
    Blue,
    /// Black `X`: cross green's next cell, ignoring its threshold.
    Green,
    /// Black `6`: write a 6 in orange's next slot.
    Orange,
    /// Black `6`: write a 6 in purple's next slot.
    Purple,
}

impl BlackOption {
    /// The five options, in the order the sheet prints them.
    pub const ALL: [BlackOption; 5] = [
        BlackOption::Yellow,
        BlackOption::Blue,
        BlackOption::Green,
        BlackOption::Orange,
        BlackOption::Purple,
    ];

    /// The effect taking this option grants.
    #[must_use]
    pub const fn effect(self) -> Effect {
        match self {
            BlackOption::Yellow => Effect::CrossAny(CrossTarget::Yellow),
            BlackOption::Blue => Effect::CrossAny(CrossTarget::Blue),
            BlackOption::Green => Effect::CrossNextGreen,
            BlackOption::Orange => Effect::WriteNext(WriteTarget::Orange, Face::SIX),
            BlackOption::Purple => Effect::WriteNext(WriteTarget::Purple, Face::SIX),
        }
    }
}

impl fmt::Display for CrossTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            CrossTarget::Yellow => "yellow",
            CrossTarget::Blue => "blue",
        })
    }
}

impl fmt::Display for WriteTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            WriteTarget::Orange => "orange",
            WriteTarget::Purple => "purple",
        })
    }
}

impl fmt::Display for Effect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Effect::Fox => f.write_str("fox"),
            Effect::Reroll => f.write_str("re-roll"),
            Effect::Plus1 => f.write_str("+1 die"),
            Effect::CrossAny(t) => write!(f, "X in {t}"),
            Effect::CrossNextGreen => f.write_str("X next in green"),
            Effect::WriteNext(t, v) => write!(f, "{v} in {t}"),
            Effect::Black => f.write_str("black X or black 6"),
        }
    }
}

impl fmt::Display for BlackOption {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.effect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_choice_names_the_effect_it_came_from() {
        assert_eq!(
            Choice::CrossAny(CrossTarget::Yellow).effect(),
            Effect::CrossAny(CrossTarget::Yellow)
        );
        assert_eq!(
            Choice::CrossAny(CrossTarget::Blue).effect(),
            Effect::CrossAny(CrossTarget::Blue)
        );
        assert_eq!(Choice::Black.effect(), Effect::Black);
    }

    #[test]
    fn the_black_bonus_is_five_options_in_sheet_order() {
        let effects: Vec<Effect> = BlackOption::ALL.iter().map(|o| o.effect()).collect();
        assert_eq!(
            effects,
            vec![
                Effect::CrossAny(CrossTarget::Yellow),
                Effect::CrossAny(CrossTarget::Blue),
                Effect::CrossNextGreen,
                Effect::WriteNext(WriteTarget::Orange, Face::SIX),
                Effect::WriteNext(WriteTarget::Purple, Face::SIX),
            ]
        );
    }

    #[test]
    fn effects_describe_themselves() {
        assert_eq!(Effect::Fox.to_string(), "fox");
        assert_eq!(
            Effect::CrossAny(CrossTarget::Yellow).to_string(),
            "X in yellow"
        );
        assert_eq!(
            Effect::WriteNext(WriteTarget::Orange, Face::FOUR).to_string(),
            "4 in orange"
        );
        assert_eq!(BlackOption::Green.to_string(), "X next in green");
    }
}
