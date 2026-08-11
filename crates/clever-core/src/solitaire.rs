//! The contract a Clever game implements, and the shape every consumer —
//! bots, the simulation driver, the facades — programs against.
//!
//! The action list lives *inside* the [`Node::Decision`] variant, so there is
//! no `actions()` to call at the wrong time: a chance node and a finished game
//! have no list to hand out, and the prototype's runtime
//! `no legal actions in phase …` has no counterpart here.

use core::fmt;
use core::ops::Deref;

use arrayvec::ArrayVec;
use rand_core::RngCore;

use crate::error::Error;
use crate::score::Breakdown;
use crate::stats::Stats;
use crate::vocab::Round;

/// The largest action list any decision node of any Clever game offers.
///
/// Measured, not estimated. *That's Pretty Clever* peaks at **13**: the +1
/// window offers the wild die's six marks plus one or two per colored die, and
/// the pick phase offers the same set plus a re-roll. That maximum holds over
/// 20 000 uniform-random games and over a one-ply search that is trying to
/// widen the node.
///
/// The constant is set well above it because it is shared with *Twice as
/// Clever*, whose silver `?` bonus offers up to 24 free marks on its own and
/// whose lattice gives several dice more than one mark each. `Actions` is an
/// inline buffer of four-byte actions, so the headroom costs under 200 bytes
/// on the stack and nothing at all at run time.
pub const MAX_ACTIONS: usize = 48;

/// The legal actions at a decision node.
///
/// Owned rather than borrowed: an action is a handful of bytes and the buffer
/// is inline, so returning one is a move with no heap traffic and no lifetime
/// in the signature. It derefs to a slice, so `len`, indexing, iteration and
/// `iter().max_by_key(…)` come free, and applying by index — the form both
/// facades want — is `game.apply(actions[i])`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Actions<A>(ArrayVec<A, MAX_ACTIONS>);

impl<A> Actions<A> {
    /// An empty list.
    #[must_use]
    pub const fn new() -> Self {
        Actions(ArrayVec::new_const())
    }

    /// Offer one more action.
    ///
    /// Past [`MAX_ACTIONS`] the action is dropped: debug builds assert, so a
    /// game that outgrows the constant is caught while it is being written,
    /// and release builds keep the "no public entry point panics" guarantee.
    /// The property suite pins the real maximum well under the cap.
    pub fn push(&mut self, action: A) {
        debug_assert!(
            !self.0.is_full(),
            "MAX_ACTIONS is too small for this game's widest node"
        );
        let _ = self.0.try_push(action);
    }

    /// Forget every action, keeping the buffer — for `actions_into` on a hot
    /// loop that reuses one list.
    pub fn clear(&mut self) {
        self.0.clear();
    }

    /// Whether no further action fits. The next [`push`](Self::push) is lost.
    #[must_use]
    pub fn is_full(&self) -> bool {
        self.0.is_full()
    }
}

impl<A> Deref for Actions<A> {
    type Target = [A];

    fn deref(&self) -> &[A] {
        &self.0
    }
}

impl<A> Default for Actions<A> {
    fn default() -> Self {
        Actions::new()
    }
}

impl<A> FromIterator<A> for Actions<A> {
    fn from_iter<I: IntoIterator<Item = A>>(iter: I) -> Self {
        let mut list = Actions::new();
        for a in iter {
            list.push(a);
        }
        list
    }
}

impl<A> IntoIterator for Actions<A> {
    type Item = A;
    type IntoIter = arrayvec::IntoIter<A, MAX_ACTIONS>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

impl<'a, A> IntoIterator for &'a Actions<A> {
    type Item = &'a A;
    type IntoIter = core::slice::Iter<'a, A>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}

/// Where a game stands: finished, waiting on the dice, or waiting on the
/// player.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Node<A> {
    /// The game is over; call [`Solitaire::score`].
    Over,
    /// The dice must be rolled; call [`Solitaire::roll`].
    Chance,
    /// The player must choose one of these; call [`Solitaire::apply`].
    Decision(Actions<A>),
}

impl<A> Node<A> {
    /// Whether the game has finished.
    #[must_use]
    pub const fn is_over(&self) -> bool {
        matches!(self, Node::Over)
    }

    /// Whether the dice are owed a roll.
    #[must_use]
    pub const fn is_chance(&self) -> bool {
        matches!(self, Node::Chance)
    }

    /// The action list, for a decision node.
    #[must_use]
    pub fn actions(self) -> Option<Actions<A>> {
        match self {
            Node::Decision(a) => Some(a),
            _ => None,
        }
    }
}

/// A solitaire Clever game: the alternation of chance and decision nodes that
/// bots, rollouts and the facades drive.
///
/// ```ignore
/// loop {
///     match game.node() {
///         Node::Over => break,
///         Node::Chance => game.roll(&mut rng),
///         Node::Decision(actions) => {
///             let a = bot.choose(&game, &actions, &mut rng);
///             game.apply(a)?;
///         }
///     }
/// }
/// let outcome = game.score();
/// ```
///
/// Deliberately absent: observation encoding and weight loading. A rules crate
/// carries no machine-learning concerns.
pub trait Solitaire: Clone {
    /// The game's own action type — a sum over its placements. Small and
    /// `Copy`, so action lists are plain buffers.
    type Action: Copy + Eq + fmt::Debug;

    /// What the game is waiting for.
    fn node(&self) -> Node<Self::Action>;

    /// Take an action.
    ///
    /// # Errors
    /// [`Error::Illegal`] when the action is not one [`node`](Self::node)
    /// offered — the facades submit actions they did not enumerate — and
    /// [`Error::NotADecision`] when a bonus is resolved with nothing pending.
    fn apply(&mut self, action: Self::Action) -> Result<(), Error>;

    /// Resolve a [`Node::Chance`]. A no-op at any other node, so no input
    /// sequence panics.
    fn roll(&mut self, rng: &mut dyn RngCore);

    /// The score as it stands — meaningful at any node, final at
    /// [`Node::Over`].
    fn score(&self) -> Breakdown;

    /// Which round is being played.
    fn round(&self) -> Round;

    /// The diagnostic counters.
    fn stats(&self) -> &Stats;

    /// A human-readable rendering of `action` *in this state* — a die's face
    /// and a cell's label live in the game, not in the action.
    fn describe(&self, action: Self::Action) -> impl fmt::Display;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_deref_to_a_slice() {
        let list: Actions<u8> = (0..5).collect();
        assert_eq!(list.len(), 5);
        assert_eq!(list[2], 2);
        assert_eq!(list.iter().copied().max(), Some(4));
        assert!(list.contains(&3));
        assert!(!list.is_full());
    }

    #[test]
    fn actions_saturate_at_the_cap() {
        // Release semantics: the overflow is dropped, not panicked on. Debug
        // builds assert instead, so this only checks the shape of the buffer.
        let mut list = Actions::<u16>::new();
        for a in 0..MAX_ACTIONS as u16 {
            list.push(a);
        }
        assert!(list.is_full());
        assert_eq!(list.len(), MAX_ACTIONS);
        list.clear();
        assert!(list.is_empty());
    }

    #[test]
    fn a_node_knows_which_kind_it_is() {
        let over = Node::<u8>::Over;
        assert!(over.is_over() && !over.is_chance());
        assert!(over.actions().is_none());

        let chance = Node::<u8>::Chance;
        assert!(chance.is_chance() && !chance.is_over());

        let decision = Node::Decision((0u8..3).collect::<Actions<_>>());
        assert!(!decision.is_over() && !decision.is_chance());
        assert_eq!(decision.actions().map(|a| a.len()), Some(3));
    }
}
