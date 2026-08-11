//! Per-game counters. Not rules — diagnostics, and the reason
//! [`Pending::retain_resolvable`](crate::Pending::retain_resolvable) returns a
//! count instead of nothing.

/// What happened over a game, beside the score.
///
/// Bots and the simulation driver read these; nothing in the rules does.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    /// Re-roll actions spent.
    pub rerolls_used: u32,
    /// +1 (extra die) actions spent.
    pub plus1_spent: u32,
    /// Return actions spent — *Twice as Clever* only.
    pub returns_used: u32,
    /// Rolls forfeited because no die could be placed.
    pub skips: u32,
    /// Bonuses that could not be taken and were lost: an auto-applied bonus
    /// whose area was full, a queued decision that became unresolvable while
    /// it waited, and an unlock past a full bar.
    pub bonuses_lost: u32,
}

impl Stats {
    /// Fresh counters.
    #[must_use]
    pub const fn new() -> Self {
        Stats {
            rerolls_used: 0,
            plus1_spent: 0,
            returns_used: 0,
            skips: 0,
            bonuses_lost: 0,
        }
    }

    /// Record `n` lost bonuses — what
    /// [`Pending::retain_resolvable`](crate::Pending::retain_resolvable)
    /// returns.
    pub fn lose_bonuses(&mut self, n: u32) {
        self.bonuses_lost += n;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_at_zero_and_accumulates() {
        let mut s = Stats::new();
        assert_eq!(s, Stats::default());
        s.lose_bonuses(2);
        s.lose_bonuses(0);
        s.lose_bonuses(1);
        assert_eq!(s.bonuses_lost, 3);
    }
}
