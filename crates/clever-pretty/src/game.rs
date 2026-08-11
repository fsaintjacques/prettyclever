//! The phase machine and the bonus cascade.
//!
//! Per game on purpose: this is precisely where the two Clever titles differ.
//! *Twice as Clever* adds a pre-roll return window, resets its +1 flags per
//! round rather than per turn, and forbids a wasted pick with the silver die.
//! Sharing this machine is what forces a hardcoded `'silver'` into a
//! prototype's core.

#[cfg(test)]
use clever_core::Face;
use clever_core::{
    rate, Actions, Bar, Breakdown, Die, DieSet, Error, Loc, Mat, Node, Pending, Pips, Rating,
    RngCore, Round, Score, Solitaire, Stats,
};

use crate::action::{Action, BonusPick};
use crate::color::Color;
use crate::describe::Described;
use crate::effect::{BlackOption, Choice, Effect};
use crate::sheet::{DieMarks, Placement, Sheet};

/// How many decisions can wait at once.
///
/// Measured, not assumed: over 20 000 uniform-random games the queue never
/// holds more than **two**, and a one-ply search that prefers the deepest
/// queue does no better. That matches the cascade graph — a single mark fires
/// at most two bonuses, only six cells and groups on the whole sheet grant a
/// `cross any`, and every step of a chain consumes a cell — so the reachable
/// depth is a small single digit.
///
/// Eight is kept rather than tightened: it is the bound PR 1 defended, an
/// entry is one byte, and *Twice as Clever*'s platter chain queues up to five
/// row choices from one pick.
pub const PENDING: usize = 8;

/// Where in a round the game stands.
///
/// The two `Roll` phases are the game's only chance nodes; everything else is
/// a decision. There is no pre-roll return window, because this sheet prints
/// no return bar — inertness by *use*, not by a flag on shared data.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Phase {
    /// Chance: re-roll the pool.
    Roll,
    /// Decision: pick a die, re-roll, or forfeit the roll.
    Pick,
    /// Decision: spend +1s, then end the active turn.
    EndTurn,
    /// Chance: roll all six, the three lowest to the platter.
    PassiveRoll,
    /// Decision: take one platter die, or decline.
    PassivePick,
    /// Decision: spend +1s, then end the round.
    PassiveEndTurn,
    /// The game has finished.
    Over,
}

/// Which action bar a [`Effect::Reroll`] or [`Effect::Plus1`] circles.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum BarKind {
    Reroll,
    Plus1,
}

/// A solo game of *That's Pretty Clever*.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PrettyClever {
    round: Round,
    phase: Phase,
    picks: u8,
    mat: Mat<6>,
    sheet: Sheet,
    reroll: Bar,
    plus1: Bar,
    plus1_used: DieSet,
    foxes: u8,
    pending: Pending<Choice, PENDING>,
    stats: Stats,
}

/// Whether a bonus can still be taken, read off the sheet alone.
///
/// A free function rather than a method so it can be handed to
/// [`Pending::retain_resolvable`] while the queue is borrowed mutably.
fn resolvable(sheet: &Sheet, effect: Effect) -> bool {
    match effect {
        Effect::CrossAny(t) => sheet.open(t).next().is_some(),
        Effect::CrossNextGreen => sheet.cross_next_green().is_some(),
        Effect::WriteNext(t, f) => sheet.write_next(t, f).is_some(),
        Effect::Black => BlackOption::ALL
            .iter()
            .any(|o| resolvable(sheet, o.effect())),
        Effect::Fox | Effect::Reroll | Effect::Plus1 => true,
    }
}

impl PrettyClever {
    /// How many rounds the solo game lasts.
    pub const ROUNDS: Round = match Round::new(6) {
        Some(r) => r,
        None => Round::FIRST,
    };

    /// How many dice an active turn may place.
    pub const PICKS_PER_TURN: u8 = 3;

    /// How many slots each action bar prints.
    pub const BAR_SLOTS: u8 = 7;

    /// What the round track grants at the start of each round.
    const ROUND_BONUS: [Option<Effect>; 6] = [
        Some(Effect::Reroll),
        Some(Effect::Plus1),
        Some(Effect::Reroll),
        Some(Effect::Black),
        None,
        None,
    ];

    /// The solo rating table, highest first.
    pub const RATING: [Rating; 9] = [
        Rating::new(281, "You're so clever!"),
        Rating::new(260, "Are you Einstein?"),
        Rating::new(240, "What a genius!"),
        Rating::new(220, "Impressive!"),
        Rating::new(200, "Hats off to you!"),
        Rating::new(180, "Great result!"),
        Rating::new(160, "That was pretty good."),
        Rating::new(140, "Not bad… you could do better."),
        Rating::new(Score::MIN, "Try harder!"),
    ];

    /// A new game, round 1, dice already rolled.
    ///
    /// [`Mat::new`] rolls, so the first node is the opening pick rather than a
    /// chance node: rolling again here would burn a roll for nothing.
    pub fn new(rng: &mut impl RngCore) -> Self {
        let mut game = PrettyClever {
            round: Round::FIRST,
            phase: Phase::Pick,
            picks: 0,
            mat: Mat::new(rng),
            sheet: Sheet::new(),
            reroll: Bar::new(Self::BAR_SLOTS),
            plus1: Bar::new(Self::BAR_SLOTS),
            plus1_used: DieSet::new(),
            foxes: 0,
            pending: Pending::new(),
            stats: Stats::new(),
        };
        game.grant_round_bonus();
        game.prune();
        game
    }

