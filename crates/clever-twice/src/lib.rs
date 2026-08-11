//! *Twice as Clever* (Doppelt so clever), solo.
//!
//! Six rounds of an active turn and a passive turn, five scoring areas, three
//! action bars that each end in a bonus, and a bonus cascade that chains until
//! it runs out of cells. The rules live here; the dice mechanic, the action
//! bars, the decision queue and the [`Solitaire`](clever_core::Solitaire)
//! contract live in `clever-core`.
//!
//! This sheet shares one mechanic with *That's Pretty Clever* — a write track
//! — and introduces four of its own, which is why a game is a crate rather
//! than a data file.

#![forbid(unsafe_code)]
#![warn(missing_docs, missing_debug_implementations)]

mod area;
mod color;
mod effect;

pub use area::{
    Area, Blue, Green, LatticeCell, LatticeState, Pink, Silver, SilverCell, SilverRow, Yellow,
};
pub use color::Color;
pub use effect::{Choice, Effect, FreeTarget};
