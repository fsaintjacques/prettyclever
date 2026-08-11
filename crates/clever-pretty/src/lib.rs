//! *That's Pretty Clever* (Ganz schön clever), solo.
//!
//! Six rounds of an active turn and a passive turn, five scoring areas, and a
//! bonus cascade that chains until it runs out of cells. The rules live here;
//! the dice mechanic, the action bars, the decision queue and the
//! [`Solitaire`](clever_core::Solitaire) contract live in `clever-core`.
//!
//! A game is a crate rather than a data file, because the sharing between the
//! two Clever titles is the *dice*, not the sheet: of eight parameterized area
//! factories in the TypeScript prototype only two are used more than once, and
//! both reuses still need configuration unions to bridge them.
//!
//! Each area encodes its **reachable states, not its grid**: green's whole
//! state is a crossed count, the two write tracks are prefixes of written
//! faces, and only the two grids — whose cells really are crossed in any
//! order — are bitsets.

#![forbid(unsafe_code)]
#![warn(missing_docs, missing_debug_implementations)]

mod area;
mod color;
mod effect;
mod sheet;

pub use area::{Area, Blue, BlueCell, Green, GreenCross, Orange, Purple, Yellow, YellowCell};
pub use color::Color;
pub use effect::{BlackOption, Choice, CrossTarget, Effect, WriteTarget};
pub use sheet::{Placement, Sheet};
