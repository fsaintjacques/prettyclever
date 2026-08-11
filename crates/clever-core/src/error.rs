//! The engine's error type.

/// What can go wrong at a public entry point.
///
/// The wasm and Python facades hand the engine actions they did not
/// necessarily enumerate, so applying one is fallible. Internal invariants are
/// `debug_assert!`s *on top of* these results: no public entry point panics on
/// any input, and release builds pay nothing for checks that only fire on
/// programmer error.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// The action is not legal in the current state — it was not one the game
    /// enumerated.
    #[error("action is not legal in the current state")]
    Illegal,
    /// A bonus was resolved while no decision was pending.
    #[error("no decision is pending")]
    NotADecision,
    /// More decisions were queued at once than the queue can hold. A bug in
    /// the game's capacity, not in the player's input.
    #[error("the bonus queue overflowed")]
    PendingOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_describe_themselves() {
        assert_eq!(
            Error::Illegal.to_string(),
            "action is not legal in the current state"
        );
        assert_eq!(Error::NotADecision.to_string(), "no decision is pending");
        assert_eq!(
            Error::PendingOverflow.to_string(),
            "the bonus queue overflowed"
        );
    }
}
