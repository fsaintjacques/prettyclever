//! What the player may do.

use clever_core::Die;

use crate::effect::FreeTarget;
use crate::sheet::Placement;

/// One decision of *Twice as Clever*.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Action {
    /// Take a die onto a dice field, pushing every lower pool die onto the
    /// platter, and mark it.
    ///
    /// `place: None` is a **wasted pick**: the die occupies a field and marks
    /// nothing. It is offered for a die with no legal placement — except the
    /// silver die, which the rulebook says simply cannot be chosen once its
    /// value is marked in all four rows.
    Pick {
        /// The die taken.
        die: Die,
        /// What it marks, or `None` for a wasted pick.
        place: Option<Placement>,
    },
    /// Forfeit the roll: no die can be placed at all. Consumes a pick, keeps
    /// every die, and re-rolls them next.
    Skip,
    /// Spend an unlocked re-roll and roll the pool again — through the return
    /// window first, so a returned die joins the re-roll.
    Reroll,
    /// Spend an unlocked return: take a die off the platter and back into the
    /// pool, to be rolled with the next roll. Only in the pre-roll window, and
    /// only on an active turn.
    Return {
        /// The platter die coming back.
        die: Die,
    },
    /// Leave the return window without spending one, and roll.
    Proceed,
    /// Spend an unlocked +1 on any die not yet used *this round*, wherever it
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
    /// A colored `?` or a platter-chain row choice: the mark to make. The
    /// queue head says which of the two it is, and both are answered with a
    /// placement.
    Cell(Placement),
    /// The round-4 black `?`: which of the five colored `?`s to take.
    Black(FreeTarget),
}

impl Action {
    /// The die this action spends or moves, if it touches one.
    #[must_use]
    pub const fn die(self) -> Option<Die> {
        match self {
            Action::Pick { die, .. }
            | Action::Plus1 { die, .. }
            | Action::PassivePick { die, .. }
            | Action::Return { die } => Some(die),
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

#[cfg(test)]
mod tests {
    use super::*;
    use clever_core::Face;

    #[test]
    fn an_action_is_four_bytes() {
        assert!(core::mem::size_of::<Action>() <= 4);
    }

    #[test]
    fn an_action_names_the_die_it_touches() {
        let die = Die::new(3);
        assert_eq!(Action::Return { die }.die(), Some(die));
        assert_eq!(Action::Proceed.die(), None);
        assert_eq!(
            Action::Plus1 {
                die,
                place: Placement::Pink(Face::SIX)
            }
            .placement(),
            Some(Placement::Pink(Face::SIX))
        );
        assert_eq!(Action::Skip.placement(), None);
    }
}
