//! The decision queue.
//!
//! A bonus that requires a player choice cannot resolve on the spot, so it
//! waits here. The queue is shared; what it holds — a game's `Choice` type —
//! is not.

use arrayvec::ArrayVec;

use crate::error::Error;

/// Queued player decisions, resolved head first.
///
/// Only a game's `Choice` type — the strict subset of its effects that need a
/// decision — should ever enter the queue, so there is no "the head is not
/// decidable" error to raise.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pending<C, const N: usize>(ArrayVec<C, N>);

impl<C: Copy, const N: usize> Pending<C, N> {
    /// An empty queue.
    #[must_use]
    pub const fn new() -> Self {
        Pending(ArrayVec::new_const())
    }

    /// Queue a decision behind the ones already waiting — the normal case: a
    /// mark's bonuses are resolved in the order they fired.
    ///
    /// # Errors
    /// [`Error::PendingOverflow`] when the queue is full.
    pub fn push_back(&mut self, c: C) -> Result<(), Error> {
        self.0.try_push(c).map_err(|_| Error::PendingOverflow)
    }

    /// Queue a decision *ahead* of everything waiting.
    ///
    /// One rule needs it: *Twice*'s platter-chain row choices are marked
    /// "now", before the pick's other pending effects. Pushing several in die
    /// order means pushing them in reverse.
    ///
    /// # Errors
    /// [`Error::PendingOverflow`] when the queue is full.
    pub fn push_front(&mut self, c: C) -> Result<(), Error> {
        if self.0.is_full() {
            return Err(Error::PendingOverflow);
        }
        self.0.insert(0, c);
        Ok(())
    }

    /// The decision the player must resolve next, if any.
    #[must_use]
    pub fn head(&self) -> Option<C> {
        self.0.first().copied()
    }

    /// Remove and return the head — resolving it.
    pub fn pop(&mut self) -> Option<C> {
        if self.0.is_empty() {
            None
        } else {
            Some(self.0.remove(0))
        }
    }

    /// Drop *leading* decisions that `resolvable` rejects, and report how many
    /// were lost so the game can count them in
    /// [`Stats::bonuses_lost`](crate::Stats::bonuses_lost).
    ///
    /// A queued bonus can become impossible while it waits — its target area
    /// filled up in the meantime — and is then forfeited. Only the head is
    /// examined, repeatedly: an entry deeper in the queue may yet become
    /// resolvable again by the time it reaches the front, and is not dropped
    /// pre-emptively.
    ///
    /// The predicate almost always needs to read the sheet while the queue is
    /// borrowed mutably, which is a disjoint-field borrow rather than a
    /// conflict — destructure first:
    ///
    /// ```ignore
    /// let Self { pending, sheet, stats, .. } = self;
    /// stats.lose_bonuses(pending.retain_resolvable(|c| sheet.can_resolve(c)));
    /// ```
    pub fn retain_resolvable(&mut self, resolvable: impl Fn(C) -> bool) -> u32 {
        let mut lost = 0;
        while self.0.first().is_some_and(|&c| !resolvable(c)) {
            self.0.remove(0);
            lost += 1;
        }
        lost
    }

    /// How many decisions are waiting.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether no decision is waiting — the game may proceed with its phase.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Whether no further decision fits. The next `push` would fail.
    #[must_use]
    pub fn is_full(&self) -> bool {
        self.0.is_full()
    }

    /// The queued decisions, head first.
    pub fn iter(&self) -> impl Iterator<Item = C> + '_ {
        self.0.iter().copied()
    }

    /// Forget every queued decision, without counting the losses.
    pub fn clear(&mut self) {
        self.0.clear();
    }

    /// The queue's capacity — `N`.
    #[must_use]
    pub const fn capacity(&self) -> usize {
        N
    }
}

impl<C: Copy, const N: usize> Default for Pending<C, N> {
    fn default() -> Self {
        Pending::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Q = Pending<u8, 4>;

    #[test]
    fn fifo_by_default() {
        let mut q = Q::new();
        assert!(q.is_empty());
        assert_eq!(q.head(), None);
        assert_eq!(q.pop(), None);
        q.push_back(1).unwrap();
        q.push_back(2).unwrap();
        assert_eq!(q.head(), Some(1));
        assert_eq!(q.len(), 2);
        assert_eq!(q.pop(), Some(1));
        assert_eq!(q.pop(), Some(2));
        assert!(q.is_empty());
    }

    #[test]
    fn push_front_jumps_the_queue() {
        let mut q = Q::new();
        q.push_back(9).unwrap();
        // Pushing 1,2,3 in reverse leaves them ahead of 9, in order.
        for c in [3, 2, 1] {
            q.push_front(c).unwrap();
        }
        assert_eq!(q.iter().collect::<Vec<_>>(), vec![1, 2, 3, 9]);
    }

    #[test]
    fn overflow_is_reported_not_silent() {
        let mut q = Q::new();
        for c in 0..4 {
            q.push_back(c).unwrap();
        }
        assert!(q.is_full());
        assert_eq!(q.push_back(4), Err(Error::PendingOverflow));
        assert_eq!(q.push_front(4), Err(Error::PendingOverflow));
        assert_eq!(q.len(), 4);
        assert_eq!(q.capacity(), 4);
    }

    #[test]
    fn retain_resolvable_drops_only_the_head_run() {
        let mut q = Q::new();
        for c in [1, 3, 2, 5] {
            q.push_back(c).unwrap();
        }
        // Odd entries are resolvable: 1 stays, nothing is dropped.
        assert_eq!(q.retain_resolvable(|c| c % 2 == 1), 0);
        assert_eq!(q.len(), 4);
        // Even entries are resolvable: 1 and 3 go, 2 stops the scan, 5 stays.
        assert_eq!(q.retain_resolvable(|c| c % 2 == 0), 2);
        assert_eq!(q.iter().collect::<Vec<_>>(), vec![2, 5]);
    }

    #[test]
    fn retain_resolvable_can_empty_the_queue() {
        let mut q = Q::new();
        for c in [1, 2, 3] {
            q.push_back(c).unwrap();
        }
        assert_eq!(q.retain_resolvable(|_| false), 3);
        assert!(q.is_empty());
        // An empty queue loses nothing.
        assert_eq!(q.retain_resolvable(|_| false), 0);
    }

    #[test]
    fn clear_forgets_without_counting() {
        let mut q = Q::default();
        q.push_back(1).unwrap();
        q.clear();
        assert!(q.is_empty());
    }
}
