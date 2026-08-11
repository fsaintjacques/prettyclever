//! Rendering an action as a line of a game log.
//!
//! An action names a die and a mark; what makes it readable — the die's face,
//! which slot of a track a write lands in, and above all whether a lattice
//! mark *circles or crosses* — lives in the game state, so the rendering
//! borrows both. The lattice is the reason this layer cannot be a `Display`
//! impl on [`Action`]: the mark is relative, and only the sheet knows what it
//! will do.

use core::fmt;

use clever_core::Die;

use crate::action::{Action, BonusPick};
use crate::area::LatticeState;
use crate::color::Color;
use crate::effect::Choice;
use crate::game::{Phase, TwiceAsClever};
use crate::sheet::Placement;

/// One action, rendered against the state it is legal in.
///
/// Returned by [`Solitaire::describe`](clever_core::Solitaire::describe); it
/// borrows the game, so it must be formatted before the next action is
/// applied.
#[derive(Clone, Copy, Debug)]
pub struct Described<'a> {
    game: &'a TwiceAsClever,
    action: Action,
}

impl<'a> Described<'a> {
    pub(crate) const fn new(game: &'a TwiceAsClever, action: Action) -> Self {
        Described { game, action }
    }

    /// `silver 4` — a die and the face it currently shows.
    fn die(&self, f: &mut fmt::Formatter<'_>, die: Die) -> fmt::Result {
        match Color::of(die) {
            Some(color) => write!(f, "{color} {}", self.game.mat().face(die)),
            None => write!(f, "{die}"),
        }
    }

    /// Where a mark lands, named the way the printed sheet names it.
    fn mark(&self, f: &mut fmt::Formatter<'_>, place: Placement) -> fmt::Result {
        let sheet = self.game.sheet();
        match place {
            Placement::Silver(cell) => {
                write!(f, "silver {} ({} row)", cell.value(), cell.row())
            }
            Placement::Yellow(cell) => {
                // The mark is relative, so what it writes depends on the cell.
                let verb = match sheet.yellow().next_state(cell) {
                    Some(LatticeState::Crossed) => "cross",
                    _ => "circle",
                };
                write!(
                    f,
                    "{verb} yellow {} (row {}, col {})",
                    cell.value(),
                    cell.row() + 1,
                    cell.column() + 1
                )
            }
            Placement::Blue(sum) => {
                write!(f, "blue slot {} = {sum}", sheet.blue().next_slot() + 1)
            }
            Placement::Green(face) => {
                let slot = sheet.green().next_slot();
                let value = face.score() * sheet.green().next_multiplier().unwrap_or(1);
                write!(f, "green slot {} = {value}", slot + 1)
            }
            Placement::Pink(face) => {
                write!(f, "pink slot {} = {face}", sheet.pink().next_slot() + 1)
            }
        }
    }
}

impl fmt::Display for Described<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.action {
            Action::Pick {
                die,
                place: Some(place),
            } => {
                f.write_str("takes ")?;
                self.die(f, die)?;
                f.write_str(" → ")?;
                self.mark(f, place)
            }
            Action::Pick { die, place: None } => {
                f.write_str("takes ")?;
                self.die(f, die)?;
                f.write_str(" (no mark)")
            }
            Action::Skip => f.write_str("forfeits the roll"),
            Action::Reroll => f.write_str("re-rolls"),
            Action::Return { die } => {
                f.write_str("returns ")?;
                self.die(f, die)?;
                f.write_str(" to the pool")
            }
            Action::Proceed => f.write_str("rolls on"),
            Action::Plus1 { die, place } => {
                f.write_str("+1: ")?;
                self.die(f, die)?;
                f.write_str(" → ")?;
                self.mark(f, place)
            }
            Action::EndTurn => f.write_str(match self.game.phase() {
                Phase::EndTurn => "ends the active turn",
                _ => "ends the round",
            }),
            Action::PassivePick { die, place } => {
                f.write_str("platter: ")?;
                self.die(f, die)?;
                f.write_str(" → ")?;
                self.mark(f, place)
            }
            Action::PassiveSkip => f.write_str("declines the platter"),
            Action::Bonus(BonusPick::Cell(place)) => {
                // The queue head says whether this cell answers a colored `?`
                // or a platter-chain row choice; they read very differently in
                // a log, so the head is worth consulting.
                let lead = match self.game.pending().next() {
                    Some(Choice::SilverRow(_)) => "chain mark → ",
                    _ => "? bonus → ",
                };
                f.write_str(lead)?;
                self.mark(f, place)
            }
            Action::Bonus(BonusPick::Black(target)) => write!(f, "bonus: ? in {target}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::area::{
        Area, Blue, Green, LatticeCell, Pink, Silver, SilverCell, SilverRow, Yellow,
    };
    use crate::effect::{Effect, FreeTarget};
    use crate::sheet::Sheet;
    use clever_core::{Face, Pips, SeedableRng, Solitaire};

