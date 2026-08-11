//! Shared primitives for the *Clever* solo dice games.
//!
//! Nothing here allocates, nothing reads the clock, and the crate builds for
//! `wasm32-unknown-unknown` unmodified.

#![forbid(unsafe_code)]
#![warn(missing_docs, missing_debug_implementations)]

mod error;
mod rng;

pub use error::Error;
pub use rng::{below, shuffle, Rng, RngCore, SeedableRng};