    /// Where in the round the game stands.
    #[must_use]
    pub const fn phase(&self) -> Phase {
        self.phase
    }

    /// How many dice the active turn has placed.
    #[must_use]
    pub const fn picks(&self) -> u8 {
        self.picks
    }

    /// The dice, their faces and where they sit.
    #[must_use]
    pub const fn mat(&self) -> &Mat<6> {
        &self.mat
    }

    /// The score sheet.
    #[must_use]
    pub const fn sheet(&self) -> &Sheet {
        &self.sheet
    }

    /// The re-roll bar.
    #[must_use]
    pub const fn reroll_bar(&self) -> &Bar {
        &self.reroll
    }

    /// The +1 bar.
    #[must_use]
    pub const fn plus1_bar(&self) -> &Bar {
        &self.plus1
    }

    /// The dice already spent on a +1 this turn. Cleared at the end of every
    /// active turn *and* on a round advance — this game's +1 scope is the
    /// turn, where *Twice*'s is the round.
    #[must_use]
    pub const fn plus1_used(&self) -> DieSet {
        self.plus1_used
    }

    /// How many foxes have been collected.
    #[must_use]
    pub const fn foxes(&self) -> u8 {
        self.foxes
    }

    /// The decisions waiting to be resolved, head first.
    pub fn pending(&self) -> impl Iterator<Item = Choice> + '_ {
        self.pending.iter()
    }

    /// The value blue is marked at: blue + white, whichever die is spent
    /// there and wherever either die currently sits.
    #[must_use]
    pub fn blue_value(&self) -> Pips {
        Pips::of(
            self.mat.face(Color::Blue.die()),
            self.mat.face(Color::White.die()),
        )
    }

    /// The rulebook's label for the score as it stands.
    #[must_use]
    pub fn rating(&self) -> &'static str {
        rate(&Self::RATING, self.sheet.score(self.foxes).total)
    }

    /// Every mark a die can make right now, at its current face.
    #[must_use]
    pub fn die_marks(&self, die: Die) -> DieMarks {
        match Color::of(die) {
            Some(color) => self
                .sheet
                .marks(color, self.mat.face(die), self.blue_value()),
            None => DieMarks::new(),
        }
    }

    /// Fill `out` with the legal actions. The allocation-free form of
    /// [`Solitaire::node`] for a hot loop that reuses one buffer.
    pub fn actions_into(&self, out: &mut Actions<Action>) {
        out.clear();
        if self.phase == Phase::Over {
            return;
        }
        if let Some(head) = self.pending.head() {
            match head {
                Choice::CrossAny(target) => {
                    for place in self.sheet.open(target) {
                        out.push(Action::Bonus(BonusPick::Cell(place)));
                    }
                }
                Choice::Black => {
                    for option in BlackOption::ALL {
                        if resolvable(&self.sheet, option.effect()) {
                            out.push(Action::Bonus(BonusPick::Black(option)));
                        }
                    }
                }
            }
            return;
        }
        match self.phase {
            Phase::Roll | Phase::PassiveRoll | Phase::Over => {}
            Phase::Pick => self.pick_actions(out),
            Phase::EndTurn | Phase::PassiveEndTurn => self.end_turn_actions(out),
            Phase::PassivePick => self.passive_pick_actions(out),
        }
    }

    /// The active pick: re-roll, take a die, or — when *no* die can be placed
    /// at all — forfeit the roll.
    ///
    /// A die with no placement is still offered as a **wasted pick**. The ban
    /// on wasting a particular die is a *Twice* rule about its silver die and
    /// has no place here.
    fn pick_actions(&self, out: &mut Actions<Action>) {
        if self.reroll.available() > 0 && self.mat.pool().next().is_some() {
            out.push(Action::Reroll);
        }
        let mut any = false;
        for die in self.mat.pool() {
            let marks = self.die_marks(die);
            if marks.is_empty() {
                out.push(Action::Pick { die, place: None });
            } else {
                any = true;
                for place in marks {
                    out.push(Action::Pick {
                        die,
                        place: Some(place),
                    });
                }
            }
        }
        if !any {
            out.push(Action::Skip);
        }
    }

    /// The +1 window, at the end of an active or a passive turn: any die not
    /// yet spent this turn, wherever it sits, at its current face.
    fn end_turn_actions(&self, out: &mut Actions<Action>) {
        if self.plus1.available() > 0 {
            for die in self.mat.dice() {
                if self.plus1_used.contains(die) {
                    continue;
                }
                for place in self.die_marks(die) {
                    out.push(Action::Plus1 { die, place });
                }
            }
        }
        out.push(Action::EndTurn);
    }

    /// The passive pick: one of the three platter dice, or none of them.
    fn passive_pick_actions(&self, out: &mut Actions<Action>) {
        for die in self.mat.platter() {
            for place in self.die_marks(die) {
                out.push(Action::PassivePick { die, place });
            }
        }
        out.push(Action::PassiveSkip);
    }

    /// Roll the dice a [`Node::Chance`] is waiting on. A no-op elsewhere.
    pub fn roll_dice(&mut self, rng: &mut impl RngCore) {
        match self.phase {
            Phase::Roll => {
                self.mat.roll_pool(rng);
                self.phase = Phase::Pick;
            }
            Phase::PassiveRoll => {
                let _ = self.mat.passive_roll(rng);
                self.phase = Phase::PassivePick;
            }
            _ => debug_assert!(false, "rolled at a decision node"),
        }
    }

    // -- transitions ---------------------------------------------------------

    fn execute(&mut self, action: Action) {
        match action {
            Action::Bonus(pick) => self.resolve(pick),
            Action::Reroll => {
                let spent = self.reroll.spend();
                debug_assert!(spent, "a re-roll was offered with none banked");
                self.stats.rerolls_used += 1;
                self.phase = Phase::Roll;
            }
            Action::Pick { die, place } => {
                // The moved set is *Twice*'s platter chain; this game has no
                // use for it.
                let _moved = self.mat.take(die);
                self.picks += 1;
                if let Some(place) = place {
                    self.place(place);
                }
                self.after_pick();
            }
            Action::Skip => {
                self.picks += 1;
                self.stats.skips += 1;
                self.after_pick();
            }
            Action::Plus1 { die, place } => {
                let spent = self.plus1.spend();
                debug_assert!(spent, "a +1 was offered with none banked");
                self.stats.plus1_spent += 1;
                self.plus1_used.insert(die);
                self.place(place);
            }
            Action::EndTurn => self.end_turn(),
            Action::PassivePick { place, .. } => {
                self.place(place);
                self.phase = Phase::PassiveEndTurn;
            }
            Action::PassiveSkip => self.phase = Phase::PassiveEndTurn,
        }
    }

    /// Resolve the head of the queue. Taking a black option queues *its*
    /// effect ahead of everything still waiting.
    fn resolve(&mut self, pick: BonusPick) {
        let Some(head) = self.pending.pop() else {
            return;
        };
        match (head, pick) {
            (Choice::CrossAny(_), BonusPick::Cell(place)) => self.place(place),
            (Choice::Black, BonusPick::Black(option)) => self.fire(option.effect(), true),
            _ => debug_assert!(false, "a bonus pick that does not match its decision"),
        }
    }

    /// Mark the sheet and resolve the bonus cascade.
    ///
    /// Direct recursion, and it cannot loop: every arm either terminates or
    /// consumes a cell, and there are finitely many cells.
    fn place(&mut self, place: Placement) {
        for effect in self.sheet.apply(place) {
            self.fire(effect, false);
        }
    }

    fn fire(&mut self, effect: Effect, front: bool) {
        match effect {
            Effect::Fox => self.foxes += 1,
            Effect::Reroll => self.unlock(BarKind::Reroll),
            Effect::Plus1 => self.unlock(BarKind::Plus1),

            // Applied at once, and lost at once when the target will not take
            // them.
            Effect::CrossNextGreen => match self.sheet.cross_next_green() {
                Some(place) => self.place(place),
                None => self.stats.bonuses_lost += 1,
            },
            Effect::WriteNext(target, face) => match self.sheet.write_next(target, face) {
                Some(place) => self.place(place),
                None => self.stats.bonuses_lost += 1,
            },

            // Decisions: queued, or lost when they are already unresolvable.
            Effect::CrossAny(target) => self.queue(Choice::CrossAny(target), front),
            Effect::Black => self.queue(Choice::Black, front),
        }
    }

    /// Circle a bar slot. This sheet prints no end-of-bar bonus, so
    /// [`Unlock::Filled`](clever_core::Unlock::Filled) is an ordinary gain and
    /// only the overflow past the seventh slot is a loss.
    fn unlock(&mut self, kind: BarKind) {
        let bar = match kind {
            BarKind::Reroll => &mut self.reroll,
            BarKind::Plus1 => &mut self.plus1,
        };
        if bar.unlock().is_overflow() {
            self.stats.bonuses_lost += 1;
        }
    }

    fn queue(&mut self, choice: Choice, front: bool) {
        if !resolvable(&self.sheet, choice.effect()) {
            self.stats.bonuses_lost += 1;
            return;
        }
        let queued = if front {
            self.pending.push_front(choice)
        } else {
            self.pending.push_back(choice)
        };
        if queued.is_err() {
            debug_assert!(false, "PENDING is too small for this game's cascades");
            self.stats.bonuses_lost += 1;
        }
    }

    /// Drop decisions that became impossible while they waited, and count
    /// them. Runs after every action, which is the only place the sheet
    /// changes under a queued decision.
    fn prune(&mut self) {
        let PrettyClever {
            pending,
            sheet,
            stats,
            ..
        } = self;
        stats.lose_bonuses(pending.retain_resolvable(|c| resolvable(sheet, c.effect())));
    }

    fn after_pick(&mut self) {
        self.phase = if self.picks >= Self::PICKS_PER_TURN || self.mat.count(Loc::Pool) == 0 {
            Phase::EndTurn
        } else {
            Phase::Roll
        };
    }

    /// End the active turn (→ the passive turn) or the passive one (→ the
    /// next round, or the end of the game).
    ///
    /// `picks` resets on the round advance only: the active turn's three picks
    /// are spent for the whole round, and the passive turn does not restore
    /// them.
    fn end_turn(&mut self) {
        if self.phase == Phase::EndTurn {
            self.mat.reset();
            self.plus1_used.clear();
            self.phase = Phase::PassiveRoll;
            return;
        }
        if self.round.is_last(Self::ROUNDS) {
            self.phase = Phase::Over;
            return;
        }
        self.round.advance(Self::ROUNDS);
        self.picks = 0;
        self.mat.reset();
        self.plus1_used.clear();
        self.phase = Phase::Roll;
        self.grant_round_bonus();
    }

    fn grant_round_bonus(&mut self) {
        if let Some(effect) = Self::ROUND_BONUS[self.round.index()] {
            self.fire(effect, false);
        }
    }
}