    type Rng = rand_xoshiro::Xoshiro256PlusPlus;

    fn face(v: u8) -> Face {
        Face::new(v).expect("a die face")
    }

    /// A game with the faces the TypeScript description suite uses:
    /// white 1, yellow 3, blue 2, green 4, pink 5, silver 4.
    fn game() -> TwiceAsClever {
        let mut game = TwiceAsClever::new(&mut Rng::seed_from_u64(1));
        for (i, v) in [1u8, 3, 2, 4, 5, 4].into_iter().enumerate() {
            game.set_face(Die::new(i as u8), face(v));
        }
        game
    }

    fn say(game: &TwiceAsClever, action: Action) -> String {
        game.describe(action).to_string()
    }

    /// Everything the game would say at its current node.
    fn texts(game: &TwiceAsClever) -> Vec<String> {
        let mut list = clever_core::Actions::new();
        game.actions_into(&mut list);
        list.iter().map(|&a| say(game, a)).collect()
    }

    #[test]
    fn a_pick_names_the_die_its_face_and_the_mark() {
        let said = texts(&game());
        assert!(said.contains(&"takes yellow 3 → circle yellow 3 (row 1, col 2)".into()));
        assert!(said.contains(&"takes blue 2 → blue slot 1 = 3".into()));
        assert!(said.contains(&"takes green 4 → green slot 1 = 8".into()));
        assert!(said.contains(&"takes pink 5 → pink slot 1 = 5".into()));
        assert!(said.contains(&"takes silver 4 → silver 4 (yellow row)".into()));
        assert!(said.contains(&"takes silver 4 → silver 4 (pink row)".into()));
    }

    #[test]
    fn a_lattice_mark_says_whether_it_circles_or_crosses() {
        let mut g = game();
        let mut yellow = Yellow::new();
        // The first printed 3 is circled; the second is not.
        let _ = yellow.apply(LatticeCell::at(1).expect("a real cell"));
        g.set_sheet(Sheet::from_areas(
            Silver::new(),
            yellow,
            Blue::new(),
            Green::new(),
            Pink::new(),
        ));
        let said = texts(&g);
        assert!(said.contains(&"takes yellow 3 → cross yellow 3 (row 1, col 2)".into()));
        assert!(said.contains(&"takes yellow 3 → circle yellow 3 (row 3, col 4)".into()));
    }

    #[test]
    fn a_green_mark_names_the_multiplied_value() {
        let mut g = game();
        g.set_sheet(Sheet::from_areas(
            Silver::new(),
            Yellow::new(),
            Blue::new(),
            // The next slot is index 3, a ×1.
            Green::from_faces(&[face(1), face(1), face(1)]),
            Pink::new(),
        ));
        assert_eq!(
            say(
                &g,
                Action::Pick {
                    die: Color::Green.die(),
                    place: Some(Placement::Green(face(4)))
                }
            ),
            "takes green 4 → green slot 4 = 4"
        );
    }

