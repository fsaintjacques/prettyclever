//! Shared primitives for the *Clever* solo dice games.
//!
//! Nothing here allocates, nothing reads the clock, and the crate builds for
//! `wasm32-unknown-unknown` unmodified.

#![forbid(unsafe_code)]
#![warn(missing_docs, missing_debug_implementations)]

mod dieset;
mod error;
mod mat;
mod rng;
mod vocab;

pub use dieset::{DieSet, DieSetIter};
pub use error::Error;
pub use mat::Mat;
pub use rng::{below, shuffle, Rng, RngCore, SeedableRng};
pub use vocab::{Die, Face, Loc, Pips, Round, Score};
