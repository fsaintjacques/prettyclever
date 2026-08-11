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
//! than a data file. Three of its rules have no counterpart in the base game
//! at all:
//!
//! - **The platter chain.** A pick placed in the silver grid also marks every
//!   die that pick swept onto the platter: a colored die in its own row, the
//!   wild and silver dice in a row the player picks. That choice jumps the
//!   queue.
//! - **The return window.** Between a pick and the following roll — and before
//!   a re-roll — a banked return may pull a die off the platter and back into
//!   the pool, so the next roll includes it.
//! - **Two-state cells.** A yellow die circles a lattice cell, and later
//!   crosses it. Groups complete at *circled*; only crosses score. The mark is
//!   relative — it advances whatever the cell holds when it lands — so a mark
//!   enumerated before another touched the same cell cannot write a stale
//!   state.
//!
//! Green's subtraction pairs can make an area score negative, which makes the
//! fox multiplier negative with it.
//!
//! ```
//! use clever_core::{Node, Rng, SeedableRng, Solitaire};
//! use clever_twice::TwiceAsClever;
//!
//! let mut rng = Rng::seed_from_u64(0xC1EE_2048);
//! let mut game = TwiceAsClever::new(&mut rng);
//!
//! // A uniform-random policy, which is the floor every bot is measured against.
//! loop {
//!     match game.node() {
//!         Node::Over => break,
//!         Node::Chance => game.roll(&mut rng),
//!         Node::Decision(actions) => {
//!             let i = clever_core::below(&mut rng, actions.len() as u32) as usize;
//!             game.apply(actions[i]).expect("an enumerated action is legal");
//!         }
//!     }
//! }
//! assert_eq!(game.round().get(), 6);
//! ```

#![forbid(unsafe_code)]
#![warn(missing_docs, missing_debug_implementations)]

mod action;
mod area;
mod color;
mod describe;
mod effect;
mod game;
mod sheet;

pub use action::{Action, BonusPick};
pub use area::{
    Area, Blue, Green, LatticeCell, LatticeState, Pink, Silver, SilverCell, SilverRow, Yellow,
};
pub use color::Color;
pub use describe::Described;
pub use effect::{Choice, Effect, FreeTarget};
pub use game::{Phase, TwiceAsClever, PENDING};
pub use sheet::{Placement, Sheet};
