//! The action-bar economy: unlock, cap, spend.

/// One printed action bar — re-roll, +1, or (in *Twice as Clever*) return.
///
/// The bar tracks two independent quantities: how many slots have been
/// *circled* (cumulative unlocks, which only ever grow and stop at the cap)
/// and how many of those actions have been *spent*. What is usable now is the
/// difference.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Bar {
    unlocked: u8,
    spent: u8,
    cap: u8,
}

/// What circling a slot achieved.
///
/// `#[must_use]` on purpose: dropping this value silently drops *Twice*'s
/// end-of-bar bonus, which is exactly the mistake the prototype's `if` inside
/// `unlockBar` invites.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[must_use = "an Unlock reports a bonus (Filled) or a lost bonus (Overflow)"]
pub enum Unlock {
    /// An ordinary slot was circled; one more action is available.
    Gained,
    /// The *last* slot was circled: one more action is available **and** the
    /// game must now fire this bar's end-of-bar bonus.
    Filled,
    /// The bar was already full. The unlock is lost, and the game should
    /// count it in [`Stats::bonuses_lost`](crate::Stats::bonuses_lost).
    Overflow,
}

impl Unlock {
    /// Whether an action was actually banked — false only for
    /// [`Unlock::Overflow`].
    #[must_use]
    pub const fn is_gained(self) -> bool {
        !matches!(self, Unlock::Overflow)
    }

    /// Whether the game owes an end-of-bar bonus.
    #[must_use]
    pub const fn is_filled(self) -> bool {
        matches!(self, Unlock::Filled)
    }

    /// Whether the unlock was lost to a full bar.
    #[must_use]
    pub const fn is_overflow(self) -> bool {
        matches!(self, Unlock::Overflow)
    }
}

impl Bar {
    /// A fresh, empty bar with `cap` printed slots.
    ///
    /// A bar that exists always has at least one slot (7 in *That's Pretty
    /// Clever*, 6 in *Twice*); a game without a bar simply has no such field,
    /// rather than a bar of size zero.
    #[must_use]
    pub const fn new(cap: u8) -> Self {
        debug_assert!(cap >= 1, "a bar that exists has at least one slot");
        Bar {
            unlocked: 0,
            spent: 0,
            cap,
        }
    }

    /// Circle the next slot.
    ///
    /// Past the cap the unlock is lost rather than banked — the printed bar
    /// has run out of slots.
    pub fn unlock(&mut self) -> Unlock {
        if self.unlocked >= self.cap {
            return Unlock::Overflow;
        }
        self.unlocked += 1;
        if self.unlocked == self.cap {
            Unlock::Filled
        } else {
            Unlock::Gained
        }
    }

    /// Spend one banked action. Answers `false`, changing nothing, when none
    /// is available.
    pub fn spend(&mut self) -> bool {
        if self.available() == 0 {
            return false;
        }
        self.spent += 1;
        true
    }

    /// Actions unlocked but not yet spent — what the player may use now.
    #[must_use]
    pub const fn available(&self) -> u8 {
        self.unlocked - self.spent
    }

    /// How many slots are circled, for rendering the printed bar.
    #[must_use]
    pub const fn circled(&self) -> u8 {
        self.unlocked
    }

    /// How many circled slots have been used up.
    #[must_use]
    pub const fn spent(&self) -> u8 {
        self.spent
    }

    /// The number of printed slots.
    #[must_use]
    pub const fn cap(&self) -> u8 {
        self.cap
    }

    /// Whether every slot is circled — further unlocks overflow.
    #[must_use]
    pub const fn is_full(&self) -> bool {
        self.unlocked >= self.cap
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unlock_then_spend() {
        let mut b = Bar::new(7);
        assert_eq!(b.available(), 0);
        assert!(!b.spend());
        assert_eq!(b.unlock(), Unlock::Gained);
        assert_eq!(b.available(), 1);
        assert_eq!(b.circled(), 1);
        assert!(b.spend());
        assert_eq!(b.available(), 0);
        // Spending never un-circles a slot.
        assert_eq!(b.circled(), 1);
        assert_eq!(b.spent(), 1);
        assert!(!b.spend());
    }

    #[test]
    fn last_slot_reports_filled_once() {
        let mut b = Bar::new(3);
        assert_eq!(b.unlock(), Unlock::Gained);
        assert_eq!(b.unlock(), Unlock::Gained);
        assert_eq!(b.unlock(), Unlock::Filled);
        assert!(b.is_full());
        assert_eq!(b.available(), 3);
        // A full bar loses further unlocks, and does not re-fire the bonus.
        assert_eq!(b.unlock(), Unlock::Overflow);
        assert_eq!(b.unlock(), Unlock::Overflow);
        assert_eq!(b.circled(), 3);
        assert_eq!(b.available(), 3);
    }

    #[test]
    fn a_one_slot_bar_fills_immediately() {
        let mut b = Bar::new(1);
        assert_eq!(b.unlock(), Unlock::Filled);
        assert_eq!(b.unlock(), Unlock::Overflow);
    }

    #[test]
    fn spending_does_not_reopen_the_cap() {
        let mut b = Bar::new(2);
        assert_eq!(b.unlock(), Unlock::Gained);
        assert_eq!(b.unlock(), Unlock::Filled);
        assert!(b.spend());
        assert!(b.spend());
        assert_eq!(b.available(), 0);
        assert_eq!(b.unlock(), Unlock::Overflow);
    }

    #[test]
    fn unlock_predicates() {
        assert!(Unlock::Gained.is_gained() && !Unlock::Gained.is_filled());
        assert!(Unlock::Filled.is_gained() && Unlock::Filled.is_filled());
        assert!(!Unlock::Overflow.is_gained() && Unlock::Overflow.is_overflow());
    }
}
