//! Rendering an action as a line of a game log.
//!
//! An action names a die and a mark; what makes it readable — the die's face,
//! the cell's printed value, which slot of a track the write lands in — lives
//! in the game state, so the rendering borrows both.

use core::fmt;

use clever_core::Die;

use crate::action::{Action, BonusPick};
use crate::color::Color;
use crate::game::{Phase, PrettyClever};
use crate::sheet::Placement;

/// One action, rendered against the state it is legal in.
///
/// Returned by [`Solitaire::describe`](clever_core::Solitaire::describe); it
/// borrows the game, so it must be formatted before the next action is
/// applied.
#[derive(Clone, Copy, Debug)]
pub struct Described<'a> {
    game: &'a PrettyClever,
    action: Action,
}

impl<'a> Described<'a> {
    pub(crate) const fn new(game: &'a PrettyClever, action: Action) -> Self {
        Described { game, action }
    }

    /// `yellow 4` — a die and the face it currently shows.
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
            Placement::Yellow(cell) => write!(
                f,
                "yellow {} (row {}, col {})",
                cell.value(),
                cell.row() + 1,
                cell.column() + 1
            ),
            Placement::Blue(cell) => write!(f, "blue {}", cell.value()),
            Placement::Green => write!(f, "green slot {}", sheet.green().crossed() + 1),
            Placement::Orange(face) => {
                write!(f, "orange slot {} = {face}", sheet.orange().next_slot() + 1)
            }
            Placement::Purple(face) => {
                write!(f, "purple slot {} = {face}", sheet.purple().next_slot() + 1)
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
                f.write_str("bonus X → ")?;
                self.mark(f, place)
            }
            Action::Bonus(BonusPick::Black(option)) => write!(f, "bonus: {option}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::area::{Blue, BlueCell, Green, Orange, Purple, Yellow};
    use crate::effect::BlackOption;
    use crate::sheet::Sheet;
    use clever_core::{Face, Pips, SeedableRng, Solitaire};

    type Rng = rand_xoshiro::Xoshiro256PlusPlus;

    fn face(v: u8) -> Face {
        Face::new(v).unwrap()
    }

    fn game() -> PrettyClever {
        let mut game = PrettyClever::new(&mut Rng::seed_from_u64(1));
        for (i, v) in [3u8, 4, 5, 2, 6, 1].into_iter().enumerate() {
            game.set_face(Die::new(i as u8), face(v));
        }
        game
    }

    fn say(game: &PrettyClever, action: Action) -> String {
        game.describe(action).to_string()
    }

    #[test]
    fn a_pick_names_the_die_its_face_and_the_cell() {
        let g = game();
        let yellow = g.die_marks(Color::Yellow.die())[0];
        assert_eq!(
            say(
                &g,
                Action::Pick {
                    die: Color::Yellow.die(),
                    place: Some(yellow)
                }
            ),
            "takes yellow 4 → yellow 4 (row 3, col 4)"
        );
        assert_eq!(
            say(
                &g,
                Action::Pick {
                    die: Color::White.die(),
                    place: None
                }
            ),
            "takes white 3 (no mark)"
        );
    }

    #[test]
    fn a_blue_mark_names_the_sum_not_the_die() {
        let g = game();
        // blue 5 + white 3 = 8.
        assert_eq!(g.blue_value(), Pips::new(8).unwrap());
        let place = Placement::Blue(BlueCell::of(Pips::new(8).unwrap()));
        assert_eq!(
            say(
                &g,
                Action::Pick {
                    die: Color::Blue.die(),
                    place: Some(place)
                }
            ),
            "takes blue 5 → blue 8"
        );
    }

    #[test]
    fn a_track_mark_names_the_slot_it_lands_in() {
        let mut g = game();
        g.set_sheet(Sheet::from_areas(
            Yellow::new(),
            Blue::new(),
            Green::from_crossed(4),
            Orange::from_faces(&[face(1), face(2)]),
            Purple::new(),
        ));
        assert_eq!(
            say(
                &g,
                Action::Pick {
                    die: Color::Green.die(),
                    place: Some(Placement::Green)
                }
            ),
            "takes green 2 → green slot 5"
        );
        assert_eq!(
            say(
                &g,
                Action::Plus1 {
                    die: Color::Orange.die(),
                    place: Placement::Orange(face(6))
                }
            ),
            "+1: orange 6 → orange slot 3 = 6"
        );
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
            say(&g, Action::Bonus(BonusPick::Black(BlackOption::Green))),
            "bonus: X next in green"
        );
        let cell = g.sheet().yellow().open().next().unwrap();
        assert_eq!(
            say(&g, Action::Bonus(BonusPick::Cell(Placement::Yellow(cell)))),
            "bonus X → yellow 3 (row 1, col 1)"
        );
    }
}
