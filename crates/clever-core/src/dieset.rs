//! A set of dice, as a byte.

use core::fmt;

use crate::vocab::Die;

/// A set of dice — a bitset over die indices, one bit each.
///
/// It is what [`Mat::take`](crate::Mat::take) hands back: the dice that moved
/// to the platter on a pick. *That's Pretty Clever* discards that set;
/// *Twice as Clever*'s platter chain marks every die in it. Being `Copy` and
/// one byte wide, returning it from the hot path costs nothing.
#[derive(Clone, Copy, PartialEq, Eq, Default, Hash)]
pub struct DieSet(u8);

impl DieSet {
    /// The set containing no dice.
    pub const EMPTY: DieSet = DieSet(0);

    /// An empty set.
    #[must_use]
    pub const fn new() -> DieSet {
        DieSet::EMPTY
    }

    /// Add a die. Idempotent.
    pub fn insert(&mut self, d: Die) {
        self.0 |= Self::bit(d);
    }

    /// Remove a die. Idempotent.
    pub fn remove(&mut self, d: Die) {
        self.0 &= !Self::bit(d);
    }

    /// Whether the die is in the set.
    #[must_use]
    pub const fn contains(self, d: Die) -> bool {
        self.0 & Self::bit(d) != 0
    }

    /// How many dice are in the set.
    #[must_use]
    pub const fn len(self) -> usize {
        self.0.count_ones() as usize
    }

    /// Whether the set is empty.
    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// The dice, in ascending index order.
    ///
    /// Die order is the order *Twice*'s platter chain queues its row choices
    /// in, so it is part of the contract rather than an implementation detail.
    #[must_use]
    pub const fn iter(self) -> DieSetIter {
        DieSetIter(self.0)
    }

    /// The raw bits, for a game that wants to store a set in a wider record.
    #[must_use]
    pub const fn bits(self) -> u8 {
        self.0
    }

    const fn bit(d: Die) -> u8 {
        1u8 << d.get()
    }
}

impl FromIterator<Die> for DieSet {
    fn from_iter<I: IntoIterator<Item = Die>>(iter: I) -> Self {
        let mut set = DieSet::EMPTY;
        for d in iter {
            set.insert(d);
        }
        set
    }
}

impl IntoIterator for DieSet {
    type Item = Die;
    type IntoIter = DieSetIter;

    fn into_iter(self) -> DieSetIter {
        self.iter()
    }
}

/// Iterator over the dice of a [`DieSet`], in ascending index order.
#[derive(Clone, Debug)]
pub struct DieSetIter(u8);

impl Iterator for DieSetIter {
    type Item = Die;

    fn next(&mut self) -> Option<Die> {
        if self.0 == 0 {
            return None;
        }
        let i = self.0.trailing_zeros() as u8;
        self.0 &= self.0 - 1;
        Some(Die::new(i))
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let n = self.0.count_ones() as usize;
        (n, Some(n))
    }
}

impl ExactSizeIterator for DieSetIter {}

impl fmt::Debug for DieSet {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DieSet{")?;
        for (n, d) in self.iter().enumerate() {
            if n > 0 {
                f.write_str(",")?;
            }
            write!(f, "{}", d.get())?;
        }
        f.write_str("}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_contains_remove() {
        let mut s = DieSet::new();
        assert!(s.is_empty());
        s.insert(Die::new(0));
        s.insert(Die::new(5));
        s.insert(Die::new(5));
        assert_eq!(s.len(), 2);
        assert!(s.contains(Die::new(0)));
        assert!(s.contains(Die::new(5)));
        assert!(!s.contains(Die::new(1)));
        s.remove(Die::new(5));
        s.remove(Die::new(5));
        assert_eq!(s.len(), 1);
        assert!(!s.contains(Die::new(5)));
    }

    #[test]
    fn iterates_in_ascending_die_order() {
        let s: DieSet = [Die::new(4), Die::new(1), Die::new(7)]
            .into_iter()
            .collect();
        let got: Vec<u8> = s.iter().map(Die::get).collect();
        assert_eq!(got, vec![1, 4, 7]);
    }

    #[test]
    fn empty_set_iterates_nothing() {
        assert_eq!(DieSet::EMPTY.iter().count(), 0);
        assert_eq!(DieSet::EMPTY.len(), 0);
    }
}
