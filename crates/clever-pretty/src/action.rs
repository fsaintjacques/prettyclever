//! What the player may do.

use clever_core::Die;

use crate::effect::BlackOption;
use crate::sheet::Placement;

/// One decision of *That's Pretty Clever*.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Action {
    /// Take a die onto a dice field, pushing every lower pool die onto the
    /// platter, and mark it.
    ///
    /// `place: None` is a **wasted pick**: the die occupies a field and marks
    /// nothing. It is offered only for a die with no legal placement — the
    /// rulebook neither allows nor forbids it, and the engine's ruling is that
    /// it is legal but never free.
    Pick {
        /// The die taken.
        die: Die,
        /// What it marks, or `None` for a wasted pick.
        place: Option<Placement>,
    },
    /// Forfeit the roll: no die can be placed at all. Consumes a pick, keeps
    /// every die, and re-rolls them next.
    Skip,
    /// Spend an unlocked re-roll and roll the pool again.
    Reroll,
    /// Spend an unlocked +1 on any die not yet used this turn, wherever it
    /// sits, at its current face.
    Plus1 {
        /// The die spent.
        die: Die,
        /// What it marks. A +1 is never wasted — it is only offered with a
        /// placement.
        place: Placement,
    },
    /// Stop spending +1s and end the turn.
    EndTurn,
    /// Take one of the three platter dice of the passive turn and mark it.
    PassivePick {
        /// The die taken.
        die: Die,
        /// What it marks.
        place: Placement,
    },
    /// Decline the passive pick.
    PassiveSkip,
    /// Resolve the decision at the head of the pending queue.
    Bonus(BonusPick),
}

/// How a queued decision is resolved.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum BonusPick {
    /// A `cross any` bonus: the cell to cross.
    Cell(Placement),
    /// The round-4 black bonus: which of the five printed options to take.
    Black(BlackOption),
}

impl Action {
    /// The die this action spends, if it spends one.
    #[must_use]
    pub const fn die(self) -> Option<Die> {
        match self {
            Action::Pick { die, .. }
            | Action::Plus1 { die, .. }
            | Action::PassivePick { die, .. } => Some(die),
            _ => None,
        }
    }

    /// The mark this action makes, if it makes one.
    #[must_use]
    pub const fn placement(self) -> Option<Placement> {
        match self {
            Action::Pick { place, .. } => place,
            Action::Plus1 { place, .. } | Action::PassivePick { place, .. } => Some(place),
            Action::Bonus(BonusPick::Cell(place)) => Some(place),
            _ => None,
        }
    }
}