    #[test]
    fn the_return_window_speaks_for_itself() {
        let mut g = game();
        g.grant(Effect::Return);
        g.set_loc(Color::Pink.die(), clever_core::Loc::Platter);
        g.set_phase(Phase::PreRoll);
        let said = texts(&g);
        assert!(said.contains(&"returns pink 5 to the pool".into()));
        assert!(said.contains(&"rolls on".into()));
    }

    #[test]
    fn a_chain_mark_and_a_colored_question_read_differently() {
        let mut g = game();
        let mut grid = Silver::new();
        let _ = grid.apply(SilverCell::at(SilverRow::Yellow, face(4)));
        g.set_sheet(Sheet::from_areas(
            grid,
            Yellow::new(),
            Blue::new(),
            Green::new(),
            Pink::new(),
        ));
        g.grant(Effect::SilverMark(face(4), None));
        assert_eq!(
            texts(&g),
            vec![
                "chain mark → silver 4 (blue row)",
                "chain mark → silver 4 (green row)",
                "chain mark → silver 4 (pink row)",
            ]
        );
    }

    #[test]
    fn a_colored_question_names_the_mark_it_would_make() {
        let mut g = game();
        g.grant(Effect::Free(FreeTarget::Silver));
        assert!(texts(&g).contains(&"? bonus → silver 1 (yellow row)".into()));

        let mut g = game();
        g.grant(Effect::Free(FreeTarget::Blue));
        let said = texts(&g);
        assert!(said.contains(&"? bonus → blue slot 1 = 2".into()));
        assert!(said.contains(&"? bonus → blue slot 1 = 12".into()));

        let mut g = game();
        g.grant(Effect::Free(FreeTarget::Green));
        assert!(texts(&g).contains(&"? bonus → green slot 1 = 12".into()));

        let mut g = game();
        g.grant(Effect::Free(FreeTarget::Pink));
        assert!(texts(&g).contains(&"? bonus → pink slot 1 = 6".into()));

        let mut g = game();
        g.grant(Effect::Free(FreeTarget::Yellow));
        assert!(texts(&g).contains(&"? bonus → circle yellow 3 (row 1, col 2)".into()));
    }

    #[test]
    fn the_black_question_names_its_five_options() {
        let mut g = game();
        g.grant(Effect::Black);
        let said = texts(&g);
        assert!(said.contains(&"bonus: ? in silver".into()));
        assert!(said.contains(&"bonus: ? in pink".into()));
        assert_eq!(said.len(), 5);
    }

    #[test]
    fn the_turn_enders_say_which_turn_they_end() {
        let mut g = game();
        g.set_phase(Phase::EndTurn);
        assert_eq!(say(&g, Action::EndTurn), "ends the active turn");
        g.set_phase(Phase::PassiveEndTurn);
        assert_eq!(say(&g, Action::EndTurn), "ends the round");
    }

    #[test]
    fn the_rest_speak_for_themselves() {
        let g = game();
        assert_eq!(say(&g, Action::Skip), "forfeits the roll");
        assert_eq!(say(&g, Action::Reroll), "re-rolls");
        assert_eq!(say(&g, Action::PassiveSkip), "declines the platter");
        assert_eq!(
            say(
                &g,
                Action::Pick {
                    die: Color::White.die(),
                    place: None
                }
            ),
            "takes white 1 (no mark)"
        );
        assert_eq!(
            say(
                &g,
                Action::PassivePick {
                    die: Color::Pink.die(),
                    place: Placement::Pink(face(5))
                }
            ),
            "platter: pink 5 → pink slot 1 = 5"
        );
        assert_eq!(
            say(
                &g,
                Action::Plus1 {
                    die: Color::Blue.die(),
                    place: Placement::Blue(Pips::new(3).unwrap())
                }
            ),
            "+1: blue 2 → blue slot 1 = 3"
        );
    }
}