impl Solitaire for PrettyClever {
    type Action = Action;

    fn node(&self) -> Node<Action> {
        if self.phase == Phase::Over {
            return Node::Over;
        }
        if self.pending.is_empty() && matches!(self.phase, Phase::Roll | Phase::PassiveRoll) {
            return Node::Chance;
        }
        let mut actions = Actions::new();
        self.actions_into(&mut actions);
        debug_assert!(!actions.is_empty(), "a decision node with no actions");
        Node::Decision(actions)
    }

    fn apply(&mut self, action: Action) -> Result<(), Error> {
        if matches!(action, Action::Bonus(_)) && self.pending.is_empty() {
            return Err(Error::NotADecision);
        }
        let mut legal = Actions::new();
        self.actions_into(&mut legal);
        if !legal.contains(&action) {
            return Err(Error::Illegal);
        }
        self.execute(action);
        self.prune();
        Ok(())
    }

    fn roll(&mut self, rng: &mut dyn RngCore) {
        let mut rng = rng;
        self.roll_dice(&mut rng);
    }

    fn score(&self) -> Breakdown {
        self.sheet.score(self.foxes)
    }

    fn round(&self) -> Round {
        self.round
    }

    fn stats(&self) -> &Stats {
        &self.stats
    }

    fn describe(&self, action: Action) -> impl core::fmt::Display {
        Described::new(self, action)
    }
}

