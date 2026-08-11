//! Shared primitives for the *Clever* solo dice games.
//!
//! Two games — *That's Pretty Clever* and *Twice as Clever* — share a dice
//! mechanic and almost nothing else. This crate is the part that is genuinely
//! shared:
//!
//! - the vocabulary a die is described in: [`Face`], [`Pips`], [`Die`],
//!   [`DieSet`], [`Loc`], [`Round`], [`Score`];
//! - the [`Mat`], which holds the dice and implements the pick rule and the
//!   passive roll;
//! - the action-bar economy, [`Bar`] and [`Unlock`];
//! - the decision queue, [`Pending`];
//! - the [`Solitaire`] contract with [`Node`] and [`Actions`], the shape every
//!   consumer programs against;
//! - the fox rule and the score [`Breakdown`], the [`Rating`] lookup,
//!   [`Stats`] and [`Error`];
//! - the seeded [`Rng`], so determinism lives in one place.
//!
//! Everything above is a *mechanic*. Scoring areas, effects, placements and
//! the phase machine are per game and live in `clever-pretty` and
//! `clever-twice`: the core never learns that die 4 is orange in one game and
//! pink in the other.
//!
//! Nothing here allocates, nothing reads the clock, and the crate builds for
//! `wasm32-unknown-unknown` unmodified.
//!
//! ```
//! use clever_core::{Die, Loc, Mat, Rng, SeedableRng};
//!
//! let mut rng = Rng::seed_from_u64(0xC1EE_1234);
//! let mut mat = Mat::<6>::new(&mut rng);
//!
//! // Picking a die pushes every lower pool die onto the platter.
//! let highest = mat.pool().max_by_key(|&d| mat.face(d)).expect("a full pool");
//! let moved = mat.take(highest);
//! assert_eq!(mat.loc(highest), Loc::Field);
//! assert!(moved.iter().all(|d| mat.face(d) < mat.face(highest)));
//! # let _: Die = highest;
//! ```

#![forbid(unsafe_code)]
#![warn(missing_docs, missing_debug_implementations)]

mod bar;
mod dieset;
mod error;
mod mat;
mod pending;
mod rng;
mod score;
mod solitaire;
mod stats;
mod vocab;

pub use bar::{Bar, Unlock};
pub use dieset::{DieSet, DieSetIter};
pub use error::Error;
pub use mat::Mat;
pub use pending::Pending;
pub use rng::{below, shuffle, Rng, RngCore, SeedableRng};
pub use score::{rate, Areas, Breakdown, Rating, MAX_AREAS};
pub use solitaire::{Actions, Node, Solitaire, MAX_ACTIONS};
pub use stats::Stats;
pub use vocab::{Die, Face, Loc, Pips, Round, Score};
