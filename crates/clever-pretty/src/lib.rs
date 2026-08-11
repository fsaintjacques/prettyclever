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
//!
//! ```
//! use clever_core::{Node, Rng, SeedableRng, Solitaire};
//! use clever_pretty::PrettyClever;
//!
//! let mut rng = Rng::seed_from_u64(0xC1EE_2024);
//! let mut game = PrettyClever::new(&mut rng);
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
//! assert!(game.score().total > 0);
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
pub use area::{Area, Blue, BlueCell, Green, GreenCross, Orange, Purple, Yellow, YellowCell};
pub use color::Color;
pub use describe::Described;
pub use effect::{BlackOption, Choice, CrossTarget, Effect, WriteTarget};
pub use game::{Phase, PrettyClever, PENDING};
pub use sheet::{Placement, Sheet};