/// Fixture setters for the crate's own tests. Not part of the public API: a
/// facade restoring a saved game rebuilds it through [`PrettyClever::new`] and
/// the areas' `from_*` constructors.
#[cfg(test)]
impl PrettyClever {
    pub(crate) fn set_face(&mut self, die: Die, face: Face) {
        self.mat.set_face(die, face);
    }

    pub(crate) fn set_sheet(&mut self, sheet: Sheet) {
        self.sheet = sheet;
    }

    pub(crate) fn set_phase(&mut self, phase: Phase) {
        self.phase = phase;
    }
}

/// `Face::new(v).unwrap()`, for the fixtures below.
#[cfg(test)]
fn face(v: u8) -> Face {
    Face::new(v).expect("a die face")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::area::{Area, Blue, BlueCell, Green, Orange, Purple, Yellow, YellowCell};
    use crate::effect::CrossTarget;
    use clever_core::{SeedableRng, Unlock};

    type Rng = rand_xoshiro::Xoshiro256PlusPlus;

    fn rng(seed: u64) -> Rng {
        Rng::seed_from_u64(seed)
    }

    /// A round-1 game in the pick phase with chosen faces, in die order:
    /// white, yellow, blue, green, orange, purple.
    fn picking(faces: [u8; 6]) -> PrettyClever {
        let mut game = PrettyClever::new(&mut rng(0));
        for (i, v) in faces.into_iter().enumerate() {
            game.mat.set_face(Die::new(i as u8), face(v));
        }
        game.phase = Phase::Pick;
        game
    }

    fn actions(game: &PrettyClever) -> Actions<Action> {
        match game.node() {
            Node::Decision(a) => a,
            other => panic!("expected a decision, got {other:?}"),
        }
    }

    fn yellow(i: u8) -> Placement {
        Placement::Yellow(YellowCell::new(i).expect("a markable yellow cell"))
    }

    fn blue(v: u8) -> Placement {
        Placement::Blue(BlueCell::of(Pips::new(v).expect("a blue value")))
    }

    // -- setup ---------------------------------------------------------------

    #[test]
    fn round_one_grants_a_reroll() {
        let game = PrettyClever::new(&mut rng(1));
        assert_eq!(game.reroll_bar().available(), 1);
        assert_eq!(game.plus1_bar().available(), 0);
        assert_eq!(game.round(), Round::FIRST);
        // `Mat::new` rolled, so the opening node is the pick, not a roll.
        assert_eq!(game.phase(), Phase::Pick);
        assert!(!game.node().is_chance());
    }

    #[test]
    fn yellow_starts_with_the_four_printed_crosses() {
        let game = PrettyClever::new(&mut rng(2));
        assert_eq!(game.sheet().yellow().crossed(), 4);
        assert_eq!(game.score().total, 0);
        assert_eq!(game.rating(), "Try harder!");
    }

    // -- placements ----------------------------------------------------------

    #[test]
    fn a_yellow_die_crosses_either_open_cell_of_its_value() {
        let game = picking([2, 4, 2, 2, 2, 2]);
        let cells: Vec<Placement> = game.die_marks(Color::Yellow.die()).into_iter().collect();
        assert_eq!(cells, vec![yellow(11), yellow(14)]);
    }

    #[test]
    fn blue_uses_blue_plus_white_whichever_die_is_placed() {
        // white 3, blue 4 → the cell holding 7.
        let game = picking([3, 1, 4, 1, 1, 1]);
        assert_eq!(game.blue_value(), Pips::new(7).unwrap());
        let from_blue: Vec<Placement> = game
            .die_marks(Color::Blue.die())
            .into_iter()
            .filter(|p| p.area() == Sheet::BLUE)
            .collect();
        assert_eq!(from_blue, vec![blue(7)]);
        let from_white: Vec<Placement> = game
            .die_marks(Color::White.die())
            .into_iter()
            .filter(|p| p.area() == Sheet::BLUE)
            .collect();
        assert_eq!(from_white, vec![blue(7)]);
    }

    #[test]
    fn white_is_wild_for_all_five_areas() {
        let game = picking([5, 1, 1, 1, 1, 1]);
        let areas: Vec<&str> = game
            .die_marks(Color::White.die())
            .into_iter()
            .map(Placement::area)
            .collect();
        for name in [
            Sheet::YELLOW,
            Sheet::BLUE,
            Sheet::GREEN,
            Sheet::ORANGE,
            Sheet::PURPLE,
        ] {
            assert!(areas.contains(&name), "white cannot reach {name}");
        }
    }

    #[test]
    fn green_requires_meeting_the_threshold() {
        let mut game = picking([1, 1, 1, 2, 1, 1]);
        assert_eq!(game.die_marks(Color::Green.die()).len(), 1);
        // Three crossed: the next cell wants a 4.
        game.sheet = Sheet::from_areas(
            Yellow::new(),
            Blue::new(),
            Green::from_crossed(3),
            Orange::new(),
            Purple::new(),
        );
        assert_eq!(game.die_marks(Color::Green.die()).len(), 0);
        game.mat.set_face(Color::Green.die(), face(4));
        assert_eq!(
            game.die_marks(Color::Green.die()).as_slice(),
            &[Placement::Green]
        );
    }

    #[test]
    fn orange_stores_the_die_value_and_multiplies_when_scoring() {
        let mut game = picking([1, 1, 1, 1, 5, 1]);
        game.sheet = Sheet::from_areas(
            Yellow::new(),
            Blue::new(),
            Green::new(),
            Orange::from_faces(&[face(3), face(3), face(3)]),
            Purple::new(),
        );
        // Slot 3 is the first ×2.
        assert_eq!(
            game.die_marks(Color::Orange.die()).as_slice(),
            &[Placement::Orange(face(5))]
        );
        let mut after = game.clone();
        after
            .apply(Action::Pick {
                die: Color::Orange.die(),
                place: Some(Placement::Orange(face(5))),
            })
            .unwrap();
        assert_eq!(after.sheet().orange().score(), 3 + 3 + 3 + 10);
    }

    #[test]
    fn purple_must_ascend_and_resets_after_a_six() {
        let mut game = picking([1, 1, 1, 1, 1, 3]);
        let with = |faces: &[Face]| {
            Sheet::from_areas(
                Yellow::new(),
                Blue::new(),
                Green::new(),
                Orange::new(),
                Purple::from_faces(faces),
            )
        };
        game.sheet = with(&[face(4)]);
        assert_eq!(game.die_marks(Color::Purple.die()).len(), 0, "3 is not > 4");
        game.mat.set_face(Color::Purple.die(), face(5));
        assert_eq!(
            game.die_marks(Color::Purple.die()).as_slice(),
            &[Placement::Purple(face(5))]
        );
        game.sheet = with(&[face(6)]);
        game.mat.set_face(Color::Purple.die(), face(1));
        assert_eq!(
            game.die_marks(Color::Purple.die()).as_slice(),
            &[Placement::Purple(face(1))]
        );
    }

    // -- the silver platter --------------------------------------------------

    #[test]
    fn picking_a_die_sends_strictly_lower_dice_to_the_platter() {
        let mut game = picking([2, 4, 3, 4, 1, 6]);
        game.apply(Action::Pick {
            die: Color::Yellow.die(),
            place: Some(yellow(11)),
        })
        .unwrap();
        let mat = game.mat();
        assert_eq!(mat.loc(Color::White.die()), Loc::Platter);
        assert_eq!(mat.loc(Color::Blue.die()), Loc::Platter);
        assert_eq!(mat.loc(Color::Orange.die()), Loc::Platter);
        assert_eq!(mat.loc(Color::Green.die()), Loc::Pool, "equal faces stay");
        assert_eq!(mat.loc(Color::Purple.die()), Loc::Pool);
        assert_eq!(mat.loc(Color::Yellow.die()), Loc::Field);
        assert_eq!(game.phase(), Phase::Roll);
    }

    #[test]
    fn the_turn_ends_early_when_no_dice_remain() {
        let mut game = picking([1, 1, 1, 1, 1, 6]);
        game.apply(Action::Pick {
            die: Color::Purple.die(),
            place: Some(Placement::Purple(face(6))),
        })
        .unwrap();
        assert_eq!(game.phase(), Phase::EndTurn, "everything else was lower");
    }

    // -- bonus cascades ------------------------------------------------------

    #[test]
    fn completing_yellow_row_two_writes_an_orange_four() {
        let mut game = picking([1, 2, 1, 1, 1, 1]);
        // Row 1 holds cells 4..7; 5 and 7 are crossed and 6 is printed.
        game.sheet = Sheet::from_areas(
            Yellow::from_bits(0b1010_0000_1010_0000),
            Blue::new(),
            Green::new(),
            Orange::new(),
            Purple::new(),
        );
        game.apply(Action::Pick {
            die: Color::Yellow.die(),
            place: Some(yellow(4)),
        })
        .unwrap();
        assert_eq!(game.sheet().orange().faces(), &[face(4)]);
    }

    #[test]
    fn completing_the_yellow_diagonal_grants_a_plus_one() {
        let mut game = picking([1, 6, 1, 1, 1, 1]);
        // Diagonal cells 0, 5 and 10 crossed; 15 open and showing a 6.
        game.sheet = Sheet::from_areas(
            Yellow::from_bits(0b0000_0100_0010_0001),
            Blue::new(),
            Green::new(),
            Orange::new(),
            Purple::new(),
        );
        game.apply(Action::Pick {
            die: Color::Yellow.die(),
            place: Some(yellow(15)),
        })
        .unwrap();
        assert_eq!(game.plus1_bar().available(), 1);
        assert_eq!(game.foxes(), 0, "row 3 is not complete");
    }

    #[test]
    fn a_yellow_x_bonus_offers_every_open_yellow_cell() {
        let mut game = picking([1, 1, 4, 1, 1, 1]); // blue + white = 5
        game.sheet = Sheet::from_areas(
            Yellow::new(),
            // Blue row 1 is 5 6 7 8; 6, 7 and 8 are crossed.
            Blue::from_bits(0b0000_0111_0000),
            Green::new(),
            Orange::new(),
            Purple::new(),
        );
        game.apply(Action::Pick {
            die: Color::Blue.die(),
            place: Some(blue(5)),
        })
        .unwrap();
        assert_eq!(game.pending().count(), 1);
        let list = actions(&game);
        assert_eq!(list.len(), 12, "twelve open yellow cells");
        assert!(list.iter().all(|a| matches!(a, Action::Bonus(_))));
        let first = list[0];
        game.apply(first).unwrap();
        assert_eq!(game.pending().count(), 0);
        assert_eq!(game.sheet().yellow().crossed(), 5);
    }

    #[test]
    fn the_blue_column_five_nine_grants_a_reroll() {
        let mut game = picking([4, 1, 5, 1, 1, 1]); // blue + white = 9
        game.sheet = Sheet::from_areas(
            Yellow::new(),
            Blue::from_bits(1 << 3), // the 5 is crossed
            Green::new(),
            Orange::new(),
            Purple::new(),
        );
        game.apply(Action::Pick {
            die: Color::Blue.die(),
            place: Some(blue(9)),
        })
        .unwrap();
        assert_eq!(game.reroll_bar().available(), 2, "round 1 plus the column");
    }

    #[test]
    fn a_blue_column_chains_into_a_green_cell_bonus() {
        let mut game = picking([2, 1, 4, 1, 1, 1]); // blue + white = 6
        game.sheet = Sheet::from_areas(
            Yellow::new(),
            // Column {2, 6, 10}: the 2 and the 10 are crossed.
            Blue::from_bits((1 << 0) | (1 << 8)),
            Green::from_crossed(6), // the next cross is cell 6, the fox
            Orange::new(),
            Purple::new(),
        );
        game.apply(Action::Pick {
            die: Color::Blue.die(),
            place: Some(blue(6)),
        })
        .unwrap();
        assert_eq!(game.sheet().green().crossed(), 7);
        assert_eq!(game.foxes(), 1);
    }

    #[test]
    fn a_bonus_that_cannot_be_applied_is_lost_and_counted() {
        let mut game = picking([1, 1, 1, 1, 6, 1]);
        game.sheet = Sheet::from_areas(
            Yellow::new(),
            Blue::new(),
            Green::new(),
            // The next orange slot is 9, whose bonus is a purple 6.
            Orange::from_faces(&[face(1); 9]),
            Purple::from_faces(&[face(6); 11]),
        );
        game.apply(Action::Pick {
            die: Color::Orange.die(),
            place: Some(Placement::Orange(face(6))),
        })
        .unwrap();
        assert_eq!(game.stats().bonuses_lost, 1);
    }

    #[test]
    fn an_unlock_past_a_full_bar_is_a_lost_bonus() {
        let mut game = PrettyClever::new(&mut rng(3));
        // Round 1 already circled the first slot.
        for _ in 1..PrettyClever::BAR_SLOTS {
            game.fire(Effect::Reroll, false);
        }
        assert!(game.reroll_bar().is_full());
        assert_eq!(game.stats().bonuses_lost, 0);
        game.fire(Effect::Reroll, false);
        assert_eq!(game.stats().bonuses_lost, 1);
        assert_eq!(game.reroll_bar().circled(), PrettyClever::BAR_SLOTS);
        // The bar itself reports the overflow the game counts.
        let mut bar = Bar::new(1);
        assert_eq!(bar.unlock(), Unlock::Filled);
        assert_eq!(bar.unlock(), Unlock::Overflow);
    }

    #[test]
    fn a_queued_decision_that_becomes_impossible_is_lost_and_counted() {
        let mut game = picking([1, 1, 1, 1, 1, 1]);
        // Blue has one cell left, the one holding the 12.
        game.sheet = Sheet::from_areas(
            Yellow::new(),
            Blue::from_bits(0b0011_1111_1111),
            Green::new(),
            Orange::new(),
            Purple::new(),
        );
        // Two blue Xs queue while both are still resolvable; taking the first
        // fills the grid under the second.
        game.queue(Choice::CrossAny(CrossTarget::Blue), false);
        game.queue(Choice::CrossAny(CrossTarget::Blue), false);
        assert_eq!(game.pending().count(), 2);
        game.apply(Action::Bonus(BonusPick::Cell(blue(12))))
            .unwrap();
        assert_eq!(game.pending().count(), 0);
        assert_eq!(game.stats().bonuses_lost, 1);
    }

    // -- round flow ----------------------------------------------------------

    #[test]
    fn active_then_passive_then_the_next_round() {
        let mut game = PrettyClever::new(&mut rng(42));
        // Force a turn with no placement anywhere so `Skip` is the only pick.
        game.sheet = full_sheet();
        for _ in 0..3 {
            let list = actions(&game);
            assert!(list.contains(&Action::Skip), "{list:?}");
            game.apply(Action::Skip).unwrap();
            if game.phase() == Phase::Roll {
                game.roll_dice(&mut rng(7));
            }
        }
        assert_eq!(game.phase(), Phase::EndTurn);
        assert_eq!(game.stats().skips, 3);
        game.apply(Action::EndTurn).unwrap();
        assert_eq!(game.phase(), Phase::PassiveRoll);
        assert!(game.node().is_chance());

        game.roll_dice(&mut rng(11));
        assert_eq!(game.phase(), Phase::PassivePick);
        assert_eq!(game.mat().count(Loc::Platter), 3);
        let highest = game
            .mat()
            .platter()
            .map(|d| game.mat().face(d))
            .max()
            .unwrap();
        let lowest = game.mat().pool().map(|d| game.mat().face(d)).min().unwrap();
        assert!(highest <= lowest, "the platter holds the three lowest");

        game.apply(Action::PassiveSkip).unwrap();
        assert_eq!(game.phase(), Phase::PassiveEndTurn);
        game.apply(Action::EndTurn).unwrap();
        assert_eq!(game.round().get(), 2);
        assert_eq!(game.picks(), 0, "picks reset on the round advance");
        assert_eq!(game.plus1_bar().available(), 1, "the round-2 bonus");
    }

    /// A sheet with every area full — nothing anywhere can be marked.
    fn full_sheet() -> Sheet {
        Sheet::from_areas(
            Yellow::from_bits(u16::MAX),
            Blue::from_bits(u16::MAX),
            Green::from_crossed(11),
            Orange::from_faces(&[face(1); 11]),
            Purple::from_faces(&[face(1); 11]),
        )
    }

    #[test]
    fn round_four_grants_the_black_choice() {
        let mut game = PrettyClever::new(&mut rng(5));
        game.round = Round::new(3).unwrap();
        game.phase = Phase::PassiveEndTurn;
        game.apply(Action::EndTurn).unwrap();
        assert_eq!(game.round().get(), 4);
        let list = actions(&game);
        assert_eq!(list.len(), 5, "five printed options");
        game.apply(Action::Bonus(BonusPick::Black(BlackOption::Purple)))
            .unwrap();
        assert_eq!(game.sheet().purple().faces(), &[face(6)]);
        assert_eq!(game.pending().count(), 0);
    }

    #[test]
    fn the_black_choice_queues_the_option_it_takes() {
        let mut game = PrettyClever::new(&mut rng(6));
        game.round = Round::new(3).unwrap();
        game.phase = Phase::PassiveEndTurn;
        game.apply(Action::EndTurn).unwrap();
        // A black X into yellow is itself a decision, and it jumps the queue.
        game.apply(Action::Bonus(BonusPick::Black(BlackOption::Yellow)))
            .unwrap();
        assert_eq!(
            game.pending().collect::<Vec<_>>(),
            vec![Choice::CrossAny(CrossTarget::Yellow)]
        );
        assert_eq!(actions(&game).len(), 12);
    }

    #[test]
    fn the_black_choice_only_offers_options_that_still_fit() {
        let mut game = PrettyClever::new(&mut rng(7));
        game.round = Round::new(3).unwrap();
        game.phase = Phase::PassiveEndTurn;
        game.sheet = Sheet::from_areas(
            Yellow::from_bits(u16::MAX),
            Blue::new(),
            Green::from_crossed(11),
            Orange::from_faces(&[face(1); 11]),
            Purple::new(),
        );
        game.apply(Action::EndTurn).unwrap();
        let list = actions(&game);
        assert_eq!(
            list.iter().copied().collect::<Vec<_>>(),
            vec![
                Action::Bonus(BonusPick::Black(BlackOption::Blue)),
                Action::Bonus(BonusPick::Black(BlackOption::Purple)),
            ]
        );
    }

    #[test]
    fn a_round_bonus_with_nowhere_to_go_is_lost() {
        let mut game = PrettyClever::new(&mut rng(8));
        game.round = Round::new(3).unwrap();
        game.phase = Phase::PassiveEndTurn;
        game.sheet = full_sheet();
        game.apply(Action::EndTurn).unwrap();
        assert_eq!(game.pending().count(), 0);
        assert_eq!(game.stats().bonuses_lost, 1);
    }

    #[test]
    fn a_reroll_spends_the_action_and_returns_to_the_roll() {
        let mut game = picking([1, 1, 1, 1, 1, 1]);
        assert_eq!(game.reroll_bar().available(), 1);
        game.apply(Action::Reroll).unwrap();
        assert_eq!(game.reroll_bar().available(), 0);
        assert_eq!(game.stats().rerolls_used, 1);
        assert_eq!(game.phase(), Phase::Roll);
        assert_eq!(game.picks(), 0, "a re-roll is not a pick");
        // With none banked, it is no longer offered.
        game.roll_dice(&mut rng(9));
        assert!(!actions(&game).contains(&Action::Reroll));
    }

    #[test]
    fn a_wasted_pick_is_offered_for_any_die_with_no_placement() {
        let mut game = picking([1, 1, 1, 1, 1, 1]);
        game.sheet = full_sheet();
        let list = actions(&game);
        for die in game.mat().dice() {
            assert!(
                list.contains(&Action::Pick { die, place: None }),
                "{die} has no wasted pick"
            );
        }
        assert!(list.contains(&Action::Skip), "no die can be placed");
    }

    #[test]
    fn skip_is_offered_only_when_no_die_can_be_placed() {
        let game = picking([1, 1, 1, 1, 1, 1]);
        let list = actions(&game);
        assert!(!list.contains(&Action::Skip));
        assert!(list
            .iter()
            .any(|a| matches!(a, Action::Pick { place: Some(_), .. })));
    }

    // -- the +1 window -------------------------------------------------------

    #[test]
    fn a_plus_one_takes_any_die_wherever_it_sits_once_per_turn() {
        let mut game = picking([1, 1, 1, 1, 1, 1]);
        game.fire(Effect::Plus1, false);
        game.mat.set_loc(Color::Orange.die(), Loc::Platter);
        game.mat.set_loc(Color::Purple.die(), Loc::Field);
        game.phase = Phase::EndTurn;
        let list = actions(&game);
        for die in game.mat().dice() {
            assert!(
                list.iter().any(|a| a.die() == Some(die)),
                "{die} is out of the +1 window"
            );
        }
        game.apply(Action::Plus1 {
            die: Color::Purple.die(),
            place: Placement::Purple(face(1)),
        })
        .unwrap();
        assert_eq!(game.stats().plus1_spent, 1);
        assert!(game.plus1_used().contains(Color::Purple.die()));
        assert_eq!(game.phase(), Phase::EndTurn, "the window stays open");
        // Spent: no +1 left, so only EndTurn remains.
        assert_eq!(actions(&game).as_ref(), &[Action::EndTurn]);
    }

    #[test]
    fn plus_one_flags_clear_at_the_end_of_every_active_turn() {
        let mut game = picking([1, 1, 1, 1, 1, 1]);
        game.fire(Effect::Plus1, false);
        game.fire(Effect::Plus1, false);
        game.phase = Phase::EndTurn;
        game.apply(Action::Plus1 {
            die: Color::Purple.die(),
            place: Placement::Purple(face(1)),
        })
        .unwrap();
        assert!(!game.plus1_used().is_empty());
        game.apply(Action::EndTurn).unwrap();
        assert!(
            game.plus1_used().is_empty(),
            "this game's scope is the turn"
        );
        assert_eq!(game.phase(), Phase::PassiveRoll);
    }

    #[test]
    fn plus_one_flags_clear_again_on_the_round_advance() {
        let mut game = picking([1, 1, 1, 1, 1, 1]);
        game.fire(Effect::Plus1, false);
        game.phase = Phase::PassiveEndTurn;
        game.apply(Action::Plus1 {
            die: Color::Purple.die(),
            place: Placement::Purple(face(1)),
        })
        .unwrap();
        assert!(!game.plus1_used().is_empty());
        game.apply(Action::EndTurn).unwrap();
        assert_eq!(game.round().get(), 2);
        assert!(game.plus1_used().is_empty());
    }

    // -- scoring -------------------------------------------------------------

    #[test]
    fn scoring_matches_the_rulebook_tables() {
        let mut game = PrettyClever::new(&mut rng(11));
        game.sheet = Sheet::from_areas(
            Yellow::from_bits(u16::MAX),
            Blue::from_bits(0b0000_0001_1111),
            Green::from_crossed(7),
            Orange::from_faces(&[face(3), face(5), face(2), face(4)]),
            Purple::from_faces(&[face(2), face(4), face(6), face(1)]),
        );
        game.foxes = 3;
        let b = game.score();
        assert_eq!(b.area(Sheet::YELLOW), Some(60));
        assert_eq!(b.area(Sheet::BLUE), Some(11));
        assert_eq!(b.area(Sheet::GREEN), Some(28));
        assert_eq!(b.area(Sheet::ORANGE), Some(18));
        assert_eq!(b.area(Sheet::PURPLE), Some(13));
        assert_eq!(b.min_area, 11);
        assert_eq!(b.fox_points, 33);
        assert_eq!(b.total, 60 + 11 + 28 + 18 + 13 + 33);
    }

    #[test]
    fn foxes_are_worthless_while_an_area_is_empty() {
        let mut game = PrettyClever::new(&mut rng(12));
        game.foxes = 5;
        assert_eq!(game.score().fox_points, 0);
    }

    // -- the contract --------------------------------------------------------

    #[test]
    fn an_action_that_was_never_offered_is_rejected() {
        let mut game = picking([1, 1, 1, 1, 1, 1]);
        // Green's first cell wants a 1, so a *yellow* 1 cannot go there.
        assert_eq!(
            game.apply(Action::Plus1 {
                die: Color::Green.die(),
                place: Placement::Green,
            }),
            Err(Error::Illegal),
            "no +1 is banked"
        );
        assert_eq!(
            game.apply(Action::Bonus(BonusPick::Black(BlackOption::Blue))),
            Err(Error::NotADecision)
        );
        assert_eq!(game.apply(Action::PassiveSkip), Err(Error::Illegal));
    }

    #[test]
    fn rolling_at_a_decision_node_changes_nothing() {
        let game = picking([1, 2, 3, 4, 5, 6]);
        let mut same = game.clone();
        // Debug builds assert; this is the release contract.
        if !cfg!(debug_assertions) {
            same.roll_dice(&mut rng(13));
            assert_eq!(same, game);
        }
    }

    #[test]
    fn the_game_ends_after_the_passive_turn_of_round_six() {
        let mut game = PrettyClever::new(&mut rng(14));
        game.round = Round::new(6).unwrap();
        game.phase = Phase::PassiveEndTurn;
        game.apply(Action::EndTurn).unwrap();
        assert_eq!(game.phase(), Phase::Over);
        assert!(game.node().is_over());
        assert_eq!(game.apply(Action::EndTurn), Err(Error::Illegal));
    }
}
